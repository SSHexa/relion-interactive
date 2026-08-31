# Quickstart — 15 minutes to first launch

For an admin on an existing Open OnDemand + Slurm cluster. Assumes you have `sudo` on the OOD host and can SSH to at least one compute node to verify things.

## What you'll do

1. Get RELION into a container the compute nodes can execute
2. Copy the backend + built frontend to a shared filesystem
3. Install the OOD Interactive App package
4. Write one env file
5. Have a user click "Launch" from their OOD dashboard

## 1. Get a RELION container

Easiest: pull a pre-built image. Or build one from the [RELION 5 Dockerfile](https://github.com/3dem/relion) and convert with `apptainer build`. Verify:

```bash
apptainer exec /path/to/relion.sif /usr/local/bin/relion --version
# Should print: RELION version: 5.0.x
```

Put the `.sif` file somewhere every compute node can read — e.g. `/opt/relion5/relion.sif` or on your shared filesystem.

## 2. Build the frontend

On any machine with Node ≥ 18 (does not have to be your OOD host):

```bash
git clone https://github.com/<your-org>/relion5-ood-interactive.git
cd relion5-ood-interactive/frontend
npm ci
npm run build
```

Output lands in `frontend/build/` — that's what OOD will serve.

## 3. Deploy backend + frontend to compute-node-visible paths

The backend + frontend need to live where **compute nodes** (not just the OOD host) can read them. Typical choices:
- `/opt/relion5/...` on every node (if you have config management)
- `/home/shared/relion5/...` on your NFS or Lustre
- `/apps/relion5/...` on a module system

For this quickstart we'll use `/opt/relion5/`:

```bash
sudo mkdir -p /opt/relion5
sudo cp -r backend /opt/relion5/backend
sudo cp -r frontend/build /opt/relion5/frontend

# Backend deps into a venv that lives with the backend
sudo python3 -m venv /opt/relion5/backend/venv
sudo /opt/relion5/backend/venv/bin/pip install -r /opt/relion5/backend/requirements.txt
```

## 4. Install the OOD Interactive App

```bash
sudo cp -r ood-app /var/www/ood/apps/sys/relion5_webui
```

Then copy the example env file and edit it for your site:

```bash
sudo mkdir -p /etc/ood/config/apps/relion5_webui
sudo cp ood-app/template/env.example /etc/ood/config/apps/relion5_webui/env
sudo vim /etc/ood/config/apps/relion5_webui/env
```

**Minimum you must set** in that env file:

```bash
RELION_CLUSTER=slurm            # the id under /etc/ood/config/clusters.d/
RELION_PARTITION=compute        # your Slurm partition for the IA job itself
RELION_BACKEND_DIR=/opt/relion5/backend
RELION_FRONTEND_DIR=/opt/relion5/frontend
RELION_CONTAINER=/opt/relion5/relion.sif
RELION_CONTAINER_BIND=/home:/home   # or wherever user data lives
```

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the full option list.

## 5. Test it

- Refresh your OOD dashboard. Under **Interactive Apps** there should be "RELION 5 Web UI".
- Click it, fill in project dir, click **Launch**.
- Wait for the job to start (should be a few seconds on a warm cluster; 5–10 min if your partition needs a cold-boot node).
- Click **Connect to RELION 5 Web UI**. Your browser opens the UI. Create a project, add a job, submit.

## When it doesn't work first try

Check the OOD session card for a job dir. Inside it:
- `output.log` — the launch script's own log
- `gunicorn.log` — the backend's log

Both are the fastest diagnostics. Common failures and fixes are in [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

If your cluster has an unusual filesystem shape (compute nodes see different paths than the OOD host), read [docs/CYCLECLOUD.md](docs/CYCLECLOUD.md) — the pattern extends beyond just Azure.
