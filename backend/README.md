# backend/

Flask REST + SocketIO API that drives the RELION pipeline from the web UI.

## Quick local run (for development)

```bash
python3 -m venv venv
venv/bin/pip install -r requirements.txt
venv/bin/python app.py
```

Listens on `http://0.0.0.0:5000`. Point the [frontend dev server](../frontend/README.md) at it.

## Production install

You don't run this as a persistent service in the OOD Interactive App setup — the launcher starts gunicorn on a compute node per session. See [../docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md).

## Configuration

All settings are env-var-first, `config.json`-fallback. See [../docs/CONFIGURATION.md](../docs/CONFIGURATION.md) for the full reference.

Two example configs ship here:

- `config.example.json` — plain Slurm cluster
- `config.example.cyclecloud.json` — dual-filesystem CycleCloud reference

Copy the one you need to `config.json` and edit.

## Key files

| File | What it does |
|---|---|
| `app.py` | Flask + SocketIO REST routes (`/api/projects`, `/api/pipeline`, `/api/jobs/*`, `/api/files/*`, …) |
| `job_manager.py` | Builds `relion_*` commands, writes `run.sh`/`submit.sh`, submits via sbatch (or subprocess for LOCAL_JOBS) |
| `config.py` | Config loader with env-var-first pattern and `is_cyclecloud()` gate |
| `star_parser.py` | RELION STAR-format parser |
| `viz_utils.py` | MRC volume visualization helpers |
| `requirements.txt` | Python deps (flask, flask-cors, flask-socketio, eventlet, watchdog, psutil, numpy, mrcfile, Pillow, gunicorn) |
| `run.sh` | Convenience launcher: creates venv, installs deps, starts app.py |

## API surface (headlines)

- `GET /api/pipeline` — full pipeline state (jobs + edges)
- `POST /api/jobs/submit` — new job with type + params
- `GET /api/jobs/template/<type>` — form schema for a job type
- `GET /api/files/list?path=...` — file browser
- `GET /api/star/parse?path=...` — parse STAR file
- `GET /api/projects` — list discovered projects (from `project_base_dir` + `additional_project_dirs`)
- SocketIO: `pipeline_update`, `process_status_change`
