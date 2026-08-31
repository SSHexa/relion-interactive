# CycleCloud / Dual-Filesystem Mode

**TL;DR:** You almost certainly don't need this. Only enable `cluster_mode: "cyclecloud"` if your OOD host and your compute nodes see **different** shared filesystems.

## When to use `cyclecloud` mode

Use it if all of the following are true:

- OOD host has its own `/shared` (or `/home`) filesystem — user projects live here.
- Compute nodes have a **different** `/shared` — smaller, faster, provisioned by the scheduler (e.g. Azure CycleCloud, AWS ParallelCluster, similar).
- To let compute nodes access user data, you NFS-mount OOD's `/shared` onto compute nodes at `/sched-shared`.
- The user account has different UIDs on OOD-side vs scheduler-side.

If none of that applies, keep `cluster_mode: "generic"` and stop reading.

## What "cyclecloud" mode changes

### 1. Extra bind mount

Every Singularity call adds `--bind /sched-shared:/sched-shared`, not just `--bind /shared:/shared`. Without this, RELION jobs inside the container can't see user project data.

### 2. Per-job NFS mount stanza

Each `submit.sh` gets a preamble that ensures `/sched-shared` is mounted on the compute node before the job runs. On CycleCloud, compute nodes are ephemeral (deallocated when idle) so this mount must be re-established at the start of every job.

The stanza needs to know where to NFS-mount from — this is the `ood_nfs_server` config field (or `RELION_OOD_NFS_SERVER` env var). **Required** when in cyclecloud mode.

### 3. SSH-based project prep

Before submission, `_prepare_cc_project_dir()` runs over SSH to a separate scheduler VM (usually the CycleCloud head node). This is because:

- The OOD-side user (say UID 1000) doesn't exist on the scheduler side (where they might be UID 20001).
- Writes over NFS with UID mismatch get denied.
- The scheduler-side user *does* own the compute-side `/shared`, so it can create the necessary project mirror + symlinks.

Config: `cc_scheduler_host` + `cc_scheduler_user`.

### 4. Symlink target rewriting

RELION creates symlinks for imported movies with absolute paths (`/shared/home/.../Movies`). On the compute node, those need to be `/sched-shared/home/.../Movies` to resolve. The `_prepare_cc_project_dir()` step rewrites them.

### 5. NFS UID squash (site infra, not code)

For OOD's NFS export to let compute-side writes succeed as the correct OOD-side user, admins typically add a subnet-specific `all_squash + anonuid=1000` export rule. This isn't done by this codebase — see below.

## Config

Use `backend/config.example.cyclecloud.json` as the starting point:

```json
{
  "cluster_mode": "cyclecloud",
  "container_bind": "/shared:/shared",
  "cc_scheduler_host": "scheduler.example.internal",
  "cc_scheduler_user": "clusteruser",
  "ood_nfs_server": "ood.example.internal",
  "sbatch_command": "/etc/ood/config/clusters.d/slurm_ccw/bin_overrides/sbatch.sh",
  "squeue_command": "/etc/ood/config/clusters.d/slurm_ccw/bin_overrides/squeue.sh",
  "scancel_command": "/etc/ood/config/clusters.d/slurm_ccw/bin_overrides/scancel.sh"
}
```

## Infrastructure you'll need alongside

### NFS export on OOD

```
# /etc/exports on OOD host
/shared <compute-subnet>/24(rw,sync,no_subtree_check,all_squash,anonuid=1000,anongid=1000)
/shared *(rw,sync,no_subtree_check,no_root_squash)
```

The subnet-specific rule with `all_squash + anonuid` maps all compute-side UIDs down to your OOD-side owner account (e.g. UID 1000). Without this, compute-side writes to `/sched-shared/...` get EACCES because they arrive as the wrong UID.

Enable at boot:
```
sudo systemctl enable --now nfs-server
```

### sbatch proxy scripts

If the OOD host doesn't run Slurm itself and instead forwards to a separate scheduler VM, install thin wrapper scripts under `/etc/ood/config/clusters.d/<id>/bin_overrides/` that SSH the command through. Reference them from the `sbatch_command` / `squeue_command` / `scancel_command` config fields.

### Container image on scheduler-side `/shared`

Compute nodes see the scheduler-side `/shared`. The RELION container image must live there. Common pattern: symlink `/shared/apps/relion/backup/relion.sif` on the scheduler side to whatever path config points at.

### Apptainer install on cold-boot nodes

CycleCloud spot nodes may not have apptainer pre-installed. The generated `submit.sh` includes a stanza that installs it from a `.deb` on shared storage if missing. See the `nfs_setup` block in `job_manager.py`.

## Why the code lives inside `job_manager.py` and not a plugin

Currently: inline conditionals. `is_cyclecloud()` checks appear in ~5 places. Every dual-FS behavior is gated by them, so generic-mode users are unaffected.

Refactoring to a plugin architecture (subclasses of a `ClusterBackend` base) is on the roadmap but not yet done. Contributions welcome.

## Troubleshooting

**Symptom:** `PermissionError: '/sched-shared/home/.../job005'` on submission.
**Cause:** NFS squash not configured or wrong UID.
**Fix:** Verify `/etc/exports` has the `all_squash + anonuid=<OOD-side owner UID>` rule for the compute subnet, and `exportfs -ra` was run.

**Symptom:** Import job writes `movies.star` with only optics header (zero entries).
**Cause:** Container missing `--bind /sched-shared:/sched-shared`, so the glob inside the container matches nothing.
**Fix:** Verify `cluster_mode="cyclecloud"` in config (that adds the bind automatically). Check the generated `run.sh` for both bind flags.

**Symptom:** Job stuck in `CONFIGURING` for >15 min.
**Cause:** Compute node can't mount NFS from OOD host — usually `nfs-server` isn't running.
**Fix:** `ssh <ood-host> "sudo systemctl start nfs-server"` and enable it at boot.

**Symptom:** Symlink to imported data resolves inside container but file appears missing.
**Cause:** Symlink target uses an absolute path that's only valid on OOD-side (e.g. `/shared/home/...`), not compute-side (`/sched-shared/home/...`).
**Fix:** `_prepare_cc_project_dir()` rewrites these at submission time — check its output. If it didn't run, verify `cc_scheduler_host` is set.
