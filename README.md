# RELION 5 Web UI — Open OnDemand Interactive App

A browser-based interface for the [RELION 5](https://relion.readthedocs.io/) single-particle cryo-EM processing pipeline, packaged as an [Open OnDemand](https://openondemand.org/) Interactive App. Launch it from any OOD dashboard, and it allocates a compute node via Slurm, starts a Flask + React web UI on it, and gives you a "Connect" button that opens the pipeline in your browser.

**Ships with:**
- OOD Interactive App package (`ood-app/`)
- Flask backend with STAR-file parsing, job orchestration, and REST API (`backend/`)
- React + MUI + TypeScript frontend (`frontend/`)
- Example configs for both plain Slurm clusters and Azure CycleCloud-style dual-filesystem setups

## Who this is for

Any facility running Open OnDemand on a Slurm cluster who wants a web UI for RELION 5 instead of X11-forwarding the native GUI. Tested on university HPC, private lab clusters, and Azure CycleCloud.

## Quick start

```bash
# 1. Clone
git clone https://github.com/<your-org>/relion5-ood-interactive.git
cd relion5-ood-interactive

# 2. Build the frontend
cd frontend && npm ci && npm run build && cd ..

# 3. Copy the backend + frontend build to a location your compute nodes can read
sudo cp -r backend /opt/relion5/backend
sudo cp -r frontend/build /opt/relion5/frontend

# 4. Install Python deps into a venv the compute nodes can also reach
sudo python3 -m venv /opt/relion5/backend/venv
sudo /opt/relion5/backend/venv/bin/pip install -r /opt/relion5/backend/requirements.txt

# 5. Install the OOD Interactive App
sudo cp -r ood-app /var/www/ood/apps/sys/relion5_webui

# 6. Configure — copy the example env and edit for your site
sudo mkdir -p /etc/ood/config/apps/relion5_webui
sudo cp ood-app/template/env.example /etc/ood/config/apps/relion5_webui/env
sudo vim /etc/ood/config/apps/relion5_webui/env   # set RELION_CLUSTER, RELION_CONTAINER, etc.

# 7. Users see "RELION 5 Web UI" under Interactive Apps in their OOD dashboard.
```

See [QUICKSTART.md](QUICKSTART.md) for a walked-through version, and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the full install.

## Documentation

| Doc | What it covers |
|---|---|
| [QUICKSTART.md](QUICKSTART.md) | 15-minute clone → deploy → click launch |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Full install, systemd, permissions, RELION container build |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Every `RELION_*` env var and `config.json` field |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Data-flow: React → Flask → job_manager → Slurm → RELION |
| [docs/CYCLECLOUD.md](docs/CYCLECLOUD.md) | Advanced: dual-filesystem CycleCloud setup |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common failures + fixes |

## Requirements

- Slurm cluster with at least one compute partition
- Open OnDemand ≥ 3.0 with the batch_connect app enabled
- Singularity or Apptainer on compute nodes
- A RELION 5 container image (build instructions in `docs/DEPLOYMENT.md`)
- Python 3.10+ on compute nodes
- Node.js 18+ on your build host (only needed to build the frontend once)

## License

MIT — see [LICENSE](LICENSE).

RELION itself is separately licensed (MIT); the container image you provide will contain RELION binaries under its own terms.

## Contributing

Issues and pull requests welcome. If your site has a cluster shape not covered by `cluster_mode: "generic"` or `"cyclecloud"`, that's a great place to contribute a new adapter — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
