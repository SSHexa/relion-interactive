# Troubleshooting

Real-world failures we've hit, and how to diagnose them. Ordered roughly by frequency.

## First stop for any failing session

Every OOD session has a job dir at `~/ondemand/data/sys/dashboard/batch_connect/sys/relion5_webui/output/<uuid>/`. Inside:

- **`output.log`** — the launch script's own stdout/stderr. Read this first.
- **`gunicorn.log`** — the backend's access + error log. Read this second.
- **`connection.yml`** — appears only if the launch got far enough. Contains the port OOD proxies to.

If neither log exists, the launch didn't get past sanity checks — check `output.log` for the "ERROR: xxx not found at yyy" line.

---

## Symptoms

### 1. Session says "Queued" forever

Slurm hasn't scheduled the job. Check with `squeue -u $USER`. Common causes:

- **Partition doesn't exist** — `sinfo -p <RELION_PARTITION>`.
- **No accounts allowed on partition** — talk to your Slurm admin.
- **Cold-boot cloud nodes** (CycleCloud, ParallelCluster) — expect 5–10 min while the VM boots. `squeue -j <id>` will show state `CF` (CONFIGURING).
- **QoS limits hit** — check `sacctmgr` for user's association.

### 2. Session goes "Failed" seconds after launch

Script.sh.erb failed a sanity check. `cat output.log`:

- `ERROR: RELION container not found at /opt/relion5/relion.sif` → set `RELION_CONTAINER` in the app env file.
- `ERROR: backend not found at /opt/relion5/backend` → set `RELION_BACKEND_DIR`, or copy backend to that path.
- `ERROR: frontend build not found at /opt/relion5/frontend` → run `npm run build` and copy `build/` there.
- `ERROR: neither apptainer nor singularity found on PATH` → install one on the compute nodes.
- `ERROR: no python3 with flask+gunicorn found` → run `pip install -r backend/requirements.txt` into a venv the compute nodes can read.

### 3. Session says "Running" but Connect button 502s

Backend gunicorn started but crashed. Read `gunicorn.log`. Look for the last Python traceback.

- **`ModuleNotFoundError: flask`** — wrong Python got picked. Ensure the venv path in `RELION_BACKEND_DIR/venv/bin/python3` has flask installed, or move it earlier in the search order.
- **`FileNotFoundError: config.json`** — expected only if the file exists but is malformed. Delete or fix it; env-var-only mode is supported.
- **Permission denied writing state files** — the process user needs write access to the project dir.

### 4. Connect works, UI loads, but every API call returns 500

Backend running but crashing on requests. Check `gunicorn.log` for the request that failed + the traceback.

Common: **`PermissionError` on mkdir/symlink** — user can't write to the project directory. Either fix ownership (`chown`) or point them at a project dir they own.

### 5. Connect works, UI loads, static assets 404

- **URL missing trailing slash** — `homepage: "."` makes asset paths resolve relative to the current URL. If you're at `/rnode/host/port` (no slash), assets 404. Enforce a 301 redirect at the reverse proxy:

  ```apache
  RedirectMatch permanent "^(/rnode/[^/]+/[0-9]+)$" "$1/"
  ```

- **`frontend/` copy missing files** — verify `frontend/build/static/` contains `css/` and `js/` subdirs. If not, rebuild.

### 6. Job submits, runs on compute, exits with "no input movies"

The RELION Import job produced a `movies.star` with only the optics header — zero movie entries. Almost always a container bind problem:

- User's movies live at a path not in `RELION_CONTAINER_BIND`.
- Verify by SSH'ing to the compute node and running the exact `singularity exec --bind ... ls /path/to/movies/*.tiff` — if that fails, add the missing bind path to `RELION_CONTAINER_BIND` (comma-separated).

### 7. Job fails with `FileExistsError` on symlink

Rare, but has happened: RELION reuses a project dir that has stale symlinks from a prior attempt. The code checks `is_symlink() + os.readlink() == desired_target` before creating, so this should only bite if the target changed. Fix: delete the stale symlink manually, resubmit.

### 8. `movies.star` has entries but MotionCorr says "Cannot read file external_Movies/...tiff"

Symlink `external_Movies` points to a path not visible from inside the container. Typical cause: symlink target uses `/sched-shared/...` but container only binds `/shared:/shared`. Fix: add `--bind /sched-shared:/sched-shared` — automatic when `cluster_mode="cyclecloud"`.

---

## CycleCloud-specific issues

### NFS server not enabled at boot

After OOD host reboots (auto-shutdown / auto-start on cloud VMs), if `nfs-server` isn't enabled, compute nodes can't mount `/sched-shared` and hang in CONFIGURING forever. Fix once:

```bash
ssh <ood-host> "sudo systemctl enable --now nfs-server"
```

### Apache down after boot

Similar story. Enable at boot:

```bash
ssh <ood-host> "sudo systemctl enable apache2"
```

If already enabled but not started this boot: `systemctl start apache2`.

### Stale `/run/nologin` blocking SSH

Usually cleared by `systemd-user-sessions.service` after boot. If SSH refuses with "System is booting up," and `uptime` shows the host has been up for a while, someone forgot to remove it: `sudo rm /run/nologin`.

### `PermissionError` on writes to `/sched-shared/...`

UID mismatch between OOD-side and compute-side. Add subnet-specific `all_squash + anonuid=<owner_uid>` to `/etc/exports`. See [CYCLECLOUD.md](CYCLECLOUD.md).

---

## Diagnostic commands cheat sheet

```bash
# See recent Slurm activity
sacct -u $USER --starttime=now-6hours --format=JobID,JobName%30,State,Elapsed,End

# Test container works
apptainer exec -B /home:/home $RELION_CONTAINER relion --version

# See what run.sh actually contains for a specific job
cat /path/to/project/JobType/job00N/run.sh

# Check backend imported correctly
$RELION_BACKEND_DIR/venv/bin/python3 -c "import app; print('ok')"

# Verify NFS exports on OOD (cyclecloud mode)
sudo exportfs -v

# Verify NFS is mounted on compute node (cyclecloud mode)
ssh <compute-node> "mountpoint /sched-shared && ls /sched-shared/"
```
