"""Snapshot harness for JobManager.submit_job command-list generation.

Goal: prove that the per-job-type refactor in Phase 2B produces a
byte-identical RELION command line for every job type. The test stubs
out filesystem and subprocess side effects so we can repeatedly call
submit_job() in-process and compare its captured `cmd` list.

Usage:
    python3 snapshot_submit_job.py capture > /tmp/before.txt
    # ... do refactor ...
    python3 snapshot_submit_job.py capture > /tmp/after.txt
    diff /tmp/before.txt /tmp/after.txt   # must be empty

The harness intentionally does NOT exercise:
  - _prepare_cc_project_dir (CC SSH side effects)
  - _submit_to_slurm (sbatch invocation)
  - _create_slurm_script (file I/O — exercised separately if needed)

It DOES capture the `cmd` list passed into _create_slurm_script /
_run_local. That list is the ground truth — everything downstream
of it is template-only and won't change.
"""
from __future__ import annotations

import os
import sys
import json
import shutil
import tempfile
import unittest.mock as mock
from pathlib import Path
from typing import Any, Dict, List

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def _capture_cmd_for_job(job_type: str, params: Dict[str, Any], project_dir: Path) -> List[str]:
    """Run submit_job in a sandboxed JobManager and return the cmd list."""
    from job_manager import JobManager  # noqa: E402

    captured: Dict[str, Any] = {}

    def fake_create_slurm_script(self, job_dir, cmd, job_name, *args, **kwargs):
        captured['cmd'] = list(cmd)
        captured['job_dir'] = str(job_dir)
        captured['job_name'] = job_name
        captured['kwargs'] = kwargs
        # Return a dummy script path; submit-to-slurm is also stubbed
        return Path(job_dir) / 'submit.sh'

    def fake_submit_to_slurm(self, script_path, job_name):
        return ('STUB_JOBID', None)

    def fake_run_local(self, job_dir, cmd, job_name):
        captured['cmd'] = list(cmd)
        captured['job_dir'] = str(job_dir)
        captured['job_name'] = job_name
        captured['local'] = True
        return {'success': True, 'jobId': job_name}

    def fake_prepare_cc(self, job_name):
        return True

    def fake_is_cyclecloud(self):
        return False  # Avoid the CC prep path for snapshot determinism

    with mock.patch.object(JobManager, '_create_slurm_script', new=fake_create_slurm_script), \
         mock.patch.object(JobManager, '_submit_to_slurm', new=fake_submit_to_slurm), \
         mock.patch.object(JobManager, '_run_local', new=fake_run_local), \
         mock.patch.object(JobManager, '_prepare_cc_project_dir', new=fake_prepare_cc), \
         mock.patch.object(JobManager, '_is_cyclecloud', new=fake_is_cyclecloud):
        jm = JobManager(str(project_dir))
        try:
            jm.submit_job(job_type, params, mode='new')
        except Exception as e:
            captured['error'] = f'{type(e).__name__}: {e}'

    return captured


# Representative param fixtures per job type. Values chosen to exercise
# every per-job-type branch in submit_job — the goal isn't to match real
# scientific defaults, just to make the cmd list non-trivial and stable.
FIXTURES: Dict[str, Dict[str, Any]] = {
    'Import': {
        'fn_in_raw': '/external/data/Movies/*.tiff',
        'is_raw_movies': True,
        'angpix': 1.0,
        'kV': 300,
        'Cs': 2.7,
        'Q0': 0.1,
        '_nrMpi': 1,
        '_nrThreads': 1,
    },
    'MotionCorr': {
        'input_star_mics': 'Import/job001/movies.star',
        'do_own': 'RELION',
        'angpix': 1.0,
        '_nrMpi': 3,
        '_nrThreads': 4,
    },
    'CtfFind': {
        'fn_in': 'MotionCorr/job002/corrected_micrographs.star',
        'resmin': 30,
        'resmax': 5,
        'dfmin': 5000,
        'dfmax': 50000,
        'dfstep': 100,
        'box': 512,
        '_nrMpi': 3,
        '_nrThreads': 1,
    },
    'AutoPick': {
        'fn_in': 'CtfFind/job003/micrographs_ctf.star',
        'particle_diameter': 200,
        'threshold_pick': 0.05,
        'min_particle_distance': 100,
        '_nrMpi': 1,
        '_nrThreads': 4,
    },
    'Extract': {
        'fn_in': 'AutoPick/job004/coords_suffix_autopick.star',
        'extract_size': 256,
        'rescale': 64,
        'do_norm': True,
        'bg_radius': 30,
        '_nrMpi': 3,
        '_nrThreads': 1,
    },
    'Class2D': {
        'fn_in': 'Extract/job005/particles.star',
        'nr_classes': 50,
        'nr_iter': 25,
        'particle_diameter': 200,
        'use_gpu': True,
        'gpu_ids': '0,1',
        '_nrMpi': 3,
        '_nrThreads': 4,
    },
    'Class3D': {
        'fn_in': 'Extract/job005/particles.star',
        'fn_ref': 'InitialModel/job015/initial_model.mrc',
        'nr_classes': 4,
        'nr_iter': 25,
        'particle_diameter': 200,
        'use_gpu': True,
        'gpu_ids': '0',
        '_nrMpi': 3,
        '_nrThreads': 4,
    },
    'InitialModel': {
        'fn_in': 'Extract/job005/particles.star',
        'particle_diameter': 200,
        'use_gpu': True,
        'gpu_ids': '0',
        '_nrMpi': 1,
        '_nrThreads': 4,
    },
    'Refine3D': {
        'fn_in': 'Extract/job005/particles.star',
        'fn_ref': 'InitialModel/job015/initial_model.mrc',
        'particle_diameter': 200,
        'use_gpu': True,
        'gpu_ids': '0',
        '_nrMpi': 3,
        '_nrThreads': 4,
    },
    'PostProcess': {
        'fn_in': 'Refine3D/job020/run',
        'fn_mask': 'MaskCreate/job019/mask.mrc',
        'angpix': 1.0,
        'adhoc_bfac': -50,
        '_nrMpi': 1,
        '_nrThreads': 1,
    },
    'MaskCreate': {
        'fn_in': 'Refine3D/job020/run_class001.mrc',
        'ini_threshold': 0.01,
        'extend_inimask': 3,
        'width_soft_edge': 6,
        '_nrMpi': 1,
        '_nrThreads': 1,
    },
    'CtfRefine': {
        'fn_data': 'Refine3D/job020/run_data.star',
        'fn_post': 'PostProcess/job021/postprocess.star',
        'do_aniso_mag': True,
        'do_beamtilt': True,
        '_nrMpi': 3,
        '_nrThreads': 4,
    },
    'MotionRefine': {
        'fn_in': 'Refine3D/job020/run_data.star',
        'corr_mic': 'MotionCorr/job002/',
        'angpix': 1.0,
        '_nrMpi': 3,
        '_nrThreads': 4,
    },
    'ClassSelect': {
        'fn_data': 'Class2D/job006/run_it025_optimiser.star',
        'select_label': 'rlnClassDistribution',
        'select_minval': 0.01,
        '_nrMpi': 1,
        '_nrThreads': 1,
    },
    'JoinStar': {
        'fn_in': 'AutoPick/job010/coords.star',
        '_nrMpi': 1,
        '_nrThreads': 1,
    },
    'LocalRes': {
        'fn_in': 'Refine3D/job020/run_class001.mrc',
        'fn_mask': 'MaskCreate/job019/mask.mrc',
        'angpix': 1.0,
        '_nrMpi': 1,
        '_nrThreads': 1,
    },
}


def capture_all() -> Dict[str, Any]:
    """Run every fixture and return a deterministic dict for diffing."""
    tmp = Path(tempfile.mkdtemp(prefix='snapshot_'))
    try:
        # Pre-create some fake upstream job dirs so MotionRefine auto-detect works
        (tmp / 'MotionCorr' / 'job002').mkdir(parents=True, exist_ok=True)
        (tmp / 'MotionCorr' / 'job002' / 'corrected_micrographs.star').touch()

        results: Dict[str, Any] = {}
        for job_type in sorted(FIXTURES):
            params = dict(FIXTURES[job_type])
            captured = _capture_cmd_for_job(job_type, params, tmp)
            results[job_type] = captured
        return results
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _normalize(captured: Dict[str, Any]) -> Dict[str, Any]:
    """Strip volatile fields so two runs compare cleanly."""
    out = {}
    for job_type, cap in captured.items():
        if 'cmd' not in cap:
            out[job_type] = {'error': cap.get('error', 'no cmd captured')}
            continue
        cmd = cap['cmd']
        # Replace the temp project path with a placeholder so directories
        # don't leak into the diff
        cmd_norm = []
        job_dir = cap.get('job_dir', '')
        proj_root = str(Path(job_dir).parent.parent) if '/' in job_dir else ''
        for arg in cmd:
            if proj_root and proj_root in arg:
                arg = arg.replace(proj_root, '<PROJECT>')
            cmd_norm.append(arg)
        out[job_type] = {
            'cmd': cmd_norm,
            'kwargs': cap.get('kwargs', {}),
            'local': cap.get('local', False),
            'job_name': cap.get('job_name', ''),
        }
    return out


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'capture'
    if cmd == 'capture':
        results = _normalize(capture_all())
        print(json.dumps(results, indent=2, sort_keys=True, default=str))
    else:
        print(f"unknown command: {cmd}", file=sys.stderr)
        sys.exit(2)
