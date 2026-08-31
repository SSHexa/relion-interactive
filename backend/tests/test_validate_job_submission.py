"""Regression test for FIX_LOG #84: validate_job_submission catches bad
inputs at submit time so RELION can't waste 5 min of compute on garbage.

Run as a standalone script:
    python3 deploy-package/backend/tests/test_validate_job_submission.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from job_manager import validate_job_submission  # noqa: E402


def expect_raises(name: str, fn, expected_substr: str) -> bool:
    try:
        fn()
        print(f'  FAIL  {name}: did not raise')
        return False
    except ValueError as e:
        if expected_substr in str(e):
            print(f'  OK    {name}')
            return True
        print(f'  FAIL  {name}: wrong message: {e}')
        return False
    except Exception as e:  # noqa: BLE001
        print(f'  FAIL  {name}: wrong exception type: {type(e).__name__}: {e}')
        return False


def expect_passes(name: str, fn) -> bool:
    try:
        fn()
        print(f'  OK    {name}')
        return True
    except Exception as e:  # noqa: BLE001
        print(f'  FAIL  {name}: unexpected raise: {type(e).__name__}: {e}')
        return False


def main() -> int:
    cases = []

    # --- The headline failure mode this fix targets ---
    # PostProcess with a Refine3D run prefix (no half1/half2 in the filename)
    # used to reach RELION on the compute node and fail 5 min later.
    cases.append(expect_raises(
        'PostProcess refuses run-prefix (no half1)',
        lambda: validate_job_submission('PostProcess', {'fn_in': 'Refine3D/job025/run'}, ''),
        'half-map',
    ))
    cases.append(expect_passes(
        'PostProcess accepts half1 file',
        lambda: validate_job_submission(
            'PostProcess',
            {'fn_in': 'Refine3D/job025/run_half1_class001_unfil.mrc'},
            '',
        ),
    ))
    cases.append(expect_passes(
        'PostProcess accepts half2 file',
        lambda: validate_job_submission(
            'PostProcess',
            {'fn_in': 'Refine3D/job025/run_half2_class001_unfil.mrc'},
            '',
        ),
    ))

    # --- Per-job-type input-shape rules ---
    cases.append(expect_raises(
        'AutoPick refuses non-.star input',
        lambda: validate_job_submission('AutoPick', {'fn_in': 'foo.txt'}, ''),
        '.star',
    ))
    cases.append(expect_passes(
        'AutoPick accepts .star input',
        lambda: validate_job_submission(
            'AutoPick', {'fn_in': 'CtfFind/job003/micrographs_ctf.star'}, '',
        ),
    ))
    cases.append(expect_raises(
        'Extract refuses non-.star input',
        lambda: validate_job_submission('Extract', {'fn_in': 'foo.txt'}, ''),
        '.star',
    ))
    cases.append(expect_raises(
        'CtfRefine refuses non-.star data input',
        lambda: validate_job_submission('CtfRefine', {'fn_data': 'foo.bin'}, ''),
        '.star',
    ))

    # --- Numeric bounds ---
    cases.append(expect_raises(
        'Class2D rejects nr_classes=5000 (over 1000)',
        lambda: validate_job_submission('Class2D', {'nr_classes': 5000}, ''),
        'between 1 and 1000',
    ))
    cases.append(expect_passes(
        'Class2D accepts nr_classes=50',
        lambda: validate_job_submission('Class2D', {'nr_classes': 50}, ''),
    ))
    cases.append(expect_raises(
        'Refine3D rejects nr_mpi=999 (over 256)',
        lambda: validate_job_submission('Refine3D', {'nr_mpi': 999}, ''),
        'between 1 and 256',
    ))

    # --- Unknown job type ---
    cases.append(expect_raises(
        'unknown job type rejected',
        lambda: validate_job_submission('NotARealJobType', {}, ''),
        'Unknown job type',
    ))

    # --- Job types without strict shape rules pass through cleanly ---
    cases.append(expect_passes(
        'Class2D with no path params passes',
        lambda: validate_job_submission('Class2D', {}, ''),
    ))
    cases.append(expect_passes(
        'Import with raw movie input passes',
        lambda: validate_job_submission('Import', {'fn_in_raw': 'Movies/*.tiff'}, ''),
    ))

    passed = sum(cases)
    total = len(cases)
    print(f'\n  {passed}/{total} passed')
    return 0 if passed == total else 1


if __name__ == '__main__':
    sys.exit(main())
