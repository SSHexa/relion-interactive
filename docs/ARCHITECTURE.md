# Architecture

## The 30-second version

```
                            OOD host
   User's browser  ─────► ┌─────────────────────────┐
                          │  Apache/OOD reverse-    │
                          │  proxies /rnode/<node>/ │
                          │  <port>/  to the compute│
                          │  node the session is on │
                          └───────────┬─────────────┘
                                      │
                             ┌────────▼────────────────────────┐
                             │ Compute node (Slurm job)        │
                             │                                  │
                             │  gunicorn ──► WSGI wrapper       │
                             │    ├── /api/*     → Flask app.py │
                             │    └── everything else → static  │
                             │                    frontend/     │
                             │                                  │
                             │  Flask → job_manager → sbatch    │
                             │            (or subprocess for    │
                             │             LOCAL_JOBS)          │
                             │                                  │
                             │  RELION binaries run inside      │
                             │  Singularity/Apptainer container │
                             └──────────────────────────────────┘
```

**One Slurm job hosts everything.** No separate backend service running on the OOD host. The compute node the IA lands on runs both the API and serves the built React SPA.

## Components

### `ood-app/` — the Interactive App package

Standard OOD `batch_connect` app.

- **`manifest.yml`** — app metadata (name, category)
- **`form.yml`** — form fields shown when user clicks Launch
- **`submit.yml.erb`** — Slurm submission options (partition, walltime, memory)
- **`view.html.erb`** — one-line HTML that redirects to the running UI
- **`template/script.sh.erb`** — the launch script; sourced by OOD's `basic` batch_connect template

The script.sh.erb workflow:

1. `cd` into the user's working directory
2. Verify container + backend + frontend paths exist (fail loudly if not)
3. Locate `apptainer`/`singularity`
4. Generate wrapper scripts in `${SESSION_DIR}/bin/` for every RELION binary — each wrapper `exec`s the container transparently
5. Set env vars (`RELION_BIN_PATH`, `RELION_CTFFIND_EXECUTABLE`, etc.) so job_manager finds those wrappers
6. Pick a Python that has flask+gunicorn (venv → user site → system)
7. Write a small WSGI wrapper that serves `/api/*` from Flask and everything else from `frontend/`
8. Start gunicorn, wait for it to answer, then `wait` — Slurm holds the node open for `walltime`

### `backend/` — Flask + orchestration

- **`app.py`** — REST + SocketIO routes: `/api/projects`, `/api/pipeline`, `/api/jobs/*`, `/api/files/*`, etc.
- **`job_manager.py`** — the workhorse:
  - Builds `relion_*` CLI commands from user params
  - Writes `run.sh` and `submit.sh` scripts per job
  - Submits via `sbatch` (or subprocess for `LOCAL_JOBS` like Import)
  - Reads STAR outputs and updates pipeline state
  - Wraps every RELION call in the container with `--bind` mounts
- **`config.py`** — env-var-first config loader with `is_cyclecloud()` gate
- **`star_parser.py`** — RELION's native STAR-format parser
- **`viz_utils.py`** — MRC visualization helpers

### `frontend/` — React + MUI SPA

- Built once with `npm run build` → static files
- `homepage: "."` in `package.json` — all asset URLs are relative, so the SPA works under any URL prefix without rebuilding
- Talks to the backend at `./api/*`
- Uses `@xyflow/react` for pipeline visualization, `three` + `mrcfile` for volume viewing

## Job submission flow

```
User clicks "Submit" in the pipeline UI
        │
        ▼
POST /api/jobs/submit  {job_type: "MotionCorr", params: {...}}
        │
        ▼
job_manager.submit_job()
        │
        ├── Build relion_* command from params
        │
        ├── (Import + a few others) direct subprocess in the container
        │        → return job path immediately
        │
        └── (Everything else) write submit.sh with #SBATCH directives
                 └── sbatch  → Slurm queues → job runs on compute node
                                 └── container runs RELION binary
                                        └── writes into project dir
        │
        ▼
Periodic /api/pipeline poll picks up STAR file changes → UI updates
```

## The `cluster_mode` split

`backend/config.py:is_cyclecloud()` returns `True` when `cluster_mode="cyclecloud"`. This gates several branches in `job_manager.py`:

- Adding `--bind /sched-shared:/sched-shared` to every singularity call
- Prepending an NFS-mount + apptainer-install stanza to every `submit.sh`
- Running `_prepare_cc_project_dir()` over SSH to a separate scheduler VM before submission
- Rewriting `/shared/...` symlink targets to `/sched-shared/...` for compute-node visibility

If `cluster_mode="generic"` (the default), none of that fires. A plain university Slurm cluster just uses `sbatch` locally and container binds whatever `RELION_CONTAINER_BIND` says.

See [CYCLECLOUD.md](CYCLECLOUD.md) for when you actually need cyclecloud mode.

## Extending to a new cluster shape

The abstraction is currently **inline conditionals**, not a plugin architecture. If your cluster is neither "plain generic" nor "cyclecloud dual-FS," the honest answer is: you'll need to add a new branch and gate it with `cluster_mode="yoursite"`. Places you'd touch:

1. `config.py` — add any new config fields
2. `job_manager.py:_build_full_cmd()` (around line 680) — bind mount adjustments
3. `job_manager.py` submit_job() — pre-submission prep (like `_prepare_cc_project_dir` for CC)
4. Optionally new `_sync_job_from_cc()`-style callback if results need to be pulled back

A cleaner plugin architecture would be a great contribution. Until then, model your addition after the `cyclecloud` branches.

## Session lifecycle

```
User Launch
   │
   ▼
Slurm queues IA job, allocates node when partition has capacity
   │
   ▼
script.sh.erb runs, starts gunicorn, writes connection.yml
   │
   ▼
OOD sees connection.yml, shows Connect button
   │
   ▼
User clicks Connect → browser opens /rnode/<node>/<port>/
   │
   ▼
[user works with the pipeline for N hours]
   │
   ▼
Walltime hits, Slurm kills the job, session card marked Completed
```

The backend does **not** persist across sessions. Every new IA launch = new gunicorn = fresh state. Project data lives in the user's project directory (whatever the form field pointed at) — that persists across sessions like any other Slurm-produced output.

## What lives where — cheat sheet

| Thing | Lives on | Lifetime |
|---|---|---|
| Interactive App package | OOD host: `/var/www/ood/apps/sys/relion5_webui/` | Persistent |
| App env config | OOD host: `/etc/ood/config/apps/relion5_webui/env` | Persistent |
| Backend Python + venv | Shared FS: `/opt/relion5/backend/` | Persistent |
| Frontend build | Shared FS: `/opt/relion5/frontend/` | Persistent |
| RELION container | Shared FS: `/opt/relion5/relion.sif` | Persistent |
| Session logs | Compute node: `~/ondemand/data/sys/.../output/<uuid>/` | Until user deletes |
| Job outputs (STAR, MRC, etc.) | Wherever project dir is | Forever (user owns) |
| gunicorn process | Compute node | Duration of Slurm job |
