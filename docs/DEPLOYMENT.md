# Deployment Guide

For OOD admins deploying to a real cluster. This covers the full install, not just the happy-path quickstart.

## Prerequisites

**On the OOD host:**
- Open OnDemand ≥ 3.0 with the batch_connect app enabled
- A cluster config file at `/etc/ood/config/clusters.d/<your-id>.yml`
- `sudo` for placing files in `/var/www/ood/apps/sys/` and `/etc/ood/config/apps/`

**On compute nodes:**
- Slurm compute node registered with the cluster
- Singularity ≥ 3.7 or Apptainer ≥ 1.0
- Python 3.10+ (system or virtualenv-provided)
- Network access back to the OOD host on the port range Slurm assigns

**Shared between them:**
- A filesystem visible from both OOD host and compute nodes where you install the backend + frontend. Options: NFS, Lustre, BeeGFS, GPFS, or a per-node local copy managed by config management.

## Step 1 — Prepare a RELION container

The web UI shells out to `relion_*` binaries via Singularity/Apptainer. You need one image containing:

- RELION 5 binaries at `/usr/local/bin/relion_*`
- `ctffind` at a known path (default: `/opt/ctffind/bin/ctffind`)
- `mpirun`

### Options for getting the image

**A. Pull from a registry:**

```bash
apptainer pull docker://<your-registry>/relion5:latest
```

**B. Build from source:**

Clone [RELION](https://github.com/3dem/relion), then use the provided Dockerfile or build a `.def`:

```bash
apptainer build relion.sif relion.def
```

**C. Use an existing site image** — many facilities already have a RELION container. Reuse it and adjust `RELION_CTFFIND_IN_CONTAINER` if `ctffind` lives at a non-default path.

### Verify the image

```bash
apptainer exec relion.sif /usr/local/bin/relion --version
apptainer exec relion.sif ls /opt/ctffind/bin/ctffind
apptainer exec relion.sif which mpirun
```

Place it where compute nodes can read it, e.g. `/opt/relion5/relion.sif` or `/apps/relion5/relion.sif`.

## Step 2 — Build the frontend

On any machine with Node ≥ 18:

```bash
cd frontend
npm ci
npm run build
```

You get `frontend/build/` — a static SPA. Note: `package.json` has `"homepage": "."` so all asset paths are relative — this makes the build work behind any URL prefix without rebuilding.

## Step 3 — Install backend + frontend on the shared filesystem

```bash
sudo mkdir -p /opt/relion5
sudo cp -r backend         /opt/relion5/backend
sudo cp -r frontend/build  /opt/relion5/frontend
sudo cp -r particle-picker /opt/relion5/particle-picker   # separate SPA for interactive picking

# Backend Python deps
sudo python3 -m venv /opt/relion5/backend/venv
sudo /opt/relion5/backend/venv/bin/pip install -r /opt/relion5/backend/requirements.txt
```

**About `particle-picker/`:** it's a standalone React SPA that the backend serves at `/particle-picker/` (see `app.py`, blueprint `particle_picker_api.py`). It MUST live at `../particle-picker` relative to the backend dir — the backend hardcodes `Path(__file__).parent.parent / 'particle-picker'`. If you install to a non-standard layout, symlink it into place.

The launcher script tries these Python interpreters in order:
1. `${RELION_BACKEND_DIR}/venv/bin/python3`
2. `${HOME}/.local/bin/python3`
3. System `python3`

The first one with `flask` and `gunicorn` importable wins. The venv approach is most portable.

## Step 4 — Optional: `config.json`

Instead of relying entirely on env vars, you can drop a `config.json` next to the backend:

```bash
sudo cp backend/config.example.json /opt/relion5/backend/config.json
sudo vim /opt/relion5/backend/config.json
```

For CycleCloud / dual-filesystem setups, use `config.example.cyclecloud.json` as the starting point — see [CYCLECLOUD.md](CYCLECLOUD.md).

## Step 5 — Install the OOD Interactive App

```bash
sudo cp -r ood-app /var/www/ood/apps/sys/relion5_webui
```

Now the app appears in the OOD dashboard under **Interactive Apps** → **RELION 5 Web UI**.

## Step 6 — Write the app env file

```bash
sudo mkdir -p /etc/ood/config/apps/relion5_webui
sudo cp ood-app/template/env.example /etc/ood/config/apps/relion5_webui/env
sudo chmod 644 /etc/ood/config/apps/relion5_webui/env
sudo vim /etc/ood/config/apps/relion5_webui/env
```

Full env-var reference: [CONFIGURATION.md](CONFIGURATION.md).

## Step 7 — Permissions

The Interactive App runs as the launching user (via OOD's PUN + Slurm's `SBATCH_USER`). That user needs:

- **Read** on `/opt/relion5/backend`, `/opt/relion5/frontend`, `/opt/relion5/relion.sif`
- **Read+execute** on `/opt/relion5/backend/venv/bin/python3` and its transitive files
- **Write** on their own project directories (obviously)
- **Membership in a Slurm account** allowed to submit to `RELION_PARTITION`

Container binds must include everywhere jobs will read from AND write to. Missing a bind is a common source of silent failures — see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Step 8 — Smoke test

As a normal user:

1. Log into OOD
2. **Interactive Apps** → **RELION 5 Web UI**
3. Set project dir to a real path you own, keep other defaults
4. **Launch**
5. Wait for the job to start (a few seconds warm; 5–10 min cold)
6. Click **Connect**
7. In the UI, create a project, submit an `Import` job with a movie glob, then a `MotionCorr` on that import

If the Import returns a `movies.star` with real entries and MotionCorr runs a few seconds without error, you're done.

## Optional — Systemd unit for a long-running backend

The Interactive App starts its own backend per session. If you also want a **persistent** Passenger-style backend running on the OOD host (for a lightweight non-batch entry point), the Passenger version is out of scope for this repo — but the same backend code supports it. See the [upstream fork](https://github.com/<your-org>/relion5-ood-passenger) if published.

## Upgrading

To pick up new code:

```bash
cd relion5-ood-interactive
git pull

# Rebuild frontend
cd frontend && npm ci && npm run build && cd ..

# Push updated files to the deploy target
sudo rsync -a --delete backend/ /opt/relion5/backend/     # careful — nukes local edits
sudo rsync -a --delete frontend/build/ /opt/relion5/frontend/
```

Running interactive sessions keep the code they started with. New sessions pick up the update.

## What we intentionally do NOT ship

- Cluster provisioning (that's your job — Terraform, CycleCloud, xCAT, whatever)
- Slurm accounts / QoS / fair-share setup
- User provisioning / LDAP / Dex
- Container registry
- CI/CD (though `.github/workflows/` PRs welcome)

## Uninstall

```bash
sudo rm -rf /var/www/ood/apps/sys/relion5_webui
sudo rm -rf /etc/ood/config/apps/relion5_webui
sudo rm -rf /opt/relion5
```
