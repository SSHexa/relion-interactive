"""
Job manager for RELION processes with Slurm support.
Jobs are submitted via Slurm and survive backend restarts.
"""
import os
import subprocess
import threading
import time
import signal
import re
import json
import logging
import shutil
import shlex
import fcntl
from contextlib import contextmanager
from pathlib import Path
from typing import Dict, List, Any, Optional, Callable
from datetime import datetime

from config import config


def sanitize_param_value(value: str, param_name: str = '') -> str:
    """
    Sanitize a parameter value for safe shell command execution.

    Args:
        value: The parameter value to sanitize
        param_name: Name of the parameter (for error messages)

    Returns:
        Shell-safe quoted string

    Raises:
        ValueError: If value contains dangerous characters
    """
    str_value = str(value)

    # Reject obviously malicious input patterns
    dangerous_patterns = [
        r'[;&|`$]',           # Shell metacharacters
        r'\$\(',              # Command substitution
        r'>\s*/',             # Redirect to root
        r'<\s*/',             # Redirect from root
        r'\.\./\.\.',         # Double traversal
        r'rm\s+-rf',          # rm -rf commands
        r'chmod\s+777',       # chmod 777
        r'/etc/',             # System config access
        r'/var/log/',         # Log access
    ]

    for pattern in dangerous_patterns:
        if re.search(pattern, str_value, re.IGNORECASE):
            raise ValueError(f"Dangerous pattern detected in parameter '{param_name}': {pattern}")

    # For file paths, validate they look like valid RELION paths
    if param_name.startswith('fn_') or 'path' in param_name.lower():
        # Allow only alphanumeric, slashes, dots, underscores, hyphens, and colons
        if not re.match(r'^[\w\-./:* ]+$', str_value):
            raise ValueError(f"Invalid characters in path parameter '{param_name}': {str_value}")

    # Return the value (shlex.quote is applied later when building shell commands)
    return str_value

# Set up logging
logger = logging.getLogger(__name__)


# Job type to RELION command mapping
JOB_TYPE_COMMANDS = {
    'Import': 'relion_import',
    'MotionCorr': 'relion_run_motioncorr',
    'CtfFind': 'relion_run_ctffind',
    'ManualPick': 'relion_manualpick',
    'AutoPick': 'relion_autopick',
    'Extract': 'relion_preprocess',
    'Class2D': 'relion_refine',
    'Class3D': 'relion_refine',
    'Refine3D': 'relion_refine',
    'CtfRefine': 'relion_ctf_refine',
    'MotionRefine': 'relion_motion_refine',
    'PostProcess': 'relion_postprocess',
    'LocalRes': 'relion_locres',
    'MaskCreate': 'relion_mask_create',
    'JoinStar': 'relion_star_handler',
    'Subtract': 'relion_particle_subtract',
    'InitialModel': 'relion_refine',
    'MultiBody': 'relion_refine',  # Multibody uses relion_refine with --multibody_masks
    'ClassSelect': 'relion_star_handler',
    'ClassRanker': 'relion_class_ranker',
    'ModelAngelo': 'relion_model_angelo',
    'DynaMight': 'dynamight',  # Uses standalone dynamight CLI, not container
    'External': None,
    # Tomography job types
    'TomoImport': 'relion_tomo_import',
    'TomoExcludeTilts': 'relion_tomo_exclude_tilts',
    'TomoAlignTilts': 'relion_tomo_align_tilts',
    'TomoReconstruct': 'relion_tomo_reconstruct',
    'TomoDenoise': 'relion_tomo_denoise',
    'TomoImportParticles': 'relion_tomo_import_particles',
    'TomoSubtomo': 'relion_tomo_subtomo',
    'TomoCtfRefine': 'relion_tomo_ctf_refine',
}

# Jobs that should run locally (quick jobs)
LOCAL_JOBS = ['Import', 'ClassSelect']

# Jobs that run outside the Singularity container (native Python tools)
NON_CONTAINER_JOBS = ['DynaMight']

# Single-process RELION jobs that must NEVER use MPI (no _mpi binary variant exists)
# These always run as: relion_postprocess, relion_mask_create, relion_locres
# Forcing nr_mpi=1 prevents both _mpi suffix addition and mpirun wrapping in Slurm scripts
SINGLE_PROCESS_JOBS = ['PostProcess', 'MaskCreate', 'LocalRes']

# RELION parameter name -> CLI flag mapping shared across all (non-DynaMight) job types.
# Per-job-type collisions (e.g. 'fn_data' for ClassSelect/CtfRefine, 'fn_mask' for
# PostProcess) are handled by the inline elif branches in submit_job's param loop.
# Hoisted out of submit_job to module scope so we don't recompute it on every call.
PARAM_MAPPING = {
    'fn_in': 'i',
    'fn_in_raw': 'i',
    'input_star_mics': 'i',  # MotionCorr input micrographs
    'is_raw_movies': 'do_movies',  # Import movies flag
    'fn_out': 'o',
    'particle_diameter': 'particle_diameter',
    'nr_classes': 'K',
    'nr_iter': 'iter',
    'tau_fudge': 'tau2_fudge',
    'do_ctf': 'ctf',
    'ctf_intact_first_peak': 'ctf_intact_first_peak',
    'do_zero_mask': 'zero_mask',
    'highres_limit': 'strict_highres_exp',
    'fn_mask': 'solvent_mask',
    'angpix': 'angpix',
    'kV': 'kV',
    'Cs': 'Cs',
    'Q0': 'Q0',
    'extract_size': 'extract_size',
    'rescale': 'scale',
    'do_norm': 'norm',
    'bg_radius': 'bg_radius',
    'white_dust': 'white_dust',
    'black_dust': 'black_dust',
    'do_invert': 'invert_contrast',
    'coords_suffix': 'coord_suffix',
    'coord_list': 'coord_list',
    'do_recenter': 'recenter',
    'do_fom_threshold': 'use_fom_threshold',
    'minimum_pick_fom': 'fom_threshold',
    'do_write_fom_maps': 'write_fom_maps',
    'do_pick_helical_segments': 'helix',
    'fn_ref': 'ref',
    'fn_ref1': 'ref1',
    'fn_ref2': 'ref2',
    'do_startend': 'startend',
    'do_amyloid': 'amyloid',
    'shrink': 'shrink',
    'lowpass': 'lowpass',
    'lowpass_filter': 'lowpass',
    'highpass': 'highpass',
    'angpix_ref': 'angpix_ref',
    'threshold_pick': 'threshold',
    'min_particle_distance': 'min_distance',
    'max_stddev_noise': 'max_stddev_noise',
    # CtfFind parameters (RELION 5 uses PascalCase flags)
    'resmin': 'ResMin',
    'resmax': 'ResMax',
    'dfmin': 'dFMin',
    'dfmax': 'dFMax',
    'dfstep': 'FStep',
    'dast': 'dAst',
    'ctf_win': 'ctfWin',
    'box': 'Box',
    'do_phaseshift': 'do_phaseshift',
    'do_ctf_correction': 'ctf',
    'do_only_flip_phases': 'only_flip_phases',
    'skip_align': 'skip_align',
    'psi_sampling': 'psi_step',
    'offset_range': 'offset_range',
    'offset_step': 'offset_step',
    'do_helix': 'helix',
    'helical_rise': 'helical_rise_initial',
    'helical_twist': 'helical_twist_initial',
    'sym_name': 'sym',
    'do_local_ang_searches': 'sigma_ang',
    'sigma_angles': 'sigma_ang',
    'relax_sym': 'relax_sym',
    'ini_high': 'ini_high',
    'fn_img': 'i',
    'fn_mic': 'mic',
    'fn_part': 'i',
    'fn_model': 'model',
    'do_solvent_fsc': 'solvent_correct_fsc',
    'mtf_file': 'mtf',
    'fn_mtf': 'mtf',
    'ini_threshold': 'ini_threshold',
    'extend_inimask': 'extend_inimask',
    'width_soft_edge': 'width_soft_edge',
    # ClassSelect parameters
    'select_label': 'select',
    'select_minval': 'minval',
    'select_maxval': 'maxval',
    # Reference size handling
    'trust_ref_size': 'trust_ref_size',
    # CtfRefine parameters
    'fn_data': 'i',
    'fn_post': 'f',
    'do_aniso_mag': 'fit_aniso',
    'do_beamtilt': 'fit_beamtilt',
    'do_trefoil': 'fit_trefoil',
    'do_4thorder': 'fit_4thorder',
}

# Frontend/MCP meta-params that must NOT be forwarded to the relion binary
# (would produce "Option --X is not a valid RELION argument" warnings, and worse,
# garbage state). See FIX_LOG #76.
META_PARAMS = {
    'queueSubmit', 'nrMpi', 'nrThreads', 'name', 'alias',
    'outputDir', 'jobType', 'mode',
}

# Per-job-type optics params that belong on Import only — they're baked into
# the optics group of movies.star and rejected by other binaries. See FIX_LOG #76.
IMPORT_ONLY_OPTICS = {'Cs', 'Q0', 'voltage', 'angpix'}

# Process status codes (matching RELION)
STATUS_SCHEDULED = 0
STATUS_RUNNING = 1
STATUS_FINISHED = 2
STATUS_ABORTED = 3
STATUS_FAILED = 4

# Slurm job tracking file
SLURM_JOBS_FILE = '.slurm_jobs.json'


# ===== Validation =====
#
# Numeric param bounds applied to ALL job types. Keys are RELION param names.
_NUMERIC_LIMITS = {
    'nr_mpi':     (1, 256),
    'nr_threads': (1, 256),
    'nr_pool':    (1, 256),
    'nr_classes': (1, 1000),
    'nr_iter':    (1, 1000),
    'K':          (1, 1000),
    '_nrMpi':     (1, 256),
    '_nrThreads': (1, 256),
}


def _check_path_endswith(params: Dict[str, Any], key: str, suffix: str, label: str) -> None:
    """Raise ValueError if params[key] is set and doesn't end with suffix."""
    val = str(params.get(key) or '')
    if val and not val.endswith(suffix):
        raise ValueError(f"{label}: '--{key}' must end with '{suffix}', got: {val!r}")


def _check_path_contains(params: Dict[str, Any], key: str, fragments: tuple, label: str) -> None:
    """Raise ValueError if params[key] is set and contains none of `fragments`."""
    val = str(params.get(key) or '')
    if val and not any(f in val for f in fragments):
        raise ValueError(
            f"{label}: '--{key}' must contain one of {list(fragments)}, got: {val!r}"
        )


def _validate_postprocess(params: Dict[str, Any]) -> None:
    """PostProcess --i must point at a half-map file (filename containing
    'half1' or 'half2'). Catches the FIX_LOG #84 failure mode where users
    pass a Refine3D run prefix and waste 5 min of compute before RELION
    rejects it on the node.
    """
    _check_path_contains(
        params, 'fn_in', ('half1', 'half2'),
        'PostProcess input must be a half-map (e.g. Refine3D/jobNNN/run_half1_class001_unfil.mrc)'
    )


def _validate_autopick(params: Dict[str, Any]) -> None:
    _check_path_endswith(params, 'fn_in', '.star', 'AutoPick input')


def _validate_extract(params: Dict[str, Any]) -> None:
    _check_path_endswith(params, 'fn_in', '.star', 'Extract input')


def _validate_ctfrefine(params: Dict[str, Any]) -> None:
    """CtfRefine takes a Refine3D data star (run_data.star)."""
    _check_path_endswith(params, 'fn_data', '.star', 'CtfRefine input')


# Per-job-type input-shape validators. Each callable takes the params dict
# and raises ValueError on bad input. Job types not listed pass through.
_JOBTYPE_INPUT_RULES: Dict[str, Any] = {
    'PostProcess': _validate_postprocess,
    'AutoPick':    _validate_autopick,
    'Extract':     _validate_extract,
    'CtfRefine':   _validate_ctfrefine,
}


def validate_job_submission(job_type: str, params: Dict[str, Any], project_dir: str = '') -> None:
    """Validate job submission data before processing.

    Single source of truth used by both the Flask /api/jobs/submit route
    and the MCP `submit_job` / `run_*` workflow tools. Raises ValueError on
    bad input so callers fail fast instead of letting RELION reject 5 min
    later on the compute node.

    Checks:
      - Job type is in JOB_TYPE_COMMANDS
      - Numeric params (nr_mpi, nr_classes, etc.) are within sane bounds
      - Per-job-type input-shape rules (e.g. PostProcess --i must contain
        'half1' or 'half2'; AutoPick / Extract / CtfRefine inputs must
        be .star files)

    Args:
        job_type:    The type of job being submitted
        params:      Job parameters dictionary
        project_dir: Project directory path (currently unused, reserved
                     for future file-existence checks)

    Raises:
        ValueError: If validation fails
    """
    # 1. Job type must be recognized
    if job_type not in JOB_TYPE_COMMANDS:
        raise ValueError(f"Unknown job type: {job_type}")

    # 2. Numeric bounds
    for key, (lo, hi) in _NUMERIC_LIMITS.items():
        if key in params and params[key] is not None:
            try:
                v = int(params[key])
            except (TypeError, ValueError):
                continue  # non-numeric, RELION will report
            if v < lo or v > hi:
                raise ValueError(f"Parameter '{key}' must be between {lo} and {hi}, got {v}")

    # 3. Per-job-type input-shape rules
    rule = _JOBTYPE_INPUT_RULES.get(job_type)
    if rule is not None:
        rule(params)


class JobManager:
    """Manages RELION job submission via Slurm."""

    def __init__(self, project_dir: str):
        self.project_dir = Path(project_dir)
        self.slurm_jobs: Dict[str, Dict[str, Any]] = {}
        # Local (subprocess-based) job tracking, used by _run_local() /
        # _abort_local() when execution_mode == 'local' or for LOCAL_JOBS.
        self._local_threads: Dict[str, threading.Thread] = {}
        self._local_procs: Dict[str, subprocess.Popen] = {}
        self.callbacks: List[Callable] = []
        self._lock = threading.Lock()
        self._load_slurm_jobs()

    def _get_slurm_jobs_file(self) -> Path:
        return self.project_dir / SLURM_JOBS_FILE

    def _load_slurm_jobs(self):
        """Load Slurm job tracking data."""
        jobs_file = self._get_slurm_jobs_file()
        if jobs_file.exists():
            try:
                with open(jobs_file, 'r') as f:
                    self.slurm_jobs = json.load(f)
            except (json.JSONDecodeError, IOError) as e:
                print(f"Warning: Failed to load Slurm jobs file: {e}")
                self.slurm_jobs = {}

    def _save_slurm_jobs(self):
        """Save Slurm job tracking data."""
        jobs_file = self._get_slurm_jobs_file()
        with open(jobs_file, 'w') as f:
            json.dump(self.slurm_jobs, f, indent=2)

    def add_callback(self, callback: Callable) -> None:
        self.callbacks.append(callback)

    def _notify_callbacks(self, process_id: str, status: int) -> None:
        for callback in self.callbacks:
            try:
                callback(process_id, status)
            except Exception as e:
                print(f"Callback error: {e}")

    def get_job_types(self) -> List[Dict[str, Any]]:
        job_types = []
        for job_type, command in JOB_TYPE_COMMANDS.items():
            job_types.append({
                'name': job_type,
                'label': job_type,
                'command': command,
                'available': command is not None
            })
        return job_types

    def _get_recently_active_nodes(self) -> List[str]:
        """Find nodes that have run jobs recently (likely still powered on)."""
        active_nodes = {}

        try:
            for job_type_dir in self.project_dir.iterdir():
                if not job_type_dir.is_dir():
                    continue
                for job_dir in job_type_dir.iterdir():
                    if not job_dir.is_dir() or not job_dir.name.startswith('job'):
                        continue

                    run_out = job_dir / 'run.out'
                    if run_out.exists():
                        try:
                            mtime = run_out.stat().st_mtime
                            # Only consider jobs from last 24 hours
                            if time.time() - mtime > 86400:
                                continue

                            with open(run_out, 'r') as f:
                                for line in f:
                                    if 'Running on node:' in line:
                                        node_name = line.split('Running on node:')[1].strip()
                                        if node_name and (node_name not in active_nodes or mtime > active_nodes[node_name]):
                                            active_nodes[node_name] = mtime
                                        break
                        except Exception:
                            pass

            return sorted(active_nodes.keys(), key=lambda n: active_nodes[n], reverse=True)
        except Exception:
            return []

    def _get_node_resources(self, ssh_node: str) -> Dict[str, Dict]:
        """SSH to a node and query SLURM for available resources on RUNNING nodes only.

        Returns dict: {node_name: {'total': X, 'allocated': Y, 'idle': Z,
                        'total_mem_mb': M, 'alloc_mem_mb': A}}
        Only includes nodes that are actually powered on (no ~ or # suffix in state).
        """
        try:
            # Query node info AND job allocations in one SSH call
            # sinfo: CPU allocation + total memory per node
            # squeue: allocated memory per running job per node
            result = subprocess.run(
                ['ssh', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=no',
                 ssh_node,
                 'sinfo -h -N -o "%N %T %C %m" 2>/dev/null; '
                 'echo "---SQUEUE---"; '
                 'squeue -h -t RUNNING -o "%N %m" 2>/dev/null'],
                capture_output=True,
                text=True,
                timeout=10
            )

            if result.returncode != 0:
                return {}

            # Parse sinfo and squeue sections
            output = result.stdout.strip()
            sinfo_lines = []
            squeue_lines = []
            section = 'sinfo'
            for line in output.split('\n'):
                if '---SQUEUE---' in line:
                    section = 'squeue'
                    continue
                if section == 'sinfo':
                    sinfo_lines.append(line)
                else:
                    squeue_lines.append(line)

            # Parse per-node allocated memory from squeue (running jobs)
            node_alloc_mem = {}  # node_name -> total allocated MB
            for line in squeue_lines:
                parts = line.split()
                if len(parts) >= 2:
                    node = parts[0]
                    mem_str = parts[1]  # e.g. "6G" or "6144M"
                    try:
                        if mem_str.endswith('G'):
                            mem_mb = int(mem_str[:-1]) * 1024
                        elif mem_str.endswith('M'):
                            mem_mb = int(mem_str[:-1])
                        else:
                            mem_mb = int(mem_str)
                        node_alloc_mem[node] = node_alloc_mem.get(node, 0) + mem_mb
                    except ValueError:
                        pass

            # Parse sinfo for CPU and total memory
            resources = {}
            for line in sinfo_lines:
                if not line.strip():
                    continue
                parts = line.split()
                if len(parts) >= 3:
                    node_name = parts[0]
                    state = parts[1]
                    cpu_info = parts[2]  # Format: A/I/O/T
                    total_mem_mb = 0
                    if len(parts) >= 4:
                        try:
                            total_mem_mb = int(parts[3])
                        except ValueError:
                            pass

                    # Skip nodes that are powered down (~), transitioning (#), or not responding (*)
                    if '~' in state or '#' in state or '*' in state:
                        continue

                    try:
                        allocated, idle, other, total = map(int, cpu_info.split('/'))
                        alloc_mem = node_alloc_mem.get(node_name, 0)
                        resources[node_name] = {
                            'total': total,
                            'allocated': allocated,
                            'idle': idle,
                            'state': state,
                            'total_mem_mb': total_mem_mb,
                            'alloc_mem_mb': alloc_mem,
                            'free_mem_mb': max(0, total_mem_mb - alloc_mem)
                        }
                    except ValueError:
                        pass

            return resources
        except Exception as e:
            logger.warning(f"Could not query node resources via {ssh_node}: {e}")
            return {}

    def _find_nodes_with_capacity(self, cores_needed: int, memory_gb: int = 0) -> tuple:
        """Find existing RUNNING nodes that have enough idle cores and memory for the job.

        Returns: (best_node: str or None, node_idle_cores: int)
        - best_node: Name of a single running node with enough capacity, or None
        - node_idle_cores: Number of idle cores on that node

        Only considers nodes that are actually running (idle, mixed, or alloc state).
        """
        # cyclecloud-mode only: known compute node hostnames used as a
        # capacity-check fallback when sinfo doesn't list a node (powered-down
        # autoscaled nodes have no DNS entry). Generic clusters have stable
        # hostnames and won't need this fallback.
        known_nodes = [
            'ccw-htc-1', 'ccw-htc-2', 'ccw-htc-3', 'ccw-htc-4', 'ccw-gpu-1', 'ccw-hpc-1'
        ] if config.is_cyclecloud() else []

        # First, find recently active nodes we can SSH to
        active_nodes = self._get_recently_active_nodes()

        # Combine: active nodes first (more likely to be up), then known nodes
        nodes_to_try = []
        for node in active_nodes:
            if node not in nodes_to_try:
                nodes_to_try.append(node)
        for node in known_nodes:
            if node not in nodes_to_try:
                nodes_to_try.append(node)

        if not nodes_to_try:
            return None, 0

        # Try to query SLURM resources via SSH to a running node
        # Powered-down nodes may not have DNS entries, so we try multiple
        resources = {}
        for node in nodes_to_try:
            resources = self._get_node_resources(node)
            if resources:
                logger.info(f"Successfully queried SLURM resources via {node}")
                break

        if not resources:
            return None, 0

        # Find the best single node that can fit this job
        # Only consider nodes in running states (not powered down)
        best_node = None
        best_idle = 0

        memory_mb_needed = memory_gb * 1024

        for node_name, info in resources.items():
            idle = info.get('idle', 0)
            state = info.get('state', '').lower()
            free_mem = info.get('free_mem_mb', 0)

            # Only use nodes that are actually running
            # States: idle (fully available), mixed (some cores used), alloc (all used but running)
            # Skip: idle~ (powered down), drain, down, etc.
            if 'idle' in state or 'mix' in state or 'alloc' in state:
                # Check CPU capacity
                if idle < cores_needed:
                    continue
                # Check memory capacity (if requested and reported)
                if memory_mb_needed > 0 and free_mem > 0 and free_mem < memory_mb_needed:
                    logger.info(f"Node {node_name} has {idle} idle cores but only {free_mem}MB free mem (need {memory_mb_needed}MB)")
                    continue
                # Pick node with most idle cores
                if idle > best_idle:
                    best_node = node_name
                    best_idle = idle

        return best_node, best_idle

    def _create_slurm_script(self, job_dir: Path, cmd: List[str], job_name: str,
                             nr_cpus: int = 1, memory_gb: int = 16,
                             time_hours: int = 48, nr_mpi: int = 1,
                             job_type: str = '', use_gpu: bool = False) -> Path:
        """Create Slurm batch script."""
        script_path = job_dir / 'submit.sh'

        # Calculate total cores needed for this job
        cores_needed = nr_mpi * nr_cpus if nr_mpi > 1 else nr_cpus

        # Smart node allocation: prefer running nodes to avoid waking up new VMs
        # Only use --nodelist when a SINGLE running node has enough capacity (CPU + memory)
        # This prevents SLURM from waking new VMs when existing ones can handle the job
        node_directive = ""
        try:
            best_node, idle_cores = self._find_nodes_with_capacity(cores_needed, memory_gb)
            if best_node:
                node_directive = f"#SBATCH --nodelist={best_node}"
                logger.info(f"Scheduling on running node {best_node} with {idle_cores} idle cores (job needs {cores_needed})")
        except Exception as e:
            logger.warning(f"Could not determine node capacity, letting SLURM decide: {e}")

        # Check if this job type runs outside container (e.g., DynaMight)
        use_container = job_type not in NON_CONTAINER_JOBS

        # Build the command - wrap in singularity if container configured
        container = getattr(config, 'relion_container', '') or '/shared/apps/relion/backup/relion.sif'

        # Build inner command (without mpirun/singularity wrapper - we'll add them properly)
        inner_cmd = []
        skip_next = False
        found_relion_cmd = False
        for i, arg in enumerate(cmd):
            if skip_next:
                skip_next = False
                continue
            # Skip the wrapper mpirun and -np arguments
            if 'mpirun' in arg:
                continue
            if arg == '--oversubscribe':
                continue
            if arg == '-np':
                skip_next = True
                continue
            # Skip singularity wrapper if present
            if 'singularity' in arg or arg == 'exec':
                continue
            if arg.endswith('.sif'):
                continue
            # Skip --bind and its value
            if arg == '--bind':
                skip_next = True
                continue
            # Skip bind mount paths (like /shared:/shared)
            if ':' in arg and '/' in arg and not arg.startswith('--'):
                continue

            # For the first non-skipped argument (the RELION command), extract just the basename
            # This converts /path/to/relion_refine -> relion_refine
            if not found_relion_cmd and (arg.startswith('relion_') or '/relion_' in arg or arg == 'dynamight'):
                relion_cmd = os.path.basename(arg)
                # For MPI jobs, use the _mpi version of the binary (e.g., relion_refine_mpi)
                # But not for non-container jobs like DynaMight
                if nr_mpi > 1 and not relion_cmd.endswith('_mpi') and use_container:
                    relion_cmd = relion_cmd + '_mpi'
                inner_cmd.append(relion_cmd)
                found_relion_cmd = True
            else:
                inner_cmd.append(arg)

        # Build shell-safe command string with proper quoting
        inner_cmd_str = ' '.join(shlex.quote(arg) for arg in inner_cmd)

        # Build full command
        # Use full path to singularity since srun doesn't inherit PATH
        singularity_bin = config.singularity_bin
        bind = config.container_bind

        if not use_container:
            # For non-container jobs (e.g., DynaMight), run directly with PATH set
            dynamight_path = config.dynamight_bin_path
            full_cmd = f'export PATH={dynamight_path}:$PATH && {inner_cmd_str}'
        elif nr_mpi > 1:
            # For MPI jobs: use mpirun INSIDE singularity with local-only execution
            # --oversubscribe: Ignore slot availability (container doesn't see SLURM allocation)
            # --mca btl vader,self: Use only shared memory for communication
            # This works for single-node MPI jobs
            full_cmd = f'{singularity_bin} exec --bind {bind} {container} mpirun --oversubscribe --mca btl vader,self -np {nr_mpi} {inner_cmd_str}'
        else:
            full_cmd = f'{singularity_bin} exec --bind {bind} {container} {inner_cmd_str}'

        # For MPI jobs using local execution, request all CPUs on a single node
        total_cpus = nr_mpi * nr_cpus if nr_mpi > 1 else nr_cpus

        # Determine partition from config
        partition = config.slurm_partition

        # CycleCloud-only: add /sched-shared bind mount so OOD NFS data is
        # accessible inside the Singularity container on CC compute nodes.
        # Generic customer clusters use whatever bind is in container_bind.
        is_cyclecloud = config.is_cyclecloud()
        if is_cyclecloud:
            full_cmd = full_cmd.replace(
                f'--bind {bind}',
                f'--bind {bind} --bind /sched-shared:/sched-shared'
            )
        gpu_directive = '#SBATCH --gres=gpu:1' if use_gpu else ''

        nfs_setup = ''
        if is_cyclecloud:
            # OOD NFS server address — where compute nodes mount OOD's /shared
            # from. Set ood_nfs_server in config.json or RELION_OOD_NFS_SERVER
            # env var. No default — required for cyclecloud mode.
            ood_nfs = getattr(config, 'ood_nfs_server', None) or \
                      os.environ.get('RELION_OOD_NFS_SERVER', '')
            if not ood_nfs:
                raise RuntimeError(
                    "cluster_mode='cyclecloud' requires ood_nfs_server in "
                    "config.json (or RELION_OOD_NFS_SERVER env var). See "
                    "docs/CYCLECLOUD.md."
                )
            nfs_setup = '''
# CycleCloud node setup: mount OOD shared storage and install apptainer
if ! mountpoint -q /sched-shared 2>/dev/null; then
    sudo mkdir -p /sched-shared 2>/dev/null
    sudo mount -t nfs __OOD_NFS_SERVER__:/shared /sched-shared -o defaults,nofail,timeo=30 2>/dev/null
fi
# Ensure container backup symlink exists on CC's /shared
if [ ! -e "/shared/apps/relion/backup/relion_backend.sif" ]; then
    sudo mkdir -p /shared/apps/relion/backup 2>/dev/null
    sudo ln -sfn /shared/apps/relion/relion_backend.sif /shared/apps/relion/backup/relion_backend.sif 2>/dev/null
fi
# Install apptainer from shared deb if not present.
# The first job on a freshly-booted CycleCloud node races with CycleCloud's
# own apt/dpkg provisioning (slurm, enroot, etc). If our install runs while
# those locks are held, dpkg -i fails and /usr/bin/singularity never gets
# created, causing the job to die with exit 127. Wait for the lock, retry,
# and verify the binary exists before proceeding.
if [ ! -x /usr/bin/apptainer ]; then
    if [ -f /shared/apps/apptainer.deb ]; then
        # Wait up to 120s for any other apt/dpkg process to release the lock
        for i in $(seq 1 60); do
            if ! sudo fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock >/dev/null 2>&1; then
                break
            fi
            echo "[apptainer-install] Waiting for dpkg lock (${i}/60)..."
            sleep 2
        done
        # Install apptainer — pre-install uidmap dependency so dpkg -i succeeds.
        # apt-get install -f as fallback needs DEBIAN_FRONTEND=noninteractive
        # because compute nodes have no TTY for debconf.
        export DEBIAN_FRONTEND=noninteractive
        sudo -E apt-get install -y -qq uidmap
        sudo -E dpkg -i /shared/apps/apptainer.deb || sudo -E apt-get install -f -y -qq
        sudo ln -sf /usr/bin/apptainer /usr/bin/singularity
    fi
fi
# Verify singularity is now available — fail loudly if not, so run.err
# shows the real cause instead of a cryptic "No such file" from line 51.
if [ ! -x /usr/bin/apptainer ]; then
    echo "FATAL: /usr/bin/apptainer not available on $(hostname)" >&2
    echo "FATAL: /shared/apps/apptainer.deb exists: $([ -f /shared/apps/apptainer.deb ] && echo yes || echo no)" >&2
    exit 2
fi
'''
            nfs_setup = nfs_setup.replace('__OOD_NFS_SERVER__', ood_nfs)

        # For CycleCloud partitions, project dir setup is done before submission
        # by _prepare_cc_project_dir() via SSH to CC scheduler (correct UID, no sudo).
        if is_cyclecloud:
            cc_project_dir = str(self.project_dir)
            cc_job_dir = str(job_dir)
            slurm_output = f'/tmp/slurm_{job_name.replace("/", "_")}_%j.out'
            slurm_error = f'/tmp/slurm_{job_name.replace("/", "_")}_%j.err'
        else:
            cc_project_dir = str(self.project_dir)
            cc_job_dir = str(job_dir)
            slurm_output = f'{job_dir}/run.out'
            slurm_error = f'{job_dir}/run.err'

        script_content = f'''#!/bin/bash
#SBATCH --job-name={job_name.replace('/', '_')}
#SBATCH --partition={partition}
#SBATCH --output={slurm_output}
#SBATCH --error={slurm_error}
#SBATCH --nodes=1
#SBATCH --cpus-per-task={total_cpus}
#SBATCH --mem={memory_gb}G
#SBATCH --time={time_hours}:00:00
{gpu_directive}
{node_directive}
{nfs_setup}
# Change to project directory
cd {shlex.quote(cc_project_dir)} || {{ echo "ERROR: Project dir not found: {cc_project_dir}"; exit 1; }}

# Clear conflicting SLURM memory variables
unset SLURM_MEM_PER_CPU SLURM_MEM_PER_GPU SLURM_MEM_PER_NODE

# Print start info
echo "Job started at: $(date)"
echo "Running on node: $(hostname)"
echo "Command: {full_cmd}"
echo ""

# Ensure job output directory exists on this node's /shared
mkdir -p {cc_job_dir} 2>/dev/null || true

# Create running marker (may fail on NFS due to UID mismatch - not critical)
touch {cc_job_dir}/RELION_JOB_RUNNING 2>/dev/null || true

# Run the command inside singularity container
{full_cmd}
EXIT_CODE=$?

# Remove running marker
rm -f {cc_job_dir}/RELION_JOB_RUNNING 2>/dev/null || true

# Create appropriate marker file
if [ $EXIT_CODE -eq 0 ]; then
    touch {cc_job_dir}/RELION_JOB_EXIT_SUCCESS 2>/dev/null || true
else
    touch {cc_job_dir}/RELION_JOB_EXIT_FAILURE 2>/dev/null || true
fi

echo ""
echo "Job finished at: $(date)"
echo "Exit code: $EXIT_CODE"

# Copy output logs to CC's project dir
SLURM_OUT="/tmp/slurm_{job_name.replace('/', '_')}_$SLURM_JOB_ID.out"
SLURM_ERR="/tmp/slurm_{job_name.replace('/', '_')}_$SLURM_JOB_ID.err"
cp -f "$SLURM_OUT" {cc_job_dir}/run.out 2>/dev/null || true
cp -f "$SLURM_ERR" {cc_job_dir}/run.err 2>/dev/null || true

exit $EXIT_CODE
'''

        with open(script_path, 'w') as f:
            f.write(script_content)
        script_path.chmod(0o755)

        return script_path

    def _find_sbatch(self) -> Optional[str]:
        """Find sbatch command - check config proxy first, then common locations."""
        # Check config for custom sbatch command (e.g., CycleCloud proxy script)
        custom = getattr(config, 'sbatch_command', None)
        if custom and os.path.exists(custom) and os.access(custom, os.X_OK):
            return custom

        # Check if sbatch is in PATH
        try:
            result = subprocess.run(['which', 'sbatch'], capture_output=True, text=True)
            if result.returncode == 0 and result.stdout.strip():
                return result.stdout.strip()
        except (subprocess.SubprocessError, OSError) as e:
            print(f"Warning: Failed to find sbatch via 'which': {e}")

        # Check common SLURM installation paths
        common_paths = [
            '/usr/bin/sbatch',
            '/usr/local/bin/sbatch',
            '/opt/slurm/bin/sbatch',
            '/usr/local/slurm/bin/sbatch',
            '/cm/shared/apps/slurm/current/bin/sbatch',
        ]

        for path in common_paths:
            if os.path.exists(path) and os.access(path, os.X_OK):
                return path

        return None

    def _find_squeue(self) -> str:
        """Find squeue command - check config proxy first, then default."""
        custom = getattr(config, 'squeue_command', None)
        if custom and os.path.exists(custom) and os.access(custom, os.X_OK):
            return custom
        return 'squeue'

    def _find_scancel(self) -> str:
        """Find scancel command - check config proxy first, then default."""
        custom = getattr(config, 'scancel_command', None)
        if custom and os.path.exists(custom) and os.access(custom, os.X_OK):
            return custom
        return 'scancel'

    def _submit_via_ssh(self, script_path: Path, job_name: str, slurm_host: str = 'localhost') -> tuple:
        """Submit job to SLURM via SSH to the scheduler node."""
        try:
            result = subprocess.run(
                ['ssh', slurm_host, f'sbatch {script_path}'],
                capture_output=True,
                text=True,
                timeout=30
            )

            if result.returncode != 0:
                return None, f"SSH sbatch failed: {result.stderr}"

            # Parse job ID
            match = re.search(r'Submitted batch job (\d+)', result.stdout)
            if match:
                slurm_job_id = match.group(1)

                # Save job ID with partition info
                with self._lock:
                    self.slurm_jobs[job_name] = {
                        'slurm_id': slurm_job_id,
                        'submit_time': datetime.now().isoformat(),
                        'partition': config.slurm_partition,
                        'last_status': 'PENDING',
                        'project_dir': str(self.project_dir),
                    }
                    self._save_slurm_jobs()

                return slurm_job_id, None

            return None, 'Could not parse job ID from sbatch output'

        except subprocess.TimeoutExpired:
            return None, 'SSH timeout while submitting job'
        except Exception as e:
            return None, str(e)

    def _submit_to_slurm(self, script_path: Path, job_name: str) -> tuple:
        """Submit job to Slurm via proxy or local sbatch.

        For CycleCloud proxy sbatch: translates OOD /shared path to CC scheduler's
        /sched-shared path so the remote sbatch can read the script file via NFS.
        """
        sbatch_cmd = self._find_sbatch()

        if sbatch_cmd:
            try:
                # Check if using proxy sbatch (CycleCloud)
                is_proxy = getattr(config, 'sbatch_command', None) and sbatch_cmd == config.sbatch_command

                if is_proxy:
                    # Translate OOD /shared path → CC scheduler /sched-shared path
                    # CC scheduler mounts OOD's /shared at /sched-shared via NFS
                    script_str = str(script_path)
                    if script_str.startswith('/shared/'):
                        cc_script_path = script_str.replace('/shared/', '/sched-shared/', 1)
                    else:
                        cc_script_path = script_str
                    print(f"[JobManager] Proxy sbatch: {script_str} → {cc_script_path}")
                    cmd = [sbatch_cmd, cc_script_path]
                else:
                    cmd = [sbatch_cmd, str(script_path)]

                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    cwd=str(self.project_dir)
                )

                if result.returncode == 0:
                    # Parse job ID
                    match = re.search(r'Submitted batch job (\d+)', result.stdout)
                    if match:
                        slurm_job_id = match.group(1)

                        # Save job ID with partition info
                        with self._lock:
                            self.slurm_jobs[job_name] = {
                                'slurm_id': slurm_job_id,
                                'submit_time': datetime.now().isoformat(),
                                'partition': config.slurm_partition,
                                'last_status': 'PENDING',
                                'project_dir': str(self.project_dir),
                            }
                            self._save_slurm_jobs()

                        return slurm_job_id, None
                else:
                    error_msg = result.stderr.strip() or result.stdout.strip()
                    print(f"[JobManager] sbatch FAILED (rc={result.returncode}): {error_msg}", flush=True)
                    return None, f'SSH sbatch failed: {error_msg}'
            except Exception as e:
                print(f"[JobManager] Local sbatch failed: {e}")

        # Fallback: submit via SSH to compute node
        print(f"[JobManager] Submitting via SSH to compute node: {job_name}")
        return self._submit_via_ssh(script_path, job_name)

    def _check_slurm_status(self, slurm_job_id: str) -> str:
        """Check Slurm job status (uses proxy squeue if configured)."""
        squeue_cmd = self._find_squeue()
        try:
            # Check squeue first
            result = subprocess.run(
                [squeue_cmd, '-j', str(slurm_job_id), '-h', '-o', '%T'],
                capture_output=True,
                text=True,
                timeout=30
            )

            if result.returncode == 0 and result.stdout.strip():
                state = result.stdout.strip()
                if state in ['RUNNING', 'COMPLETING']:
                    return 'RUNNING'
                elif state in ['PENDING', 'CONFIGURING']:
                    return 'PENDING'
                return state

            # Check sacct for completed jobs (sacct may not be available via proxy)
            try:
                result = subprocess.run(
                    ['sacct', '-j', str(slurm_job_id), '-n', '-o', 'State', '-X'],
                    capture_output=True,
                    text=True,
                    timeout=30
                )

                if result.returncode == 0 and result.stdout.strip():
                    return result.stdout.strip().split()[0]
            except (subprocess.SubprocessError, OSError):
                pass

            return 'UNKNOWN'

        except (subprocess.SubprocessError, OSError) as e:
            print(f"Warning: Failed to check Slurm status for job {slurm_job_id}: {e}")
            return 'UNKNOWN'

    @staticmethod
    def _add_gpu_flags(cmd: List[str], params: Dict[str, Any]) -> None:
        """Append `--gpu <ids>` to cmd when GPU use is requested.

        Mutates cmd in place. Same pattern was previously copy-pasted
        at 3 sites for Class2D, Class3D/Refine3D, and InitialModel.
        """
        if params.get('use_gpu'):
            cmd.extend(['--gpu', str(params.get('gpu_ids', '0'))])

    @contextmanager
    def _pipeline_lock(self):
        """Serialize read-modify-write of default_pipeline.star.

        Local jobs (Import, ClassSelect) run RELION binaries with
        --pipeline_control, which makes RELION itself update
        default_pipeline.star. Two concurrent local submissions race on
        that file: each reads the pre-existing process table, appends
        its row, and writes back. The later writer clobbers the earlier
        writer's row, and Running -> Succeeded transitions get lost too.
        See FIX_LOG #80.

        We hold an exclusive flock on <project>/.pipeline.lock for the
        duration of the subprocess. Slurm jobs do not need this lock —
        their pipeline writes happen on compute nodes and serialize
        through Slurm's scheduling latency.
        """
        lock_file = self.project_dir / '.pipeline.lock'
        lock_file.touch(exist_ok=True)
        with open(lock_file, 'w') as f:
            try:
                fcntl.flock(f.fileno(), fcntl.LOCK_EX)
                yield
            finally:
                fcntl.flock(f.fileno(), fcntl.LOCK_UN)

    def _run_local(self, job_dir: Path, cmd: List[str], job_name: str) -> Dict[str, Any]:
        """Run job locally in a background thread.

        Returns immediately after spawning the thread. The thread grabs the
        pipeline lock (so concurrent jobs don't corrupt pipeline.star), runs
        the subprocess, and writes RELION's sentinel files on exit.
        get_job_status() reads those sentinels, so the frontend polls status
        the same way as Slurm jobs.
        """
        # RELION_JOB_RUNNING marks the job as active until the subprocess exits.
        # get_job_status() checks these sentinels first.
        (job_dir / 'RELION_JOB_RUNNING').touch()

        def _worker():
            proc = None
            try:
                with open(job_dir / 'run.out', 'w') as log_out, \
                     open(job_dir / 'run.err', 'w') as log_err:
                    log_out.write(f"Job started at: {datetime.now().isoformat()}\n")
                    log_out.write(f"Command: {' '.join(cmd)}\n\n")
                    log_out.flush()

                    with self._pipeline_lock():
                        proc = subprocess.Popen(
                            cmd,
                            cwd=str(self.project_dir),
                            stdout=log_out,
                            stderr=log_err,
                            start_new_session=True,  # own process group, for clean abort
                        )
                        # Register for abort support before waiting.
                        self._local_procs[job_name] = proc
                        rc = proc.wait()

                    log_out.write(f"\nJob finished at: {datetime.now().isoformat()}\n")
                    log_out.write(f"Exit code: {rc}\n")

                # Sentinel bookkeeping (RUNNING → SUCCESS/FAILURE/ABORT).
                (job_dir / 'RELION_JOB_RUNNING').unlink(missing_ok=True)
                if rc == 0:
                    (job_dir / 'RELION_JOB_EXIT_SUCCESS').touch()
                elif rc < 0:  # killed by signal (e.g. abort via SIGTERM)
                    (job_dir / 'RELION_JOB_ABORT').touch()
                    print(f"[JobManager] _run_local: {job_name} aborted (signal {-rc})", flush=True)
                else:
                    (job_dir / 'RELION_JOB_EXIT_FAILURE').touch()
                    print(f"[JobManager] _run_local: {job_name} failed (rc={rc}). See {job_dir}/run.err", flush=True)

            except Exception as e:
                (job_dir / 'RELION_JOB_RUNNING').unlink(missing_ok=True)
                (job_dir / 'RELION_JOB_EXIT_FAILURE').touch()
                print(f"[JobManager] _run_local: {job_name} raised {type(e).__name__}: {e}", flush=True)
            finally:
                self._local_procs.pop(job_name, None)

        thread = threading.Thread(target=_worker, name=f"relion-local-{job_name}", daemon=True)
        self._local_threads[job_name] = thread
        thread.start()
        return {'success': True, 'jobId': job_name}

    def _abort_local(self, job_name: str) -> bool:
        """SIGTERM a running local job. Returns True if the process was signalled."""
        proc = self._local_procs.get(job_name)
        if proc is None or proc.poll() is not None:
            return False
        try:
            # Kill the whole process group (start_new_session=True made one).
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            return True
        except (ProcessLookupError, PermissionError) as e:
            print(f"[JobManager] _abort_local: {job_name} killpg failed: {e}", flush=True)
            return False

    # DynaMight CLI uses dashes; the rest of RELION uses underscores.
    # Kept as a class attribute so it's introspectable from tests.
    DYNAMIGHT_PARAM_MAPPING = {
        'refinement_star': 'refinement-star-file',
        'initial_model': 'initial-model',
        'mask_file': 'mask-file',
        'n_gaussians': 'n-gaussians',
        'n_latent_dimensions': 'n-latent-dimensions',
        'n_epochs': 'n-epochs',
        'batch_size': 'batch-size',
        'initial_resolution': 'initial-resolution',
        'n_linear_layers': 'n-linear-layers',
        'n_neurons_per_layer': 'n-neurons-per-layer',
        'particle_diameter': 'particle-diameter',
        'gpu_id': 'gpu-id',
        'preload_images': 'preload-images',
    }

    def _build_jobtype_flags(self, job_type: str, params: Dict[str, Any], nr_mpi: int) -> List[str]:
        """Per-job-type RELION flag additions and auto-detected inputs.

        Returns a list of arguments to extend onto the cmd list. Covers the
        Class2D / Class3D / Refine3D / InitialModel / CtfFind / MotionRefine
        branches that previously sat as inline if/elif inside submit_job.
        """
        flags: List[str] = []

        if job_type == 'Class2D':
            flags.extend(['--flatten_solvent', '--dont_combine_weights_via_disc'])
        elif job_type in ('Class3D', 'Refine3D'):
            flags.extend(['--flatten_solvent', '--dont_combine_weights_via_disc'])
            if job_type == 'Refine3D':
                flags.append('--auto_refine')
                if nr_mpi > 1:
                    flags.append('--split_random_halves')
        elif job_type == 'InitialModel':
            flags.extend(['--grad', '--denovo_3dref', '--flatten_solvent',
                          '--zero_mask', '--dont_combine_weights_via_disc'])
        elif job_type == 'CtfFind':
            ctffind_exe = getattr(config, 'ctffind_executable', '/usr/local/bin/ctffind')
            flags.extend(['--ctffind_exe', ctffind_exe, '--is_ctffind4'])

        # GPU flag applies uniformly to the four GPU-capable types.
        if job_type in ('Class2D', 'Class3D', 'Refine3D', 'InitialModel'):
            self._add_gpu_flags(flags, params)

        # MotionRefine: auto-detect --corr_mic from the most recent MotionCorr
        # job if the caller didn't supply one. Filesystem read; cannot be a
        # pure function. Keeps using self.project_dir.
        if job_type == 'MotionRefine' and 'corr_mic' not in params:
            motioncorr_dir = self.project_dir / 'MotionCorr'
            if motioncorr_dir.exists():
                for mc_job_dir in sorted(motioncorr_dir.iterdir(), reverse=True):
                    corr_star = mc_job_dir / 'corrected_micrographs.star'
                    if corr_star.exists():
                        flags.extend(['--corr_mic', f'MotionCorr/{mc_job_dir.name}/'])
                        break

        return flags

    @staticmethod
    def _build_output_args(job_type: str, job_name: str, params: Dict[str, Any]) -> List[str]:
        """Per-job-type RELION output-flag dispatch.

        Each job type has a slightly different convention for telling the
        relion_* binary where to write its output. Keeping this in one
        focused method makes adding a new job type a one-line change.
        """
        if job_type == 'Import':
            return ['--odir', job_name + '/', '--ofile', 'movies.star']
        if job_type == 'AutoPick':
            return ['--odir', job_name + '/']
        if job_type == 'Extract':
            return ['--extract',
                    '--part_dir', job_name + '/',
                    '--part_star', job_name + '/particles.star']
        if job_type == 'PostProcess':
            args = ['--o', job_name + '/postprocess']
            # Auto-bfac unless the user pinned a specific value.
            if not params.get('adhoc_bfac') or params.get('adhoc_bfac') == 0:
                args.append('--auto_bfac')
            return args
        if job_type in ('CtfFind', 'MotionCorr'):
            return ['--o', job_name + '/']
        if job_type == 'MaskCreate':
            return ['--o', job_name + '/mask.mrc']
        if job_type == 'ClassSelect':
            return ['--o', job_name + '/particles.star']
        return ['--o', job_name + '/run']

    def _submit_dynamight(self, job_dir: Path, job_name: str,
                          params: Dict[str, Any], nr_threads: int) -> Dict[str, Any]:
        """Build + submit a DynaMight job (separate CLI tooling)."""
        cmd = ['dynamight', 'optimize-deformations']
        cmd.extend(['--output-directory', str(job_dir)])

        for key, value in params.items():
            if key.startswith('_') or value is None or value == '':
                continue
            cli_key = self.DYNAMIGHT_PARAM_MAPPING.get(key)
            if not cli_key:
                continue
            if isinstance(value, bool):
                cmd.append(f'--{cli_key}' if value else f'--no-{cli_key}')
            else:
                cmd.extend([f'--{cli_key}', str(value)])

        cmd.extend(['--pipeline-control', str(job_dir) + '/'])

        use_gpu_partition = params.get('use_gpu_partition', True)
        script_path = self._create_slurm_script(
            job_dir, cmd, job_name,
            nr_cpus=nr_threads if nr_threads > 1 else 4,
            memory_gb=16,
            time_hours=48,
            nr_mpi=1,
            job_type='DynaMight',
            use_gpu=use_gpu_partition,
        )

        slurm_id, error = self._submit_to_slurm(script_path, job_name)
        if error:
            shutil.rmtree(job_dir, ignore_errors=True)
            return {'success': False, 'error': error}
        return {'success': True, 'jobId': job_name, 'slurmId': slurm_id}

    def submit_job(self, job_type: str, params: Dict[str, Any],
                   mode: str = 'new') -> Dict[str, Any]:
        """Submit a job via Slurm (or locally for quick jobs)."""
        
        # Extract MPI/thread settings from params
        # Priority: user input (nr_mpi) > job template (_nrMpi) > default (1)
        nr_mpi = int(params.get('nr_mpi', params.get('_nrMpi', 1)))
        nr_threads = int(params.get('nr_threads', params.get('_nrThreads', 1)))

        # Single-process jobs must always use nr_mpi=1 (no _mpi binary variant exists)
        # This prevents _create_slurm_script from adding _mpi suffix or mpirun wrapper
        if job_type in SINGLE_PROCESS_JOBS and nr_mpi > 1:
            logger.info(f"{job_type} is single-process only, forcing nr_mpi=1 (was {nr_mpi})")
            nr_mpi = 1

        # RELION split-halves jobs need at least 3 MPI (1 leader + 1 per half)
        # Note: InitialModel uses --grad which is incompatible with MPI > 1
        if job_type in ('Refine3D', 'Class3D') and nr_mpi < 3:
            nr_mpi = 3
            logger.info(f"{job_type} requires ≥3 MPI for split random halves, adjusted to {nr_mpi}")

        # Get RELION command
        relion_cmd = JOB_TYPE_COMMANDS.get(job_type)
        if not relion_cmd:
            return {'success': False, 'error': f'Unknown job type: {job_type}'}
        
        # Create job directory
        job_num = self._get_next_job_number(job_type)
        job_name = f"{job_type}/job{job_num:03d}"
        job_dir = self.project_dir / job_name
        job_dir.mkdir(parents=True, exist_ok=True)

        # Prepare CC project directory before submission (creates dirs, symlinks input data).
        # Skip for LOCAL_JOBS — they run synchronously on OOD and never go to CC.
        # Creating empty CC stubs for them is what enabled the inflight-clobber bug
        # described in FIX_LOG #83 (the "empty real dir on CC" cured by Fix #75
        # could not actually arise once we stop creating those stubs).
        if self._is_cyclecloud() and job_type not in LOCAL_JOBS:
            if not self._prepare_cc_project_dir(job_name):
                shutil.rmtree(job_dir, ignore_errors=True)
                return {'success': False, 'error': 'Failed to prepare CycleCloud project directory'}

        try:

            # DynaMight has its own CLI shape; delegate the whole branch.
            if job_type == 'DynaMight':
                return self._submit_dynamight(job_dir, job_name, params, nr_threads)

            # Build command
            cmd = [config.get_relion_command(relion_cmd)]

            # Parameter mapping, meta-param skiplist, and Import-only optics
            # are module-level constants (PARAM_MAPPING, META_PARAMS,
            # IMPORT_ONLY_OPTICS). Use a local alias for readability inside
            # the loop without hiding the source.
            param_mapping = PARAM_MAPPING

            # Add parameters
            for key, value in params.items():
                if key.startswith('_') or value is None or value == '':
                    continue
                if key in META_PARAMS:
                    continue
                if job_type != 'Import' and key in IMPORT_ONLY_OPTICS:
                    continue

                # Skip MPI/thread params - these are handled separately for mpirun/SLURM
                if key in ['nr_mpi', 'nr_threads', 'nrMpi', 'nrThreads']:
                    continue

                # Skip angpix if -1 (means use header value)
                if key == 'angpix' and value == -1:
                    continue

                # Skip adhoc_bfac if 0 (means auto B-factor)
                if key == 'adhoc_bfac' and value == 0:
                    continue

                # Skip certain params handled separately
                if job_type in ['Class2D', 'Class3D', 'Refine3D', 'InitialModel']:
                    if key in ['use_gpu', 'gpu_ids']:
                        continue

                # ClassSelect special handling
                if job_type == 'ClassSelect':
                    # fn_data/fn_mic map to --i (input)
                    if key in ['fn_data', 'fn_mic']:
                        cmd_key = 'i'
                    else:
                        cmd_key = param_mapping.get(key, key)
                # CtfRefine special handling
                elif job_type == 'CtfRefine':
                    # do_ctf means fit per-particle defocus
                    if key == 'do_ctf':
                        cmd_key = 'fit_defocus'
                    else:
                        cmd_key = param_mapping.get(key, key)
                # PostProcess special handling
                elif job_type == 'PostProcess':
                    # fn_mask maps to --mask (not --solvent_mask)
                    if key == 'fn_mask':
                        cmd_key = 'mask'
                    else:
                        cmd_key = param_mapping.get(key, key)
                # MotionRefine (Bayesian Polishing) special handling
                elif job_type == 'MotionRefine':
                    # Skip do_polish - it's not a valid RELION flag (polishing is default behavior)
                    if key == 'do_polish':
                        continue
                    else:
                        cmd_key = param_mapping.get(key, key)
                elif job_type == 'MotionCorr':
                    # Handle do_own parameter - RELION 5 uses --use_own flag.
                    # Accept frontend RADIO ('RELION'/'MotionCor2') and SDK/MCP
                    # callers that may send a bool. Reject unknown values loudly
                    # so we don't silently produce an invalid command line
                    # (Fix #73: bare True used to skip both branches → RELION
                    # aborts with "must choose either UCSF MotionCor2 or own").
                    if key == 'do_own':
                        if value is True or (isinstance(value, str) and value.lower() == 'relion'):
                            cmd.append('--use_own')
                        elif value is False or (isinstance(value, str) and value.lower() == 'motioncor2'):
                            pass  # MotionCor2 is implicit (no flag)
                        else:
                            raise ValueError(
                                f"MotionCorr param 'do_own' must be 'RELION', 'MotionCor2', "
                                f"or bool — got {value!r} ({type(value).__name__})"
                            )
                        continue
                    else:
                        cmd_key = param_mapping.get(key, key)
                else:
                    # Map parameter name
                    cmd_key = param_mapping.get(key, key)
            
                if isinstance(value, bool):
                    if value:
                        cmd.append(f'--{cmd_key}')
                else:
                    # Sanitize parameter value to prevent command injection
                    str_value = sanitize_param_value(str(value), key)
                    # Convert absolute paths for file input parameters
                    # RELION requires: 1) relative paths, 2) inside project directory
                    if cmd_key == 'i' and str_value.startswith('/'):
                        project_str = str(self.project_dir)
                        if str_value.startswith(project_str + '/'):
                            # Path inside project - simple strip to make relative
                            str_value = str_value[len(project_str) + 1:]
                        else:
                            # Path outside project - create symlink inside project
                            external_path = Path(str_value)

                            # Handle glob patterns - get the directory part
                            if '*' in str_value:
                                pattern = external_path.name  # e.g., "*.tiff"
                                source_dir = str(external_path.parent)  # e.g., /shared/.../Movies
                                link_name = Path(source_dir).name  # e.g., "Movies"
                            else:
                                source_dir = str_value
                                link_name = external_path.name

                            # Create symlink in project root
                            # IMPORTANT: must NOT start with '_' — RELION STAR format
                            # treats any line starting with '_' as a column label definition
                            symlink_path = self.project_dir / f"external_{link_name}"
                            if not symlink_path.exists():
                                os.symlink(source_dir, symlink_path)

                            # Use symlink path (relative to project)
                            if '*' in str_value:
                                str_value = f"external_{link_name}/{pattern}"
                            else:
                                str_value = f"external_{link_name}"
                    cmd.extend([f'--{cmd_key}', str_value])
        
            # Job-type-specific flag additions (see _build_jobtype_flags)
            cmd.extend(self._build_jobtype_flags(job_type, params, nr_mpi))

            # Add output directory (per-job-type — see _build_output_args)
            cmd.extend(self._build_output_args(job_type, job_name, params))
        
            # Add threads (not for jobs that don't support it)
            # PostProcess, MaskCreate, LocalRes don't support --j
            if nr_threads > 1 and job_type not in ['AutoPick', 'Extract', 'ClassSelect', 'PostProcess', 'MaskCreate', 'LocalRes']:
                cmd.extend(['--j', str(nr_threads)])
        
            # Add pipeline control (not for utility jobs like ClassSelect)
            if job_type not in ['ClassSelect']:
                cmd.extend(['--pipeline_control', job_name + '/'])
        
            # Wrap with mpirun if needed (not for single-process jobs)
            # nr_mpi is already forced to 1 for SINGLE_PROCESS_JOBS in submit_job(),
            # but this check remains as a safety net for the local execution path
            if nr_mpi > 1 and job_type not in SINGLE_PROCESS_JOBS:
                # Use mpirun from same bin path as RELION commands
                mpirun_cmd = os.path.join(config.relion_bin_path, 'mpirun')
                if not os.path.exists(mpirun_cmd):
                    mpirun_cmd = 'mpirun'  # Fallback to system mpirun
                cmd = [mpirun_cmd, '--oversubscribe', '-np', str(nr_mpi)] + cmd

            # Wrap with singularity if container is configured (optional).
            # Bind mount(s) come from config.container_bind so customers can
            # set RELION_CONTAINER_BIND=/home:/home (or whatever paths their
            # users' data lives under) instead of being forced onto /shared.
            if hasattr(config, 'relion_container') and config.relion_container:
                singularity_bin = getattr(config, 'singularity_bin', 'singularity')
                bind = getattr(config, 'container_bind', '/shared:/shared')
                # container_bind may be comma-separated for multiple binds
                bind_args = []
                for one in bind.split(','):
                    one = one.strip()
                    if one:
                        bind_args.extend(['--bind', one])
                cmd = [singularity_bin, 'exec'] + bind_args + [config.relion_container] + cmd

            # Save run script
            run_script = job_dir / 'run.sh'
            with open(run_script, 'w') as f:
                f.write('#!/bin/bash\n')
                f.write(f'cd {self.project_dir}\n')
                f.write(' '.join(cmd) + '\n')
            run_script.chmod(0o755)
        
            # Run locally for quick jobs, or when execution_mode == 'local' (v0.3 Local variant)
            if job_type in LOCAL_JOBS or config.execution_mode == 'local':
                return self._run_local(job_dir, cmd, job_name)

            # Dynamic memory allocation based on job type
            # Memory-intensive jobs need more RAM
            MEMORY_BY_JOB_TYPE = {
                # High memory - 3D refinement, CTF fitting, motion correction
                'Refine3D': 8, 'Class3D': 8, 'CtfRefine': 8,
                'MotionCorr': 8, 'MotionRefine': 8, 'Polish': 8,
                # Medium memory - 2D classification, extraction, picking
                'Class2D': 6, 'Extract': 4, 'AutoPick': 4,
                'PostProcess': 4, 'LocalRes': 6, 'CtfFind': 4,
                # Low memory - simple operations
                'Import': 2, 'MaskCreate': 2, 'JoinStar': 2, 'ClassSelect': 2,
            }
            memory_gb = MEMORY_BY_JOB_TYPE.get(job_type, 6)  # Default 6GB

            # Scale memory with MPI processes (each process needs memory)
            if nr_mpi > 1:
                memory_gb = memory_gb * nr_mpi

            # Cap at node memory (CycleCloud htc nodes = Standard_D4ads_v6: 4 vCPU / 16GB RAM,
            # ~15GB Slurm-allocatable. Leave 1GB headroom.)
            MAX_MEMORY_GB = 14
            memory_gb = min(memory_gb, MAX_MEMORY_GB)

            # Create and submit Slurm script
            # nr_cpus = threads per MPI task (default 1 for pure MPI)
            # Check if GPU is requested (for RELION GPU jobs like Class2D, Class3D, Refine3D)
            use_gpu = params.get('use_gpu', False) and params.get('use_gpu_partition', False)

            script_path = self._create_slurm_script(
                job_dir, cmd, job_name,
                nr_cpus=nr_threads if nr_threads > 1 else 1,
                memory_gb=memory_gb,
                time_hours=48,
                nr_mpi=nr_mpi,
                job_type=job_type,
                use_gpu=use_gpu
            )
        
            slurm_id, error = self._submit_to_slurm(script_path, job_name)

            if error:
                # Clean up job directory on failure
                try:
                    shutil.rmtree(job_dir)
                except Exception:
                    pass
                return {'success': False, 'error': error}

            return {
                'success': True,
                'jobId': job_name,
                'slurmId': slurm_id
            }
        except Exception:
            # Clean up orphaned directory if Slurm submission never completed
            with self._lock:
                already_tracked = job_name in self.slurm_jobs
            if not already_tracked and job_dir.exists():
                shutil.rmtree(job_dir, ignore_errors=True)
            raise


    def _get_next_job_number(self, job_type: str) -> int:
        """Get next available job number."""
        job_type_dir = self.project_dir / job_type
        if not job_type_dir.exists():
            return 1
        
        max_num = 0
        for job_dir in job_type_dir.iterdir():
            if job_dir.is_dir() and job_dir.name.startswith('job'):
                try:
                    num = int(job_dir.name[3:])
                    max_num = max(max_num, num)
                except ValueError:
                    pass
        
        return max_num + 1

    def _is_cyclecloud(self) -> bool:
        """True when running on a cyclecloud-mode cluster.

        Customer beta deployments leave ``cluster_mode == "generic"``; the
        cluster_mode flag is the single source of truth. The legacy partition-
        name heuristic is kept only as a safety net for older configs that
        haven't been migrated.
        """
        if config.is_cyclecloud():
            return True
        # Legacy fallback for configs predating cluster_mode
        return (config.slurm_partition in ('htc', 'hpc', 'dynamic')
                and config.cc_scheduler_host is not None)

    def _is_cc_job(self, job_name: str) -> bool:
        """Check if a specific job was submitted to a CycleCloud partition.

        Generic (non-CycleCloud) clusters never need the CC sync path, so a
        cluster_mode != "cyclecloud" config always returns False here even if a
        job happened to be submitted to a partition named ``htc``.
        """
        if not self._is_cyclecloud():
            return False
        with self._lock:
            job_info = self.slurm_jobs.get(job_name, {})
            partition = job_info.get('partition', '')
        if partition:
            return partition in ('htc', 'hpc', 'dynamic')
        # Fallback for old jobs without partition field
        return True

    def _prepare_cc_project_dir(self, job_name: str) -> bool:
        """Prepare project directory on CC's /shared before job submission.

        On CycleCloud, compute nodes see CC's native /shared (100GB) and
        OOD's /shared at /sched-shared (NFS). Projects that only exist on
        OOD need a mirrored directory on CC's /shared with symlinks to
        input data on /sched-shared.

        Runs via SSH to CC scheduler (the account there owns /shared/home/$USER).
        Called BEFORE sbatch submission so failures abort cleanly.

        Foolproof guarantees (FIX_LOG #83):
        - Never replaces an existing real directory with a symlink. The
          previous "empty real dir → symlink to OOD" branch was racy: a
          freshly-mkdir'd job dir for an inflight CC job is also empty
          until the compute node starts writing, and a sibling submission's
          prep would clobber it.
        - Builds an explicit `protected_paths` set from `self.slurm_jobs`
          plus the current `job_name`, and the setup_script skips any
          sub-dir whose absolute path is in that set — defense in depth
          against a future heuristic re-introducing the same bug.
        - Verifies at the end that `<JOB_TYPE>/<JOB_DIR>` is a real
          writable directory (not a symlink, not missing). If not, exits
          with a loud FATAL message and prep returns False so submit_job
          aborts before sbatch is called.
        - Uses `install -d` for the final job dir so creation is explicit
          about mode regardless of parent setgid state.
        """
        cc_host = config.cc_scheduler_host
        cc_user = config.cc_scheduler_user
        if not cc_host:
            return True  # Not a CC setup

        proj = str(self.project_dir)
        sched_proj = proj.replace('/shared/', '/sched-shared/', 1)
        job_type = job_name.split('/')[0]
        job_dir_name = job_name.split('/')[-1]  # e.g. "job045"

        # Build the protected-paths set: every job we believe is currently
        # active on CC (any state that could mean its job_dir is in flight),
        # plus the current job. The setup_script will refuse to touch any
        # path in this set, even via the safe symlink-creation branches.
        protected: List[str] = [f"{proj}/{job_name}"]
        with self._lock:
            for tracked_id, info in self.slurm_jobs.items():
                state = (info or {}).get('state', '')
                # Slurm RELION states: SCHEDULED=PD, RUNNING=R, COMPLETING=CG, etc.
                # We protect anything not in a known terminal state.
                if state in ('FINISHED', 'FAILED', 'ABORTED', 'CANCELLED', 'TIMEOUT'):
                    continue
                tracked_dir = (info or {}).get('project_dir', proj)
                protected.append(f"{tracked_dir}/{tracked_id}")

        # Encode as a bash-safe newline-separated heredoc the script reads
        # into an associative array. Quote each path with shlex for safety.
        protected_block = '\n'.join(shlex.quote(p) for p in protected)

        setup_script = f'''set -e
CC_PROJ={shlex.quote(proj)}
SCHED_PROJ={shlex.quote(sched_proj)}
JOB_TYPE={shlex.quote(job_type)}
JOB_DIR={shlex.quote(job_dir_name)}

# Build PROTECTED set of absolute paths the script must not touch (symlink
# / rmdir / refresh / replace). See FIX_LOG #83.
declare -A PROTECTED
while IFS= read -r p; do
    [ -z "$p" ] && continue
    PROTECTED["$p"]=1
done <<'PROTECTED_LIST_EOF'
{protected_block}
PROTECTED_LIST_EOF

is_protected() {{
    [ -n "${{PROTECTED[$1]:-}}" ]
}}

mkdir -p "$CC_PROJ"

# Link input data from OOD NFS for RELION relative path resolution.
# Three cases per top-level OOD item:
#   1. Missing on CC → symlink the whole tree
#   2. Already a symlink on CC → refresh
#   3. Real dir on CC (from prior CC job of that type) → recurse one level
#      and ONLY symlink missing sub-job-dirs (no replace-with-symlink).
if [ -d "$SCHED_PROJ" ]; then
    for item in "$SCHED_PROJ"/*; do
        # Skip only if neither a symlink nor an existing item. The `-e` test
        # dereferences symlinks, so a `/shared/...` symlink that is broken
        # from CC's local view (Fix #77's exact target case) would otherwise
        # be skipped before reaching the rewrite block below.
        [ ! -L "$item" ] && [ ! -e "$item" ] && continue
        bn=$(basename "$item")
        cc_target="$CC_PROJ/$bn"
        # Fix #77: rewrite OOD-side absolute /shared/ symlinks to /sched-shared/
        link_target=""
        if [ -L "$item" ]; then
            link_target=$(readlink "$item")
        fi
        if [ -n "$link_target" ] && [ "${{link_target:0:8}}" = "/shared/" ]; then
            is_protected "$cc_target" && continue
            ln -sfn "/sched-shared/${{link_target:8}}" "$cc_target"
            continue
        fi
        if [ ! -e "$cc_target" ]; then
            is_protected "$cc_target" && continue
            ln -sfn "$item" "$cc_target"
        elif [ -L "$cc_target" ]; then
            is_protected "$cc_target" && continue
            ln -sfn "$item" "$cc_target"  # refresh, target may have moved
        elif [ -d "$cc_target" ] && [ -d "$item" ] && [ "$bn" != "$JOB_TYPE" ]; then
            # Real dir on CC for a non-current job type — only fill MISSING sub-dirs.
            # FIX_LOG #83: the previous "empty real dir → replace with symlink"
            # branch raced with inflight CC jobs; it has been removed.
            for sub in "$item"/*; do
                [ -d "$sub" ] || continue
                sbn=$(basename "$sub")
                cc_sub="$cc_target/$sbn"
                is_protected "$cc_sub" && continue
                if [ ! -e "$cc_sub" ]; then
                    ln -sfn "$sub" "$cc_sub"
                fi
            done
        fi
    done
fi

# Job type dir must be a real, writable directory (not a symlink to read-only
# OOD NFS). We never touch it if it's already real.
if [ -L "$CC_PROJ/$JOB_TYPE" ]; then
    rm -f "$CC_PROJ/$JOB_TYPE"
    install -d -m 0775 "$CC_PROJ/$JOB_TYPE"
    if [ -d "$SCHED_PROJ/$JOB_TYPE" ]; then
        for d in "$SCHED_PROJ/$JOB_TYPE"/*/; do
            [ -d "$d" ] || continue
            dn=$(basename "$d")
            # Skip current job dir — it must be writable, not a symlink to OOD
            [ "$dn" = "$JOB_DIR" ] && continue
            cc_sub="$CC_PROJ/$JOB_TYPE/$dn"
            is_protected "$cc_sub" && continue
            ln -sfn "$d" "$cc_sub"
        done
    fi
elif [ ! -d "$CC_PROJ/$JOB_TYPE" ]; then
    install -d -m 0775 "$CC_PROJ/$JOB_TYPE"
fi

# Ensure current job dir is a real, writable directory.
if [ -L "$CC_PROJ/$JOB_TYPE/$JOB_DIR" ]; then
    rm -f "$CC_PROJ/$JOB_TYPE/$JOB_DIR"
fi
install -d -m 0775 "$CC_PROJ/$JOB_TYPE/$JOB_DIR"

# Verify-or-fail: refuse to return success unless the job dir is a real,
# writable, non-symlink directory. Catches any future regression that
# could leave it as a symlink, missing, or read-only.
target="$CC_PROJ/$JOB_TYPE/$JOB_DIR"
if [ -L "$target" ] || [ ! -d "$target" ] || [ ! -w "$target" ]; then
    echo "FATAL: CC job dir is not a real writable directory: $target" >&2
    stat "$target" >&2 2>/dev/null || true
    exit 3
fi
'''
        try:
            result = subprocess.run(
                ['ssh', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=no',
                 '-o', 'BatchMode=yes', f'{cc_user}@{cc_host}', 'bash -s'],
                input=setup_script, capture_output=True, text=True, timeout=30
            )
            if result.returncode != 0:
                err = (result.stderr or result.stdout or '').strip()
                print(f"[JobManager] CC project prep FAILED for {job_name} (rc={result.returncode}): {err}", flush=True)
                return False
            logger.info(f"CC project dir prepared for {job_name}")
            return True
        except subprocess.TimeoutExpired:
            print(f"[JobManager] CC project prep TIMEOUT for {job_name} (>30s)", flush=True)
            return False
        except (subprocess.SubprocessError, OSError) as e:
            print(f"[JobManager] CC project prep ERROR for {job_name}: {type(e).__name__}: {e}", flush=True)
            return False

    def _sync_job_from_cc(self, job_name: str) -> bool:
        """Sync job outputs from CycleCloud's /shared to OOD's /shared.

        On CycleCloud, compute nodes write to CC's native /shared volume.
        OOD has a separate /shared. Since UID mismatch prevents CC→OOD NFS
        writes, OOD must pull results via SSH to the CC scheduler.

        Called by the background JobStatusMonitor, NOT from API requests.

        Returns True if new files were synced.
        """
        cc_host = config.cc_scheduler_host
        cc_user = config.cc_scheduler_user
        if not cc_host:
            return False

        job_dir = self.project_dir / job_name
        # Use stored project_dir from job tracking (handles project switches)
        with self._lock:
            job_info = self.slurm_jobs.get(job_name, {})
        stored_dir = job_info.get('project_dir', str(self.project_dir))
        cc_job_path = f'{stored_dir}/{job_name}'

        try:
            # Quick check: does CC have files we don't have locally?
            result = subprocess.run(
                ['ssh', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=no',
                 '-o', 'BatchMode=yes',
                 f'{cc_user}@{cc_host}',
                 f'ls {cc_job_path}/RELION_JOB_EXIT_SUCCESS {cc_job_path}/RELION_JOB_EXIT_FAILURE {cc_job_path}/RELION_JOB_RUNNING 2>/dev/null; echo "---"; ls {cc_job_path}/*.star {cc_job_path}/*.out 2>/dev/null | head -5'],
                capture_output=True, text=True, timeout=15
            )

            if result.returncode != 0 and not result.stdout.strip():
                return False

            cc_files = result.stdout.strip()
            if not cc_files or cc_files == '---':
                return False

            # CC has files — rsync contents to local job dir
            job_dir.mkdir(parents=True, exist_ok=True)

            sync_result = subprocess.run(
                ['rsync', '-az', '--timeout=30',
                 '-e', 'ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes',
                 f'{cc_user}@{cc_host}:{cc_job_path}/',
                 str(job_dir) + '/'],
                capture_output=True, text=True, timeout=120
            )

            if sync_result.returncode == 0:
                logger.info(f"Synced job {job_name} from CC ({cc_host})")
                return True
            else:
                err = (sync_result.stderr or sync_result.stdout or '').strip()
                print(f"[JobManager] CC sync FAILED for {job_name} (rc={sync_result.returncode}): {err}", flush=True)

        except subprocess.TimeoutExpired:
            print(f"[JobManager] CC sync TIMEOUT for {job_name} (>120s)", flush=True)
        except (subprocess.SubprocessError, OSError) as e:
            print(f"[JobManager] CC sync ERROR for {job_name}: {type(e).__name__}: {e}", flush=True)

        return False

    def get_job_status(self, job_name: str) -> Dict[str, Any]:
        """Get job status from LOCAL files and Slurm query only.

        This method is called on every frontend poll (5s interval),
        so it must be fast. No SSH or rsync — those happen in the
        background JobStatusMonitor thread.
        """
        job_dir = self.project_dir / job_name

        if not job_dir.exists():
            return {'error': 'Job not found'}

        # Check marker files first (most reliable)
        if (job_dir / 'RELION_JOB_EXIT_SUCCESS').exists():
            return {'status': STATUS_FINISHED, 'running': False}
        elif (job_dir / 'RELION_JOB_EXIT_FAILURE').exists():
            return {'status': STATUS_FAILED, 'running': False}
        elif (job_dir / 'RELION_JOB_EXIT_ABORTED').exists() or (job_dir / 'RELION_JOB_ABORT').exists():
            return {'status': STATUS_ABORTED, 'running': False}
        elif (job_dir / 'RELION_JOB_RUNNING').exists():
            return {'status': STATUS_RUNNING, 'running': True}

        # Check Slurm status (proxy squeue — fast, <1s)
        slurm_state = None
        slurm_id = None
        with self._lock:
            if job_name in self.slurm_jobs:
                slurm_id = self.slurm_jobs[job_name].get('slurm_id')
                if slurm_id:
                    slurm_state = self._check_slurm_status(slurm_id)

        if slurm_state:
            if slurm_state == 'RUNNING':
                return {'status': STATUS_RUNNING, 'running': True, 'slurmId': slurm_id}
            elif slurm_state == 'PENDING':
                return {'status': STATUS_SCHEDULED, 'running': False, 'slurmId': slurm_id}
            elif slurm_state in ['COMPLETED']:
                # Slurm says done but no local marker yet — background
                # monitor will sync files. Report finished optimistically.
                return {'status': STATUS_FINISHED, 'running': False}
            elif slurm_state in ['FAILED', 'TIMEOUT', 'NODE_FAIL']:
                return {'status': STATUS_FAILED, 'running': False}
            elif slurm_state in ['CANCELLED']:
                return {'status': STATUS_ABORTED, 'running': False}

        # Check if run.out exists but job is not tracked
        if (job_dir / 'run.out').exists():
            return {'status': STATUS_FAILED, 'running': False}

        # Not in Slurm tracking → ghost directory from failed submission
        with self._lock:
            in_slurm_tracking = job_name in self.slurm_jobs
        if not in_slurm_tracking:
            return {'status': STATUS_FAILED, 'running': False}

        # Submitted but state unknown (Slurm may have restarted)
        return {'status': STATUS_SCHEDULED, 'running': False}

    def abort_job(self, job_name: str) -> Dict[str, Any]:
        """Abort a running or queued job via the configured scancel command."""
        job_dir = self.project_dir / job_name
        if not job_dir.exists():
            return {'success': False, 'error': 'Job not found'}

        cancel_attempted = False
        cancel_ok = False
        cancel_error = None

        with self._lock:
            slurm_id = (self.slurm_jobs.get(job_name) or {}).get('slurm_id')

        if slurm_id:
            scancel_cmd = self._find_scancel()
            try:
                result = subprocess.run(
                    [scancel_cmd, str(slurm_id)],
                    capture_output=True, text=True, timeout=30,
                )
                cancel_attempted = True
                cancel_ok = result.returncode == 0
                if not cancel_ok:
                    cancel_error = (result.stderr or result.stdout or '').strip()
                    print(f"[JobManager] scancel FAILED for {slurm_id} "
                          f"(rc={result.returncode}): {cancel_error}", flush=True)
                else:
                    logger.info(f"Cancelled SLURM job {slurm_id} for {job_name}")
            except Exception as e:
                cancel_error = str(e)
                print(f"[JobManager] scancel raised for {slurm_id}: {e}", flush=True)

        # Local markers regardless, so the UI / pipeline.star flip to Aborted
        (job_dir / 'RELION_JOB_ABORT').touch()
        running_marker = job_dir / 'RELION_JOB_RUNNING'
        if running_marker.exists():
            running_marker.unlink()

        if not slurm_id:
            return {'success': True, 'note': 'no slurm_id tracked; local markers updated'}
        if cancel_attempted and cancel_ok:
            return {'success': True, 'slurm_id': slurm_id}
        return {
            'success': False,
            'slurm_id': slurm_id,
            'error': cancel_error or 'scancel did not succeed',
        }

    def get_all_jobs(self) -> List[Dict[str, Any]]:
        """Get all jobs from disk."""
        jobs = []
        
        for job_type_dir in self.project_dir.iterdir():
            if not job_type_dir.is_dir() or job_type_dir.name.startswith('.'):
                continue
            if job_type_dir.name not in JOB_TYPE_COMMANDS:
                continue
            
            for job_dir in sorted(job_type_dir.iterdir()):
                if not job_dir.is_dir() or not job_dir.name.startswith('job'):
                    continue
                
                job_name = f"{job_type_dir.name}/{job_dir.name}"
                status_info = self.get_job_status(job_name)
                status = status_info.get('status', STATUS_SCHEDULED)
                
                jobs.append({
                    'id': job_name,
                    'name': job_dir.name,
                    'alias': '',
                    'type': job_type_dir.name,
                    'status': status,
                    'inputNodes': [],
                    'outputNodes': [],
                })
        
        return jobs

    def get_job_log(self, job_name: str, log_type: str = 'out', tail: int = 100) -> str:
        """Get job log content."""
        job_dir = self.project_dir / job_name
        log_file = job_dir / f'run.{log_type}'
        
        if not log_file.exists():
            return ''
        
        with open(log_file, 'r') as f:
            lines = f.readlines()
        
        if tail > 0:
            lines = lines[-tail:]
        
        return ''.join(lines)

    def cleanup_job(self, job_name: str) -> Dict[str, Any]:
        """Clean up intermediate job files."""
        job_dir = self.project_dir / job_name
        
        if not job_dir.exists():
            return {'success': False, 'error': 'Job not found'}
        
        # Remove intermediate files
        patterns = ['*_tmp.mrcs', '*_debug.mrc', '*_body*.mrc']
        for pattern in patterns:
            for f in job_dir.glob(pattern):
                try:
                    f.unlink()
                except OSError as e:
                    print(f"Warning: Failed to remove {f}: {e}")
        
        return {'success': True}

    def delete_job(self, job_name: str) -> Dict[str, Any]:
        """Delete a job: cancel if running, remove tracking, scrub pipeline
        references, then delete the directory if it still exists.

        Tolerates ghost jobs whose directory has already been cleaned up but
        whose entries remain in default_pipeline.star (typical for jobs that
        failed during submission). Without this, the dashboard would show
        un-deletable ghost rows.
        """
        job_dir = self.project_dir / job_name

        # Cancel if running (no-op if not tracked).
        try:
            self.abort_job(job_name)
        except Exception:
            pass

        # Drop from in-memory + on-disk tracking.
        with self._lock:
            if job_name in self.slurm_jobs:
                del self.slurm_jobs[job_name]
                self._save_slurm_jobs()

        # Strip all references from default_pipeline.star so the dashboard
        # stops listing the job. Safe to run on jobs that aren't there.
        pipeline_warning = self._remove_job_from_pipeline_star(job_name)

        # Delete directory if it still exists.
        if job_dir.exists():
            try:
                shutil.rmtree(job_dir)
            except Exception as e:
                return {'success': False, 'error': str(e)}

        result: Dict[str, Any] = {'success': True}
        if pipeline_warning:
            result['warning'] = pipeline_warning
        return result

    def _remove_job_from_pipeline_star(self, job_name: str) -> Optional[str]:
        """Strip rows that reference ``job_name`` from default_pipeline.star.

        Matches any line containing the exact prefix ``"<job_name>/"`` — this
        catches process rows, node rows, and edge rows in one pass without
        clobbering jobs that merely share a prefix (e.g., job004 vs job0040).
        Returns a warning string if the file exists but couldn't be rewritten;
        returns None on success (including the "no pipeline file" no-op).
        """
        pipeline_file = self.project_dir / 'default_pipeline.star'
        if not pipeline_file.exists():
            return None
        try:
            original = pipeline_file.read_text()
        except Exception as e:
            return f'Could not read default_pipeline.star: {e}'

        token = f'{job_name}/'
        kept = [ln for ln in original.splitlines() if token not in ln]
        if len(kept) == len(original.splitlines()):
            return None  # Nothing to do.

        new_text = '\n'.join(kept)
        if original.endswith('\n'):
            new_text += '\n'
        try:
            pipeline_file.write_text(new_text)
        except Exception as e:
            return f'Could not write default_pipeline.star: {e}'
        return None

    def get_job_template(self, job_type: str) -> Dict[str, Any]:
        """Get default parameters for a job type."""
        templates = {
            'Import': {
                'jobType': 'Import',
                'params': {
                    'fn_in_raw': '',
                    'node_type': 'Movies',
                    'optics_group_name': 'opticsGroup1',
                    'voltage': 300,
                    'Cs': 2.7,
                    'Q0': 0.1,
                    'angpix': 1.0,
                }
            },
            'Class2D': {
                'jobType': 'Class2D',
                'params': {
                    'fn_in': '',
                    'nr_classes': 50,
                    'nr_iter': 25,
                    'tau_fudge': 2,
                    'particle_diameter': 200,
                    'do_ctf': True,
                    'do_zero_mask': True,
                    'highres_limit': -1,
                    'psi_sampling': 10,
                    'offset_range': 5,
                    'offset_step': 2,
                    'use_gpu': False,
                    'gpu_ids': '0',
                }
            },
        }
        
        return templates.get(job_type, {'jobType': job_type, 'params': {}})

    # ============================================================
    # Error Recovery & Checkpoint Methods
    # ============================================================

    def get_job_checkpoint(self, job_name: str) -> Dict[str, Any]:
        """
        Detect available checkpoints for a job.

        RELION iterative jobs write checkpoint files (run_it*_data.star)
        that allow continuation using the --continue flag.

        Returns:
            has_checkpoint: Whether checkpoint files exist
            last_iteration: The last completed iteration number
            checkpoint_files: List of checkpoint files found
            can_continue: Whether the job can be continued
            continue_command: The RELION --continue command if applicable
        """
        job_dir = self.project_dir / job_name

        if not job_dir.exists():
            return {'error': f'Job not found: {job_name}', 'has_checkpoint': False}

        job_type = job_name.split('/')[0]

        # Job types that support --continue
        CONTINUABLE_TYPES = {
            'Class2D', 'Class3D', 'Refine3D', 'CtfRefine', 'Polish',
            'InitialModel', 'MultiBody', 'TomoSubtomo',
        }

        result = {
            'job_id': job_name,
            'job_type': job_type,
            'has_checkpoint': False,
            'last_iteration': None,
            'checkpoint_files': [],
            'can_continue': False,
            'continue_command': None,
        }

        if job_type not in CONTINUABLE_TYPES:
            result['message'] = f'{job_type} does not support --continue'
            return result

        # Look for iteration checkpoint files
        checkpoint_patterns = [
            'run_it*_data.star',      # Class2D, Class3D, Refine3D
            'run_it*_optimiser.star',  # Backup optimiser state
            'run_ct*_data.star',      # CtfRefine
            'run_model.star',         # Final model (can continue from this too)
        ]

        checkpoints = []
        for pattern in checkpoint_patterns:
            checkpoints.extend(job_dir.glob(pattern))

        if not checkpoints:
            result['message'] = 'No checkpoint files found'
            return result

        result['has_checkpoint'] = True
        result['checkpoint_files'] = sorted([f.name for f in checkpoints])

        # Find the latest iteration number
        import re
        iterations = []
        for f in checkpoints:
            match = re.search(r'_it(\d+)_', f.name)
            if match:
                iterations.append(int(match.group(1)))
            match = re.search(r'_ct(\d+)_', f.name)
            if match:
                iterations.append(int(match.group(1)))

        if iterations:
            result['last_iteration'] = max(iterations)
            last_iter_file = f'run_it{result["last_iteration"]:03d}_optimiser.star'
        else:
            # Fallback to run_model.star or last checkpoint
            last_iter_file = 'run_model.star' if (job_dir / 'run_model.star').exists() else result['checkpoint_files'][-1]

        # Check if there's an optimiser file (required for --continue)
        optimiser_files = list(job_dir.glob('run_*_optimiser.star'))
        if optimiser_files:
            result['can_continue'] = True
            latest_opt = sorted(optimiser_files)[-1]
            result['continue_command'] = f'--continue {job_name}/{latest_opt.name}'
        else:
            result['message'] = 'No optimiser file found (required for --continue)'

        return result

    def continue_job(
        self,
        job_name: str,
        from_iteration: int = None,
        nr_mpi: int = 1,
        nr_threads: int = 1
    ) -> Dict[str, Any]:
        """
        Continue a failed/aborted job from checkpoint.

        Uses RELION's --continue flag to resume iterative jobs.

        Args:
            job_name: Job identifier (e.g., 'Refine3D/job025')
            from_iteration: Optional iteration to continue from. Defaults to last checkpoint.
            nr_mpi: Number of MPI processes
            nr_threads: Number of threads per MPI process

        Returns:
            success: Whether continuation was submitted
            jobId: The job ID
            slurmId: New Slurm job ID
            continued_from: Iteration continued from
        """
        checkpoint_info = self.get_job_checkpoint(job_name)

        if not checkpoint_info.get('can_continue'):
            return {
                'success': False,
                'error': checkpoint_info.get('message', 'Cannot continue this job'),
                'checkpoint_info': checkpoint_info,
            }

        job_dir = self.project_dir / job_name
        job_type = job_name.split('/')[0]

        # Find the optimiser file to continue from
        if from_iteration is not None:
            opt_file = job_dir / f'run_it{from_iteration:03d}_optimiser.star'
            if not opt_file.exists():
                # Try CtfRefine format
                opt_file = job_dir / f'run_ct{from_iteration}_optimiser.star'
            if not opt_file.exists():
                return {'success': False, 'error': f'No optimiser file for iteration {from_iteration}'}
        else:
            # Use latest optimiser
            opt_files = sorted(job_dir.glob('run_*_optimiser.star'))
            if not opt_files:
                return {'success': False, 'error': 'No optimiser file found'}
            opt_file = opt_files[-1]

        # Read original parameters from job note or run.job file
        run_job_file = job_dir / 'run.job'
        original_params = {}
        if run_job_file.exists():
            # Parse the run.job file (RELION's job parameter file)
            content = run_job_file.read_text()
            for line in content.split('\n'):
                if ' == ' in line:
                    key, val = line.split(' == ', 1)
                    original_params[key.strip()] = val.strip()

        # Build continue command
        continue_param = f'--continue {opt_file.name}'

        # Create a new submit.sh with --continue flag
        submit_script = job_dir / 'submit.sh'
        if not submit_script.exists():
            return {'success': False, 'error': 'No submit.sh found in job directory'}

        # Read and modify the existing submit script
        script_content = submit_script.read_text()

        # Replace job name for Slurm (add _cont suffix)
        import re
        script_content = re.sub(
            r'#SBATCH --job-name=(\S+)',
            lambda m: f'#SBATCH --job-name={m.group(1)}_cont',
            script_content
        )

        # Add --continue flag to RELION command
        # Find the relion command line and append --continue
        command_name = JOB_TYPE_COMMANDS.get(job_type, '')
        if command_name and command_name in script_content:
            # Insert --continue before any trailing backslash or newline
            script_content = re.sub(
                rf'({command_name}\s+[^\n]+)',
                lambda m: m.group(1).rstrip(' \\') + f' {continue_param}',
                script_content,
                count=1
            )

        # Write the modified script
        continue_script = job_dir / 'submit_continue.sh'
        continue_script.write_text(script_content)
        continue_script.chmod(0o755)

        # Submit via sbatch
        result = subprocess.run(
            ['ssh', '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes',
             SSH_HOST, f'{SBATCH_WRAPPER} {job_dir}/submit_continue.sh'],
            capture_output=True, text=True, timeout=30
        )

        if result.returncode != 0:
            error_msg = result.stderr.strip() or result.stdout.strip()
            print(f"[JobManager] continue_job sbatch FAILED: {error_msg}", flush=True)
            return {'success': False, 'error': f'Slurm submission failed: {error_msg}'}

        # Parse Slurm job ID
        slurm_id = None
        for line in result.stdout.split('\n'):
            if 'Submitted batch job' in line:
                parts = line.strip().split()
                if parts:
                    slurm_id = parts[-1]
                    break

        # Update tracking
        with self._lock:
            self.slurm_jobs[job_name] = {
                'slurm_id': slurm_id,
                'status': STATUS_RUNNING,
                'submitted': datetime.now().isoformat(),
                'continued_from': str(opt_file.name),
            }
            self._save_slurm_jobs()

        return {
            'success': True,
            'jobId': job_name,
            'slurmId': slurm_id,
            'continued_from': str(opt_file.name),
            'message': f'Continued from {opt_file.name}',
        }

    def _detect_spot_eviction(self, job_name: str) -> bool:
        """
        Check if a job failed due to Azure spot VM preemption.

        Signs of spot eviction:
        - SIGTERM in stderr (graceful termination signal)
        - No RELION-specific error messages
        - Sudden termination mid-iteration
        - Node failure messages in Slurm

        Args:
            job_name: Job identifier

        Returns: True if eviction detected, False otherwise
        """
        job_dir = self.project_dir / job_name

        # Check stderr for SIGTERM
        stderr_file = job_dir / 'run.err'
        if stderr_file.exists():
            content = stderr_file.read_text().lower()
            sigterm_indicators = [
                'sigterm',
                'signal 15',
                'terminated',
                'preempt',
                'evict',
                'node_fail',
            ]
            for indicator in sigterm_indicators:
                if indicator in content:
                    return True

        # Check stdout for sudden termination (incomplete iteration)
        stdout_file = job_dir / 'run.out'
        if stdout_file.exists():
            content = stdout_file.read_text()
            lines = content.strip().split('\n')
            if lines:
                last_line = lines[-1].lower()
                # If last line is mid-iteration (not "done" or "finished")
                if 'iteration' in last_line and 'done' not in last_line and 'finished' not in last_line:
                    return True

        # Check Slurm state for node failure
        with self._lock:
            job_info = self.slurm_jobs.get(job_name, {})
            last_state = job_info.get('last_slurm_state', '')
            if last_state in ['NODE_FAIL', 'PREEMPTED', 'TIMEOUT']:
                return True

        return False


# Create global instance
class JobStatusMonitor:
    """Background thread that monitors active Slurm jobs and syncs CC results.

    Runs every 30 seconds. For each non-terminal job in .slurm_jobs.json:
      1. Query Slurm state via proxy squeue
      2. If CC job transitions to terminal: sync results via _sync_job_from_cc()
      3. Update pipeline STAR file via update_process_status()
      4. Persist last_status in .slurm_jobs.json to avoid re-processing
    """

    TERMINAL_STATES = {'COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT', 'NODE_FAIL'}
    CHECK_INTERVAL = 30  # seconds

    # Map integer status to STAR file status string
    STATUS_TO_STAR = {
        STATUS_FINISHED: 'Succeeded',
        STATUS_FAILED: 'Failed',
        STATUS_ABORTED: 'Aborted',
        STATUS_RUNNING: 'Running',
        STATUS_SCHEDULED: 'Scheduled',
    }

    def __init__(self, job_manager: JobManager, project_dir: str):
        self._jm = job_manager
        self._project_dir = project_dir
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

    def start(self):
        """Start the monitor daemon thread."""
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._run_loop,
            name='job-status-monitor',
            daemon=True
        )
        self._thread.start()
        logger.info("JobStatusMonitor started (interval=%ds)", self.CHECK_INTERVAL)

    def stop(self):
        """Signal the monitor thread to stop."""
        self._stop_event.set()

    def _run_loop(self):
        """Main monitoring loop."""
        while not self._stop_event.is_set():
            try:
                self._check_all_active_jobs()
            except Exception as e:
                logger.error(f"JobStatusMonitor error: {e}")
            # Sleep in 1-second increments for responsive shutdown
            for _ in range(self.CHECK_INTERVAL):
                if self._stop_event.is_set():
                    return
                time.sleep(1)

    def _check_all_active_jobs(self):
        """Check all non-terminal jobs and sync/update as needed."""
        from star_parser import update_process_status

        # Snapshot active jobs
        with self._jm._lock:
            jobs_snapshot = dict(self._jm.slurm_jobs)

        changed = False
        for job_name, job_info in jobs_snapshot.items():
            last_status = job_info.get('last_status', '')
            if last_status in self.TERMINAL_STATES:
                continue  # Already processed

            slurm_id = job_info.get('slurm_id')
            if not slurm_id:
                continue

            # Query current Slurm state
            try:
                slurm_state = self._jm._check_slurm_status(slurm_id)
            except Exception:
                continue

            if not slurm_state:
                continue  # Query failed entirely

            # For known states, skip if unchanged (but always process UNKNOWN)
            if slurm_state == last_status and slurm_state != 'UNKNOWN':
                continue

            is_cc = self._jm._is_cc_job(job_name)
            job_dir = self._jm.project_dir / job_name
            new_int_status = None

            if slurm_state in self.TERMINAL_STATES:
                # Job reached terminal state — sync from CC if needed
                if is_cc:
                    try:
                        self._jm._sync_job_from_cc(job_name)
                    except Exception as e:
                        logger.warning(f"Monitor: CC sync failed for {job_name}: {e}")

                # Determine final status from marker files
                if (job_dir / 'RELION_JOB_EXIT_SUCCESS').exists():
                    new_int_status = STATUS_FINISHED
                elif (job_dir / 'RELION_JOB_EXIT_FAILURE').exists():
                    new_int_status = STATUS_FAILED
                elif slurm_state == 'CANCELLED':
                    new_int_status = STATUS_ABORTED
                elif slurm_state == 'COMPLETED':
                    new_int_status = STATUS_FINISHED
                else:
                    new_int_status = STATUS_FAILED

            elif slurm_state == 'UNKNOWN':
                # Job not in squeue and sacct unavailable (common with CC proxy).
                # For previously RUNNING CC jobs, sync results and check markers.
                if is_cc and last_status in ('RUNNING', 'PENDING', 'UNKNOWN'):
                    try:
                        self._jm._sync_job_from_cc(job_name)
                    except Exception:
                        pass

                # Check marker files to determine real status
                if (job_dir / 'RELION_JOB_EXIT_SUCCESS').exists():
                    new_int_status = STATUS_FINISHED
                    slurm_state = 'COMPLETED'
                elif (job_dir / 'RELION_JOB_EXIT_FAILURE').exists():
                    new_int_status = STATUS_FAILED
                    slurm_state = 'FAILED'
                else:
                    # No markers yet — skip this cycle, will re-check next time
                    continue

            elif slurm_state == 'RUNNING':
                new_int_status = STATUS_RUNNING
                # For running CC jobs, sync progress files periodically
                if is_cc:
                    try:
                        self._jm._sync_job_from_cc(job_name)
                    except Exception:
                        pass  # Non-critical for running jobs

            elif slurm_state == 'PENDING':
                new_int_status = STATUS_SCHEDULED

            # Update pipeline STAR file
            if new_int_status is not None:
                star_status = self.STATUS_TO_STAR.get(new_int_status, 'Running')
                try:
                    update_process_status(self._project_dir, job_name, star_status)
                    logger.info(f"Monitor: {job_name} -> {star_status} (slurm={slurm_state})")
                except Exception as e:
                    logger.warning(f"Monitor: STAR update failed for {job_name}: {e}")

            # Persist slurm state
            with self._jm._lock:
                if job_name in self._jm.slurm_jobs:
                    self._jm.slurm_jobs[job_name]['last_status'] = slurm_state
                    changed = True

        if changed:
            with self._jm._lock:
                self._jm._save_slurm_jobs()


_job_manager = None

def get_job_manager(project_dir: str = None) -> JobManager:
    """Get or create job manager instance."""
    global _job_manager
    if _job_manager is None or (project_dir and str(_job_manager.project_dir) != project_dir):
        if project_dir is None:
            project_dir = config.PROJECT_DIR
        _job_manager = JobManager(project_dir)
    return _job_manager
