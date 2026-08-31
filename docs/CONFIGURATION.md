# Configuration Reference

Every runtime value is resolved in this order (first wins):

1. **Environment variable** (e.g. `RELION_CONTAINER`)
2. **`backend/config.json`** field (e.g. `"relion_container"`)
3. **Built-in default**

`config.json` is optional. If missing, everything falls back to env-var → default.

## OOD app env vars

These are read from `/etc/ood/config/apps/relion5_webui/env` (or wherever your OOD instance keeps app envs). Consumed by `ood-app/form.yml`, `submit.yml.erb`, and `template/script.sh.erb` — NOT the Python backend.

| Env var | Default | What it does |
|---|---|---|
| `RELION_CLUSTER` | `slurm` | OOD cluster id — must match a file in `/etc/ood/config/clusters.d/<id>.yml` |
| `RELION_PARTITION` | `compute` | Slurm partition for the Interactive App job itself |
| `RELION_MEM_PER_JOB` | `12G` | Memory reservation for the IA job |
| `RELION_BACKEND_DIR` | `/opt/relion5/backend` | Path to backend source (must be readable by compute nodes) |
| `RELION_FRONTEND_DIR` | `/opt/relion5/frontend` | Path to built React frontend |
| `RELION_CONTAINER` | `/opt/relion5/relion.sif` | Singularity/Apptainer image with RELION binaries |
| `RELION_CTFFIND_IN_CONTAINER` | `/opt/ctffind/bin/ctffind` | Path to `ctffind` **inside** the container |
| `RELION_CONTAINER_BIND` | `/home:/home` | Comma-separated `HOST:CONTAINER` bind mounts |
| `RELION_DEFAULT_PROJECTS_DIR` | `${HOME}/relion_projects` | Default value in the "Project Directory" form field |
| `RELION_CLUSTER_MODE` | `generic` | Set to `cyclecloud` only for dual-FS setups (see [CYCLECLOUD.md](CYCLECLOUD.md)) |
| `RELION_HIDDEN_PROJECTS` | (empty) | Comma-separated project names to hide from the UI (e.g. tutorials) |

## Backend env vars

Read at Python-process startup. These also correspond to `config.json` fields.

### Core

| Env var | JSON field | Default | What it does |
|---|---|---|---|
| `RELION_CONFIG_FILE` | — | `backend/config.json` | Alternate path to load `config.json` from |
| `RELION_BIN_PATH` | `relion_bin_path` | `/opt/relion/bin` | Where `relion_*` binaries live (usually inside container) |
| `RELION_CONTAINER` | `relion_container` | (empty = no container) | Path to Singularity image |
| `RELION_APPTAINER_BIN` | `singularity_bin` | `/usr/bin/singularity` | Path to `singularity` or `apptainer` |
| `RELION_CONTAINER_BIND` | `container_bind` | `/shared:/shared` | Comma-separated bind mounts |
| `RELION_CTFFIND_BIN` | `ctffind_executable` | `/usr/local/bin/ctffind` | `ctffind` path (inside container) |
| `RELION_MPIRUN` | `mpi_run` | `mpirun` | MPI launcher |
| `RELION_DYNAMIGHT_BIN` | `dynamight_bin_path` | (empty) | Path to DynaMight binaries (optional) |
| `RELION_PARTITION` | `slurm_partition` | `local` | Default Slurm partition for RELION jobs (can be overridden per-job) |

### Cluster mode & Slurm

| Env var | JSON field | Default | What it does |
|---|---|---|---|
| `RELION_CLUSTER_MODE` | `cluster_mode` | `generic` | `generic` or `cyclecloud`. Gates dual-FS behavior. |
| `RELION_EXECUTION_MODE` | `execution_mode` | `slurm` | `slurm` (submit via sbatch) or `local` (subprocess). |
| `RELION_SBATCH_PROXY` | `sbatch_command` | (unset = use `sbatch`) | Path to a script that forwards sbatch over SSH |
| `RELION_SQUEUE_PROXY` | `squeue_command` | (unset = use `squeue`) | Same, for squeue |
| `RELION_SCANCEL_PROXY` | `scancel_command` | (unset = use `scancel`) | Same, for scancel |

### CycleCloud-only (only when `cluster_mode="cyclecloud"`)

| Env var | JSON field | Default | What it does |
|---|---|---|---|
| `RELION_CC_HOST` | `cc_scheduler_host` | (none) | SSH target for scheduler VM |
| `RELION_CC_USER` | `cc_scheduler_user` | (empty) | SSH user for scheduler |
| `RELION_OOD_NFS_SERVER` | `ood_nfs_server` | (none — REQUIRED) | Address compute nodes NFS-mount OOD's `/shared` from |

See [CYCLECLOUD.md](CYCLECLOUD.md) for the full context.

### Projects & UI

| Env var | JSON field | Default | What it does |
|---|---|---|---|
| `RELION_DEFAULT_PROJECTS_DIR` | `project_base_dir` | `os.getcwd()` | Primary directory scanned for RELION projects. Supports `${HOME}`, `${USER}`, `~`. |
| `RELION_ADDITIONAL_PROJECT_DIRS` | `additional_project_dirs` | `[]` | Comma-separated extra project dirs to scan. Empty string explicitly disables. |
| `RELION_HIDDEN_PROJECTS` | — | (empty) | Comma-separated project names to hide (e.g. `relion30_tutorial,demo`) |
| `RELION_CORS_ORIGINS` | `cors_origins` | `*` | Comma-separated Origin allowlist. `*` is safe when backend is behind OOD's reverse proxy. |

### Server

| Env var | JSON field | Default | What it does |
|---|---|---|---|
| `RELION_HOST` | `host` | `0.0.0.0` | Bind address |
| `RELION_BACKEND_PORT` | `port` | `5000` | Bind port (Interactive App overrides via `RELION_API_PORT`) |
| `RELION_DEBUG` | `debug` | `false` | Flask debug mode |
| `RELION_ENVIRONMENT` | `environment` | `development` | Cosmetic tag (`production` disables some noisy logs) |
| `RELION_AUTH_MODE` | `auth_mode` | `passthrough` | `passthrough` trusts the reverse proxy (default & correct for OOD). `basic`/`none` are for other deployments. |
| `RELION_DEPLOYMENT_MODE` | `deployment_mode` | `ood` | `ood`, `headless`, or `local`. Affects some UI feature toggles. |

## `${VAR}` expansion in `config.json`

`project_base_dir` and `additional_project_dirs` support shell-style variable expansion at request time. Example:

```json
{
  "project_base_dir": "${HOME}/relion_projects",
  "additional_project_dirs": ["/scratch/${USER}/relion"]
}
```

Each user sees their own resolved paths — you don't need per-user config files.

## Example configs

Two starter files ship in `backend/`:

- **`config.example.json`** — plain single-filesystem Slurm cluster
- **`config.example.cyclecloud.json`** — dual-filesystem CycleCloud reference

Copy one to `backend/config.json` and edit.
