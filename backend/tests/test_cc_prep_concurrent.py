"""Regression test for FIX_LOG #83: concurrent CC prep must not clobber inflight jobs.

The previous _prepare_cc_project_dir setup_script had an "empty real dir on CC →
replace with symlink to OOD" branch (Fix #75). It was correct in intent but raced
with inflight CC jobs whose freshly-mkdir'd job dir is also empty until the
compute node starts writing. A second prep call would replace the first job's
dir with a symlink to OOD, and the first job's compute would later fail trying
to write through the symlink.

This test asserts that:
1. The unsafe `rmdir + ln -sfn` branch has been removed.
2. The "do not touch" set covers any active CC submission, so the setup_script
   for a second submission cannot reference the first job's path even via the
   safe symlink-creation branches.

Run as a standalone script (no pytest needed):
    python3 deploy-package/backend/tests/test_cc_prep_concurrent.py
"""
from __future__ import annotations

import sys
import unittest.mock as mock
from pathlib import Path
from typing import List

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def _captured_scripts_for_two_preps() -> List[str]:
    """Run two _prepare_cc_project_dir calls back-to-back and return the
    setup_script string fed to ssh each time."""
    from job_manager import JobManager  # noqa: E402
    import config as config_module  # noqa: E402

    # Force CC mode so _prepare_cc_project_dir actually runs its body.
    cfg = config_module.config
    original_host = cfg.cc_scheduler_host
    original_user = cfg.cc_scheduler_user
    cfg.cc_scheduler_host = 'scheduler.example.com'
    cfg.cc_scheduler_user = 'clusteruser'

    try:
        captured: List[str] = []

        class FakeResult:
            returncode = 0
            stdout = ''
            stderr = ''

        def fake_run(cmd, input=None, **kwargs):
            captured.append(input or '')
            return FakeResult()

        # Use a real-looking project path. JobManager mkdirs project_dir on init,
        # so use a tmp project for that part.
        import tempfile
        tmp = Path(tempfile.mkdtemp(prefix='ccprep_'))
        jm = JobManager(str(tmp))

        # Simulate the first job already submitted and inflight (state=RUNNING).
        with jm._lock:
            jm.slurm_jobs['MaskCreate/job053'] = {
                'state': 'RUNNING',
                'project_dir': str(tmp),
                'slurmId': '146',
            }

        # Now prep the second submission. Its setup_script must include the
        # first job's path in the protected set.
        with mock.patch('job_manager.subprocess.run', side_effect=fake_run):
            ok = jm._prepare_cc_project_dir('PostProcess/job050')
            if not ok:
                print('FAIL: prep returned False unexpectedly', file=sys.stderr)
                sys.exit(1)

        # And then the first prep would have run earlier — simulate it now too,
        # standalone (no inflight siblings), to capture both scripts.
        with jm._lock:
            jm.slurm_jobs.clear()
        with mock.patch('job_manager.subprocess.run', side_effect=fake_run):
            jm._prepare_cc_project_dir('MaskCreate/job053')

        import shutil
        shutil.rmtree(tmp, ignore_errors=True)
        return captured
    finally:
        cfg.cc_scheduler_host = original_host
        cfg.cc_scheduler_user = original_user


def main() -> int:
    scripts = _captured_scripts_for_two_preps()
    if len(scripts) < 2:
        print(f'FAIL: expected 2 captured scripts, got {len(scripts)}', file=sys.stderr)
        return 1
    second_prep_script, first_prep_script = scripts[0], scripts[1]

    failures: List[str] = []

    # 1. The dangerous heuristic branch must not be in either script.
    forbidden_substrings = [
        'rmdir "$cc_sub"',
        'replace with symlink to populated OOD copy',
        'Empty real dir on CC',
    ]
    for fb in forbidden_substrings:
        for label, body in (('first', first_prep_script), ('second', second_prep_script)):
            if fb in body:
                failures.append(f"  {label} prep script still contains forbidden text: {fb!r}")

    # 2. The second prep script (which knows about inflight MaskCreate/job053)
    #    must declare it in the PROTECTED list.
    if 'MaskCreate/job053' not in second_prep_script:
        failures.append("  second prep did not include inflight 'MaskCreate/job053' in protected set")
    if 'PROTECTED_LIST_EOF' not in second_prep_script or 'declare -A PROTECTED' not in second_prep_script:
        failures.append('  second prep is missing PROTECTED set declaration')

    # 3. The verify-or-fail gate must be present.
    for label, body in (('first', first_prep_script), ('second', second_prep_script)):
        if 'FATAL: CC job dir is not a real writable directory' not in body:
            failures.append(f"  {label} prep script missing verify-or-fail gate")

    # 4. install -d must be used for the final job dir creation.
    for label, body in (('first', first_prep_script), ('second', second_prep_script)):
        if 'install -d -m 0775 "$CC_PROJ/$JOB_TYPE/$JOB_DIR"' not in body:
            failures.append(f"  {label} prep script missing 'install -d' for final job dir")

    if failures:
        print('FAIL: regression checks for FIX_LOG #83')
        for f in failures:
            print(f)
        return 1

    print('PASS: 4/4 regression checks for FIX_LOG #83')
    print('  - no `rmdir + ln -sfn` empty-replace branch in either script')
    print('  - second prep declares inflight MaskCreate/job053 in PROTECTED set')
    print('  - both scripts include verify-or-fail FATAL gate')
    print("  - both scripts use `install -d` for final job dir")
    return 0


if __name__ == '__main__':
    sys.exit(main())
