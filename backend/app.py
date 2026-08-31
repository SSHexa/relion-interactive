"""
RELION Backend API Server

Provides REST API endpoints for the RELION web UI.
"""
import os
import json
import re
import logging
import time
import uuid
from pathlib import Path
from datetime import datetime
from typing import List, Dict
from flask import Flask, request, jsonify, send_file, send_from_directory
from flask_cors import CORS
from flask_socketio import SocketIO, emit

import config

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)
from star_parser import (
    parse_star_file,
    write_star_file,
    get_pipeline_processes,
    get_pipeline_nodes,
    get_table_rows,
    get_float_column,
    compute_stats,
    add_process_to_pipeline,
    update_process_status,
    add_output_node_to_pipeline,
    get_next_job_number
)
from job_manager import (
    JobManager, JobStatusMonitor,
    STATUS_RUNNING, STATUS_FINISHED, STATUS_ABORTED, STATUS_FAILED,
    JOB_TYPE_COMMANDS,
    validate_job_submission,
)
from particle_picker_api import particle_picker_bp

# Check for optional visualization libraries
VISUALIZATION_AVAILABLE = False
VISUALIZATION_MISSING_LIBS = []

try:
    import numpy as np
except ImportError:
    VISUALIZATION_MISSING_LIBS.append('numpy')

try:
    import matplotlib
except ImportError:
    VISUALIZATION_MISSING_LIBS.append('matplotlib')

try:
    import mrcfile
except ImportError:
    VISUALIZATION_MISSING_LIBS.append('mrcfile')

from viz_utils import render_volume_preview, render_three_views

if not VISUALIZATION_MISSING_LIBS:
    VISUALIZATION_AVAILABLE = True
else:
    logger.warning(f"Visualization features disabled. Missing libraries: {', '.join(VISUALIZATION_MISSING_LIBS)}")
    logger.info(f"  Install with: pip install {' '.join(VISUALIZATION_MISSING_LIBS)}")


def error_response(message: str, status: int = 400, details: dict = None):
    """Standardized error response helper."""
    from flask import jsonify
    response = {'error': message}
    if details:
        response['details'] = details
    return jsonify(response), status


def safe_path(base_dir: Path, user_path: str) -> Path:
    """
    Safely resolve a user-provided path within a base directory.

    Prevents path traversal attacks by ensuring the resolved path
    is within the base directory bounds.

    Args:
        base_dir: The base directory that paths must stay within
        user_path: User-provided relative path

    Returns:
        Resolved Path within base_dir

    Raises:
        ValueError: If path would escape base_dir
    """
    base = Path(base_dir).resolve()
    # Join and resolve to handle .. and symlinks
    requested = (base / user_path).resolve()

    # Check if resolved path is within base
    try:
        requested.relative_to(base)
    except ValueError:
        raise ValueError(f"Path traversal attempt blocked: {user_path}")

    return requested


# validate_job_submission was lifted to job_manager.py so the MCP path
# (mcp_server.py) can call it too. Imported above. See FIX_LOG #84.


app = Flask(__name__)
# Per-request body size cap, primarily for /api/files/upload. Default 500 MB.
# Customer deployments can override via RELION_MAX_UPLOAD_BYTES. Larger inputs
# (multi-GB cryo-EM movies) should use OOD Files / scp instead of the UI.
app.config['MAX_CONTENT_LENGTH'] = int(os.environ.get('RELION_MAX_UPLOAD_BYTES', 500 * 1024 * 1024))
# CORS origins come from config (env var RELION_CORS_ORIGINS or config.json
# "cors_origins"). Default is "*", safe for the customer beta because the
# backend listens only on localhost behind OOD's authenticated reverse proxy.
# Site admins can restrict this to its Azure hostname.
_cors_origins = config.cors_origins if config.cors_origins else "*"
CORS(app, resources={r"/api/*": {"origins": _cors_origins}})
if os.environ.get('RELION_WSGI'):
    class _NoopSocketIO:
        """Lightweight SocketIO stub for WSGI environments."""
        def __init__(self): pass
        def on(self, *a, **kw):
            def decorator(f): return f
            return decorator
        def emit(self, *a, **kw): pass
        def run(self, *a, **kw): pass
    socketio = _NoopSocketIO()
else:
    socketio = SocketIO(app, cors_allowed_origins=_cors_origins, async_mode='threading')

# Register particle picker blueprint
app.register_blueprint(particle_picker_bp)

# Particle Picker static file routes
# The particle-picker frontend is deployed alongside the main app
PARTICLE_PICKER_DIR = Path(__file__).parent.parent / 'particle-picker'

@app.route('/particle-picker/')
def particle_picker_index():
    """Serve the particle picker index.html."""
    return send_from_directory(PARTICLE_PICKER_DIR, 'index.html')

@app.route('/particle-picker/<path:filename>')
def particle_picker_static(filename):
    """Serve particle picker static files."""
    return send_from_directory(PARTICLE_PICKER_DIR, filename)

# Global state - secure storage in user's home directory
STATE_DIR = Path.home() / '.relion5_backend'
STATE_DIR.mkdir(mode=0o700, exist_ok=True)
PROJECT_STATE_FILE = STATE_DIR / 'current_project.json'
VIZ_CACHE_DIR = STATE_DIR / 'viz_cache'
VIZ_CACHE_DIR.mkdir(mode=0o755, exist_ok=True)
current_project_dir = None
job_manager = None


def get_viz_output_path(job_dir: Path, filename: str, job_id: str) -> Path:
    """Get a writable path for visualization output.

    Tries the job directory first; falls back to a per-user cache directory
    when the job directory is read-only (e.g. shared/tutorial projects).
    """
    if os.access(str(job_dir), os.W_OK):
        return job_dir / filename
    cache_subdir = VIZ_CACHE_DIR / job_id.replace('/', '_')
    cache_subdir.mkdir(parents=True, exist_ok=True)
    return cache_subdir / filename


def load_saved_project():
    """Load the saved project from state file."""
    if Path(PROJECT_STATE_FILE).exists():
        try:
            with open(PROJECT_STATE_FILE, "r") as f:
                data = json.load(f)
                return data.get("project_dir")
        except Exception as e:
            logger.warning(f"Failed to load saved project: {e}")
    return None


def save_current_project(project_dir):
    """Save the current project to state file."""
    try:
        with open(PROJECT_STATE_FILE, "w") as f:
            json.dump({"project_dir": project_dir}, f)
    except Exception as e:
        logger.warning(f"Failed to save project state: {e}")


def get_project_dir():
    """Get current project directory."""
    global current_project_dir

    # Check request query param first (stateless approach)
    try:
        project = request.args.get('project_dir')
        if project:
            p = Path(project)
            if p.exists() and any(
                str(p).startswith(str(Path(d).resolve()))
                for d in config.get_all_project_dirs()
            ):
                return str(p)
    except RuntimeError:
        pass  # Outside request context

    if current_project_dir:
        return current_project_dir

    # Try to load from saved state
    saved = load_saved_project()
    if saved and Path(saved).exists():
        current_project_dir = saved
        return current_project_dir

    return config.DEFAULT_PROJECT_DIR


_status_monitor = None

def init_job_manager():
    """Initialize job manager and background status monitor."""
    global job_manager, _status_monitor
    project_dir = get_project_dir()
    job_manager = JobManager(project_dir)

    # Add callback for WebSocket notifications
    def status_callback(process_id, status):
        socketio.emit('process_status_change', {
            'processId': process_id,
            'status': status
        })

    job_manager.add_callback(status_callback)

    # Start background monitor for CC sync and STAR status updates
    if _status_monitor:
        _status_monitor.stop()
    _status_monitor = JobStatusMonitor(job_manager, project_dir)
    _status_monitor.start()

    return job_manager


# ============== Pipeline Endpoints ==============

@app.route('/api/pipeline', methods=['GET'])
def get_pipeline():
    """Get pipeline overview."""
    if not job_manager:
        init_job_manager()
    project_dir = get_project_dir()
    pipeline_file = Path(project_dir) / 'default_pipeline.star'

    # Get processes from STAR file if it exists
    processes = get_pipeline_processes(project_dir) if pipeline_file.exists() else []
    nodes = get_pipeline_nodes(project_dir) if pipeline_file.exists() else []

    # Verify "Running" status against actual marker files.
    # The STAR file can have stale "Running" entries for jobs that completed,
    # aborted, or never ran (ghost dirs from failed submissions).
    for proc in processes:
        if proc['status'] == 1:  # RUNNING per STAR file — verify
            job_dir = Path(project_dir) / proc['id'].rstrip('/')
            if (job_dir / 'RELION_JOB_EXIT_SUCCESS').exists():
                proc['status'] = 2  # FINISHED_SUCCESS
            elif (job_dir / 'RELION_JOB_EXIT_FAILURE').exists():
                proc['status'] = 4  # FINISHED_FAILURE
            elif (job_dir / 'RELION_JOB_EXIT_ABORTED').exists() or (job_dir / 'RELION_JOB_ABORT').exists():
                proc['status'] = 3  # FINISHED_ABORTED
            elif not (job_dir / 'run.out').exists():
                # No run.out: could be (a) ghost dir from failed submission, or
                # (b) job in Slurm queue with compute node still booting.
                # CC nodes take 5-10 min to provision; run.out only appears once
                # the job actually starts on the compute node.
                proc_id = proc['id'].rstrip('/')
                tracked = job_manager.slurm_jobs.get(proc_id, {}) if job_manager else {}
                last_status = tracked.get('last_status', '')
                if last_status in ('PENDING', 'CONFIGURING', 'RUNNING', 'COMPLETING'):
                    pass  # Slurm has it queued/running — leave as Running, the node is booting
                else:
                    proc['status'] = 3  # True ghost: not in Slurm queue and no run.out
            # else: run.out exists but no completion markers → genuinely running

    # Enrich processes with connections from run.sh/job.star parsing
    connections = _get_connections_internal(project_dir)

    process_inputs = {}  # Map target job -> list of source jobs
    for conn in connections:
        target = conn['target']
        source = conn['source']
        if target not in process_inputs:
            process_inputs[target] = []
        if source not in process_inputs[target]:
            process_inputs[target].append(source)

    # Helper to extract job ID from file path (e.g., "Import/job001/movies.star" -> "Import/job001")
    def extract_job_id(path):
        match = re.match(r'([A-Z][a-zA-Z0-9]+/job\d+)', path)
        return match.group(1) if match else None

    for proc in processes:
        proc_id = proc['id'].rstrip('/')
        if not proc.get('inputNodes'):
            proc['inputNodes'] = []
        # Add connections from run.sh/job.star parsing
        if proc_id in process_inputs:
            for source in process_inputs[proc_id]:
                if source not in proc['inputNodes']:
                    proc['inputNodes'].append(source)

    # Normalize inputNodes: convert file paths to job IDs
    all_process_ids = {p['id'].rstrip('/') for p in processes}
    for proc in processes:
        normalized = set()
        for node in proc.get('inputNodes', []):
            job_id = extract_job_id(node)
            # Only include if it's a valid process ID and not self-reference
            if job_id and job_id in all_process_ids and job_id != proc['id'].rstrip('/'):
                normalized.add(job_id)
        proc['inputNodes'] = list(normalized)

    return jsonify({
        'exists': pipeline_file.exists() or len(processes) > 0,
        'name': Path(project_dir).name,
        'path': str(project_dir),
        'processes': processes,
        'nodes': nodes
    })


@app.route('/api/pipeline/processes', methods=['GET'])
def get_processes():
    """Get all processes with normalized inputNodes."""
    if not job_manager:
        init_job_manager()
    project_dir = get_project_dir()
    pipeline_file = Path(project_dir) / 'default_pipeline.star'

    # Get processes from STAR file if it exists
    processes = get_pipeline_processes(project_dir) if pipeline_file.exists() else []

    # Enrich with runtime info from job_manager
    if job_manager:
        for proc in processes:
            status_info = job_manager.get_job_status(proc['id'])
            if 'status' in status_info:
                proc['status'] = status_info['status']

        # Also include processes tracked by job_manager (submitted via web UI)
        tracked_jobs = job_manager.get_all_jobs()
        for job_info in tracked_jobs:
            if not any(p['id'] == job_info['id'] for p in processes):
                processes.append(job_info)

    # Enrich processes with connections from run.sh/job.star parsing
    connections = _get_connections_internal(project_dir)
    process_inputs = {}
    for conn in connections:
        target = conn['target']
        source = conn['source']
        if target not in process_inputs:
            process_inputs[target] = []
        if source not in process_inputs[target]:
            process_inputs[target].append(source)

    for proc in processes:
        proc_id = proc['id'].rstrip('/')
        if not proc.get('inputNodes'):
            proc['inputNodes'] = []
        if proc_id in process_inputs:
            for source in process_inputs[proc_id]:
                if source not in proc['inputNodes']:
                    proc['inputNodes'].append(source)

    # Normalize inputNodes: convert file paths to job IDs
    def extract_job_id(path):
        match = re.match(r'([A-Z][a-zA-Z0-9]+/job\d+)', path)
        return match.group(1) if match else None

    all_process_ids = {p['id'].rstrip('/') for p in processes}
    for proc in processes:
        normalized = set()
        for node in proc.get('inputNodes', []):
            job_id = extract_job_id(node)
            if job_id and job_id in all_process_ids and job_id != proc['id'].rstrip('/'):
                normalized.add(job_id)
        proc['inputNodes'] = list(normalized)

    return jsonify(processes)


@app.route('/api/pipeline/processes/<path:process_id>', methods=['GET'])
def get_process(process_id):
    """Get process details."""
    project_dir = get_project_dir()
    job_dir = Path(project_dir) / process_id

    if not job_dir.exists():
        return error_response('Process not found', 404)

    # Get status
    status_info = job_manager.get_job_status(process_id) if job_manager else {}

    # Read note if exists
    note_file = job_dir / 'note.txt'
    note = ''
    if note_file.exists():
        note = note_file.read_text()

    return jsonify({
        'id': process_id,
        'name': process_id.split('/')[-1],
        'directory': str(job_dir),
        'status': status_info.get('status', 0),
        'note': note,
        'start_time': status_info.get('start_time'),
        'end_time': status_info.get('end_time'),
    })


@app.route('/api/pipeline/processes/<path:process_id>', methods=['DELETE'])
def delete_process(process_id):
    """Delete a process."""
    if not job_manager:
        init_job_manager()

    result = job_manager.delete_job(process_id)
    if result.get('success'):
        return jsonify({'success': True})
    return jsonify(result), 400


@app.route('/api/pipeline/processes/<path:process_id>/abort', methods=['POST'])
def abort_process(process_id):
    """Abort a running process."""
    if not job_manager:
        return error_response('No job manager', 500)

    result = job_manager.abort_job(process_id)
    if result.get('success'):
        return jsonify({'success': True})
    return jsonify(result), 400


@app.route('/api/pipeline/processes/<path:process_id>/cleanup', methods=['POST'])
def cleanup_process(process_id):
    """Cleanup process files."""
    if not job_manager:
        init_job_manager()

    result = job_manager.cleanup_job(process_id)
    if result.get('success'):
        return jsonify({'success': True})
    return jsonify(result), 400


@app.route('/api/pipeline/processes/<path:process_id>/log', methods=['GET'])
def get_process_log(process_id):
    """Get process log."""
    if not job_manager:
        init_job_manager()

    tail = request.args.get('tail', 100, type=int)
    log_type = request.args.get('type', 'out')

    stdout = job_manager.get_job_log(process_id, 'out', tail)
    stderr = job_manager.get_job_log(process_id, 'err', tail)

    job_dir = job_manager.project_dir / process_id
    mtimes = [f.stat().st_mtime for f in (job_dir / 'run.out', job_dir / 'run.err') if f.exists()]
    last_update = datetime.fromtimestamp(max(mtimes)).isoformat() if mtimes else None

    return jsonify({
        'jobName': process_id,
        'stdout': stdout,
        'stderr': stderr,
        'lastUpdate': last_update,
    })


# Cache for _get_connections_internal: {project_dir: (timestamp, connections)}
_connections_cache = {}
_CONNECTIONS_CACHE_TTL = 120  # seconds — connections only change when new jobs are created

def _get_connections_internal(project_dir: str) -> list:
    """Internal helper to get job connections by parsing run.sh and job.star files.
    Results are cached for 120 seconds per project (TTL only). Connections only change
    when new jobs are submitted, not when statuses change."""
    global _connections_cache

    cache_key = str(project_dir)
    if cache_key in _connections_cache:
        cached_time, cached_result = _connections_cache[cache_key]
        if time.time() - cached_time < _CONNECTIONS_CACHE_TTL:
            return cached_result

    connections = []
    job_outputs = {}  # Map of output files/dirs to job IDs

    # First pass: collect all job outputs
    for job_type_dir in Path(project_dir).iterdir():
        if not job_type_dir.is_dir():
            continue
        for job_dir in job_type_dir.iterdir():
            if not job_dir.is_dir() or not job_dir.name.startswith('job'):
                continue
            job_id = f"{job_type_dir.name}/{job_dir.name}"
            job_outputs[job_id + '/'] = job_id
            job_outputs[job_id] = job_id

    # Second pass: find inputs
    # Skip abnormally large files to avoid regex hanging on corrupted data (normal run.sh/job.star < 1KB)
    MAX_SCRIPT_SIZE = 50000

    for job_type_dir in Path(project_dir).iterdir():
        if not job_type_dir.is_dir():
            continue
        for job_dir in job_type_dir.iterdir():
            if not job_dir.is_dir() or not job_dir.name.startswith('job'):
                continue
            job_id = f"{job_type_dir.name}/{job_dir.name}"
            job_refs = set()

            # Parse run.sh
            run_sh = job_dir / 'run.sh'
            if run_sh.exists() and run_sh.stat().st_size < MAX_SCRIPT_SIZE:
                try:
                    content = run_sh.read_text()
                    refs = re.findall(r'([A-Z][a-zA-Z0-9]+/job\d+)(?:/[^\s]+)?', content)
                    job_refs.update(refs)
                except Exception as e:
                    print(f"Warning: Failed to parse {run_sh}: {e}")

            # Parse job.star
            job_star = job_dir / 'job.star'
            if job_star.exists() and job_star.stat().st_size < MAX_SCRIPT_SIZE:
                try:
                    content = job_star.read_text()
                    refs = re.findall(r'([A-Z][a-zA-Z0-9]+/job\d+)(?:/[^\s"]+)?', content)
                    job_refs.update(refs)
                except Exception as e:
                    print(f"Warning: Failed to parse {job_star}: {e}")

            for ref in job_refs:
                if ref != job_id and ref in job_outputs:
                    conn = {'source': ref, 'target': job_id}
                    if conn not in connections:
                        connections.append(conn)

    # Store in cache
    _connections_cache[cache_key] = (time.time(), connections)
    return connections


@app.route('/api/pipeline/connections', methods=['GET'])
def get_pipeline_connections():
    """Analyze job connections by parsing run.sh files and star file references."""
    project_dir = get_project_dir()
    connections = _get_connections_internal(project_dir)
    job_outputs = {}  # Map of output files/dirs to job IDs

    # First pass: collect all job outputs
    for job_type_dir in Path(project_dir).iterdir():
        if not job_type_dir.is_dir():
            continue
        for job_dir in job_type_dir.iterdir():
            if not job_dir.is_dir() or not job_dir.name.startswith('job'):
                continue

            job_id = f"{job_type_dir.name}/{job_dir.name}"

            # Register common output patterns for this job
            # Output STAR files
            for star_file in job_dir.glob('*.star'):
                rel_path = f"{job_id}/{star_file.name}"
                job_outputs[rel_path] = job_id

            # Output MRC files
            for mrc_file in job_dir.glob('*.mrc'):
                rel_path = f"{job_id}/{mrc_file.name}"
                job_outputs[rel_path] = job_id

            # Job directory itself as output
            job_outputs[job_id + '/'] = job_id
            job_outputs[job_id] = job_id

    # Second pass: find inputs in run.sh and job.star files
    # Skip abnormally large files to avoid regex hanging on corrupted data (normal run.sh/job.star < 1KB)
    MAX_SCRIPT_SIZE = 50000

    for job_type_dir in Path(project_dir).iterdir():
        if not job_type_dir.is_dir():
            continue
        for job_dir in job_type_dir.iterdir():
            if not job_dir.is_dir() or not job_dir.name.startswith('job'):
                continue

            job_id = f"{job_type_dir.name}/{job_dir.name}"
            job_refs = set()

            # Parse run.sh if exists
            run_sh = job_dir / 'run.sh'
            if run_sh.exists() and run_sh.stat().st_size < MAX_SCRIPT_SIZE:
                try:
                    content = run_sh.read_text()
                    # Match patterns like: Import/job001, MotionCorr/job002/corrected_micrographs.star
                    refs = re.findall(r'([A-Z][a-zA-Z0-9]+/job\d+)(?:/[^\s]+)?', content)
                    job_refs.update(refs)
                except Exception as e:
                    print(f"Error parsing {run_sh}: {e}")

            # Parse job.star if exists (for SLURM-submitted jobs)
            job_star = job_dir / 'job.star'
            if job_star.exists() and job_star.stat().st_size < MAX_SCRIPT_SIZE:
                try:
                    content = job_star.read_text()
                    # Match job references in job.star (e.g., Extract/job007/particles.star)
                    refs = re.findall(r'([A-Z][a-zA-Z0-9]+/job\d+)(?:/[^\s"]+)?', content)
                    job_refs.update(refs)
                except Exception as e:
                    print(f"Error parsing {job_star}: {e}")

            # Create connections from found references
            for ref in job_refs:
                # Don't connect to self
                if ref != job_id and ref in job_outputs:
                    source_job = job_outputs.get(ref, ref)
                    # Avoid duplicate connections
                    conn = {'source': source_job, 'target': job_id}
                    if conn not in connections:
                        connections.append(conn)

    return jsonify({
        'connections': connections,
        'jobOutputs': job_outputs
    })


@app.route('/api/pipeline/processes/<path:process_id>/status', methods=['GET'])
def get_process_status(process_id):
    """Get process status."""
    if not job_manager:
        init_job_manager()

    status_info = job_manager.get_job_status(process_id)
    return jsonify(status_info)


# ============== Job Endpoints ==============

@app.route('/api/jobs/types', methods=['GET'])
def get_job_types():
    """Get available job types."""
    if not job_manager:
        init_job_manager()

    return jsonify(job_manager.get_job_types())


@app.route('/api/jobs/template/<job_type>', methods=['GET'])
def get_job_template(job_type):
    """Get job template with default parameters."""
    if not job_manager:
        init_job_manager()

    if job_type not in JOB_TYPE_COMMANDS:
        return error_response(f'Unknown job type: {job_type}', 404)

    template = job_manager.get_job_template(job_type)
    return jsonify(template)


@app.route('/api/jobs/outputs', methods=['GET'])
def get_job_outputs():
    """Get available job outputs for job chaining.

    Query params:
    - type: Filter by job type (e.g., 'CtfFind', 'AutoPick')
    - status: Filter by status (default: 'Finished' only)
    - output_type: Type of output needed (e.g., 'micrographs', 'particles', 'coords')

    Returns list of jobs with their output files.
    """
    if not job_manager:
        init_job_manager()

    job_type = request.args.get('type')
    status_filter = request.args.get('status', 'Finished')
    output_type = request.args.get('output_type')

    project_dir = get_project_dir()
    processes = get_pipeline_processes(project_dir)

    # Define what outputs each job type produces
    job_outputs = {
        'Import': ['micrographs'],
        'MotionCorr': ['micrographs', 'movies'],
        'CtfFind': ['micrographs', 'ctf'],
        'AutoPick': ['coords', 'micrographs'],
        'ManualPick': ['coords', 'micrographs'],
        'Extract': ['particles'],
        'Class2D': ['particles', 'classes'],
        'Class3D': ['particles', 'classes', 'maps'],
        'Refine3D': ['particles', 'map', 'halfmaps'],
        'CtfRefine': ['particles'],
        'Polish': ['particles', 'micrographs'],
        'PostProcess': ['map', 'fsc'],
        'MaskCreate': ['mask'],
        'InitialModel': ['map'],
        'ClassSelect': ['particles', 'classes'],
    }

    results = []
    for proc in processes:
        # Filter by type
        if job_type and proc.get('type') != job_type:
            continue

        # Filter by status — proc status may be a string ('Succeeded','Running','Failed')
        # or an int (2=finished, 1=running, 4=failed) depending on STAR file version
        if status_filter:
            proc_status = proc.get('status')
            # Canonical sets of matching values for each filter keyword
            _MATCH = {
                'Finished':  ('Succeeded', 2), 'finished':  ('Succeeded', 2),
                'Succeeded': ('Succeeded', 2), 'succeeded': ('Succeeded', 2),
                'Running':   ('Running',   1), 'running':   ('Running',   1),
                'Failed':    ('Failed',    4), 'failed':    ('Failed',    4),
            }
            if status_filter in _MATCH:
                if proc_status not in _MATCH[status_filter]:
                    continue
            elif status_filter.lstrip('-').isdigit():
                int_val = int(status_filter)
                _INT_TO_STR = {1: 'Running', 2: 'Succeeded', 4: 'Failed'}
                allowed = (int_val, _INT_TO_STR.get(int_val))
                if proc_status not in allowed:
                    continue

        # Filter by output type
        if output_type:
            proc_type = proc.get('type', '')
            available_outputs = job_outputs.get(proc_type, [])
            if output_type not in available_outputs:
                continue

        # Find output files for this job
        job_dir = Path(project_dir) / proc['id']
        outputs = []

        proc_type = proc.get('type', '')
        if proc_type in ['CtfFind', 'MotionCorr', 'Import']:
            # Look for micrographs STAR file
            for star_file in job_dir.glob('*micrographs*.star'):
                outputs.append({
                    'type': 'micrographs',
                    'path': str(star_file.relative_to(project_dir))
                })
        elif proc_type in ['AutoPick', 'ManualPick']:
            # Look for autopick coords
            for star_file in job_dir.glob('**/*_autopick.star'):
                outputs.append({
                    'type': 'coords',
                    'path': str(star_file.relative_to(project_dir))
                })
            # Also include coords.star files
            for star_file in job_dir.glob('**/coords_suffix*.star'):
                outputs.append({
                    'type': 'coords',
                    'path': str(star_file.relative_to(project_dir))
                })
        elif proc_type == 'Extract':
            for star_file in job_dir.glob('particles.star'):
                outputs.append({
                    'type': 'particles',
                    'path': str(star_file.relative_to(project_dir))
                })
        elif proc_type in ['Class2D', 'Class3D', 'Refine3D']:
            for star_file in job_dir.glob('*_data.star'):
                outputs.append({
                    'type': 'particles',
                    'path': str(star_file.relative_to(project_dir))
                })
        elif proc_type == 'PostProcess':
            for star_file in job_dir.glob('postprocess.star'):
                outputs.append({
                    'type': 'postprocess',
                    'path': str(star_file.relative_to(project_dir))
                })

        results.append({
            'id': proc['id'],
            'type': proc.get('type'),
            'alias': proc.get('alias'),
            'status': proc.get('status'),
            'outputs': outputs
        })

    return jsonify(results)


@app.route('/api/jobs/submit', methods=['POST'])
def submit_job():
    """Submit a new job."""
    if not job_manager:
        init_job_manager()

    data = request.get_json()

    # Handle format from frontend: { job: { type, parameters, ... }, mode }
    if data and 'job' in data:
        job_data = data['job']
        # Frontend uses 'type' not 'jobType'
        job_type = job_data.get('type') or job_data.get('jobType')
        # Frontend sends parameters as array, convert to dict
        params_list = job_data.get('parameters', [])
        if isinstance(params_list, list):
            params = {}
            for param in params_list:
                if isinstance(param, dict) and 'variable' in param:
                    params[param['variable']] = param.get('value', '')
        else:
            params = params_list
        # Also capture job-level settings
        params['_outputDir'] = job_data.get('outputDir', '')
        # Sanitize alias: STAR's space-delimited columns silently break on multi-word
        # aliases (e.g. "Import movies" → 5 tokens for a 4-column row). Collapse any
        # whitespace to underscores; default to 'None' if blank. See FIX_LOG #81.
        _raw_alias = job_data.get('alias', '') or ''
        _sanitized_alias = re.sub(r'\s+', '_', _raw_alias.strip()) or 'None'
        params['_alias'] = _sanitized_alias
        params['_queueSubmit'] = job_data.get('queueSubmit', False)
        params['_queueName'] = job_data.get('queueName', '')
        params['_nrMpi'] = job_data.get('nrMpi', 1)
        params['_nrThreads'] = job_data.get('nrThreads', 1)
        logger.debug(f"Final _nrMpi in params: {params['_nrMpi']}")
    else:
        job_type = data.get('jobType')
        params = data.get('params', {})

    mode = data.get('mode', 'new')

    if not job_type:
        return error_response('Job type required', 400)

    # Validate job submission data
    project_dir = get_project_dir()
    try:
        validate_job_submission(job_type, params, project_dir)
    except ValueError as e:
        return error_response(str(e), 400)

    try:
        result = job_manager.submit_job(job_type, params, mode)
    except ValueError as e:
        return error_response(str(e), 400)
    except Exception as e:
        logger.exception("Unhandled error in submit_job")
        return error_response(f"{type(e).__name__}: {e}", 500)

    if result.get('success'):
        job_id = result.get('jobId')
        # project_dir already set above for validation

        # Extract input nodes from parameters (files from other jobs)
        input_nodes = []
        for key, value in params.items():
            if isinstance(value, str) and '/' in value and value.endswith('.star'):
                # This looks like an input file from another job
                input_nodes.append(value)
            elif isinstance(value, str) and value.startswith(('Import/', 'MotionCorr/', 'CtfFind/',
                    'AutoPick/', 'Extract/', 'Class2D/', 'Class3D/', 'Refine3D/', 'Select/')):
                input_nodes.append(value)

        # Define expected output nodes based on job type
        output_nodes = get_expected_outputs(job_type, job_id)

        # Extract job number from job_id (e.g., 'Import/job001' -> 1)
        try:
            job_num = int(job_id.split('/')[-1].replace('job', ''))
        except (ValueError, IndexError):
            job_num = get_next_job_number(project_dir)

        # Write to pipeline STAR file (with deduplication)
        try:
            process_id = add_process_to_pipeline(
                project_dir=project_dir,
                job_type=job_type,
                job_number=job_num,
                alias=params.get('_alias', 'None'),
                status='Running',
                input_nodes=input_nodes,
                output_nodes=output_nodes
            )
            logger.info(f"Pipeline: Added process {process_id} with {len(input_nodes)} inputs, {len(output_nodes)} outputs")

            # For local jobs (Import, ClassSelect) that complete synchronously,
            # update STAR status immediately — don't wait for the monitor
            from job_manager import LOCAL_JOBS
            if job_type in LOCAL_JOBS:
                job_dir = Path(project_dir) / job_id
                if (job_dir / 'RELION_JOB_EXIT_SUCCESS').exists():
                    update_process_status(project_dir, job_id, 'Succeeded')
                elif (job_dir / 'RELION_JOB_EXIT_FAILURE').exists():
                    update_process_status(project_dir, job_id, 'Failed')
        except Exception as e:
            logger.warning(f"Pipeline: Failed to write pipeline metadata: {e}")

        # Return processId as expected by frontend
        return jsonify({
            'success': True,
            'processId': job_id,
            'jobId': job_id,
            'pid': result.get('pid')
        })
    return jsonify(result), 400


def get_expected_outputs(job_type: str, job_id: str) -> List[Dict[str, str]]:
    """Get expected output nodes for a job type."""
    # Map job types to their expected output files and node types
    output_map = {
        'Import': [
            {'name': f'{job_id}/movies.star', 'type': 'MicrographsMovies.star'}
        ],
        'MotionCorr': [
            {'name': f'{job_id}/corrected_micrographs.star', 'type': 'Micrographs.star'}
        ],
        'CtfFind': [
            {'name': f'{job_id}/micrographs_ctf.star', 'type': 'Micrographs.star'}
        ],
        'AutoPick': [
            {'name': f'{job_id}/autopick.star', 'type': 'Coordinates.star'}
        ],
        'Extract': [
            {'name': f'{job_id}/particles.star', 'type': 'Particles.star'}
        ],
        'Class2D': [
            {'name': f'{job_id}/run_it025_optimiser.star', 'type': 'Class2D.star'}
        ],
        'Class3D': [
            {'name': f'{job_id}/run_it025_optimiser.star', 'type': 'Class3D.star'}
        ],
        'Refine3D': [
            {'name': f'{job_id}/run_class001.mrc', 'type': 'DensityMap.mrc'}
        ],
        'Select': [
            {'name': f'{job_id}/particles.star', 'type': 'Particles.star'}
        ],
        'InitialModel': [
            {'name': f'{job_id}/initial_model.mrc', 'type': 'DensityMap.mrc'}
        ],
        'MaskCreate': [
            {'name': f'{job_id}/mask.mrc', 'type': 'Mask3D.mrc'}
        ],
        'PostProcess': [
            {'name': f'{job_id}/postprocess.star', 'type': 'PostProcess.star'}
        ],
        'CtfRefine': [
            {'name': f'{job_id}/particles_ctf_refine.star', 'type': 'Particles.star'}
        ],
        'Polish': [
            {'name': f'{job_id}/shiny.star', 'type': 'Particles.star'}
        ],
    }
    return output_map.get(job_type, [])


@app.route('/api/jobs/schedule', methods=['POST'])
def schedule_job():
    """Schedule a job for later execution."""
    # For now, just submit immediately
    return submit_job()


@app.route('/api/jobs/<path:job_id>/config', methods=['GET'])
def get_job_config(job_id):
    """Get job configuration."""
    project_dir = get_project_dir()

    try:
        safe_path(project_dir, job_id)
    except ValueError:
        return error_response('Invalid job path', 400)

    job_dir = Path(project_dir) / job_id

    # Look for job parameters in various places
    run_script = job_dir / 'run.sh'
    job_star = job_dir / 'job.star'

    if not job_dir.exists():
        return error_response('Job not found', 404)

    config_data = {
        'jobId': job_id,
        'params': {}
    }

    if run_script.exists():
        config_data['command'] = run_script.read_text()

    if job_star.exists():
        star_data = parse_star_file(str(job_star))
        config_data['star'] = star_data

    return jsonify(config_data)


@app.route('/api/jobs/<path:job_id>/progress', methods=['GET'])
def get_job_progress(job_id):
    """Get detailed job progress with iteration info for iterative jobs."""
    project_dir = get_project_dir()

    try:
        job_dir = safe_path(project_dir, job_id)
    except ValueError:
        return error_response('Invalid job path', 403)

    if not job_dir.exists():
        return error_response('Job not found', 404)

    job_type = job_id.split('/')[0]
    progress = {
        'jobId': job_id,
        'jobType': job_type,
        'iteration': None,
        'totalIterations': None,
        'percentComplete': None,
        'estimatedTimeRemaining': None,
        'currentPhase': None,
    }

    # For iterative jobs (Class2D, Class3D, Refine3D, InitialModel), parse iteration info
    if job_type in ['Class2D', 'Class3D', 'Refine3D', 'InitialModel']:
        # Find model files: run_it*_model.star
        model_files = sorted(job_dir.glob('run_it*_model.star'))
        if model_files:
            latest = model_files[-1]
            match = re.search(r'it(\d+)_model', latest.name)
            if match:
                current_iter = int(match.group(1))
                progress['iteration'] = current_iter

                # Try to determine total iterations from run.out or job.star
                total_iters = 25  # Default
                MAX_LOG_SIZE = 5 * 1024 * 1024  # 5MB max for log files
                run_out = job_dir / 'run.out'
                if run_out.exists() and run_out.stat().st_size < MAX_LOG_SIZE:
                    try:
                        content = run_out.read_text()
                        # Look for --iter parameter
                        iter_match = re.search(r'--iter\s+(\d+)', content)
                        if iter_match:
                            total_iters = int(iter_match.group(1))
                    except Exception as e:
                        print(f"[API] progress: failed to scan run.out for --iter in {job_dir.name}: {e}", flush=True)

                progress['totalIterations'] = total_iters
                progress['percentComplete'] = round((current_iter / total_iters) * 100, 1)
                progress['currentPhase'] = f'Iteration {current_iter}/{total_iters}'

    # For MotionCorr/CtfFind, count processed micrographs
    elif job_type in ['MotionCorr', 'CtfFind']:
        # Count output files
        if job_type == 'MotionCorr':
            output_files = list(job_dir.glob('**/*_corrected.mrc')) + list(job_dir.glob('**/*.dw.mrc'))
        else:
            output_files = list(job_dir.glob('**/*_ctf.mrc'))

        processed = len(output_files)
        if processed > 0:
            progress['iteration'] = processed
            progress['currentPhase'] = f'Processed {processed} micrographs'

    # For AutoPick, count micrographs with picks
    elif job_type == 'AutoPick':
        coords_files = list(job_dir.glob('**/*_autopick.star'))
        picked = len(coords_files)
        if picked > 0:
            progress['iteration'] = picked
            progress['currentPhase'] = f'Picked {picked} micrographs'

    # Check run.out for recent activity
    run_out = job_dir / 'run.out'
    if run_out.exists():
        try:
            stat = run_out.stat()
            progress['lastUpdated'] = stat.st_mtime
        except Exception as e:
            print(f"[API] progress: failed to stat run.out for {job_dir.name}: {e}", flush=True)

    return jsonify(progress)


@app.route('/api/jobs/<path:job_id>/run-again', methods=['POST'])
def run_job_again(job_id):
    """Re-run a job with the same parameters."""
    if not job_manager:
        init_job_manager()

    project_dir = get_project_dir()

    try:
        safe_path(project_dir, job_id)
    except ValueError:
        return error_response('Invalid job path', 400)

    old_job_dir = Path(project_dir) / job_id

    if not old_job_dir.exists():
        return error_response('Original job not found', 404)

    # Read the original run.sh to get the command
    run_script = old_job_dir / 'run.sh'
    if not run_script.exists():
        return error_response('No run script found in original job', 404)

    # Get job type from job_id (e.g., "Class2D/job003" -> "Class2D")
    job_type = job_id.split('/')[0]

    # Get next job number
    job_num = get_next_job_number(project_dir)
    new_job_name = f"{job_type}/job{job_num:03d}"
    new_job_dir = Path(project_dir) / new_job_name
    new_job_dir.mkdir(parents=True, exist_ok=True)

    # Read original command and update output paths
    original_cmd = run_script.read_text()

    # Replace old job paths with new job paths in the command
    old_job_name = job_id
    new_cmd = original_cmd.replace(old_job_name, new_job_name)

    # Write new run.sh
    new_run_script = new_job_dir / 'run.sh'
    with open(new_run_script, 'w') as f:
        f.write(new_cmd)
    new_run_script.chmod(0o755)

    # Create submit.sh with proper template
    submit_script = new_job_dir / 'submit.sh'

    # Extract the actual command from run.sh (skip the first two lines: shebang and cd)
    cmd_lines = new_cmd.strip().split('\n')
    actual_cmd = '\n'.join(cmd_lines[2:]) if len(cmd_lines) > 2 else cmd_lines[-1]

    submit_content = f'''#!/bin/bash
# Change to project directory
cd {project_dir}

# Print start info
echo "Job started at: $(date)"
echo "Running on node: $(hostname)"
echo "Command: {actual_cmd}"
echo ""

# Create running marker
touch {new_job_dir}/RELION_JOB_RUNNING

# Run the command
{actual_cmd}
EXIT_CODE=$?

# Remove running marker
rm -f {new_job_dir}/RELION_JOB_RUNNING

# Create appropriate marker file
if [ $EXIT_CODE -eq 0 ]; then
    touch {new_job_dir}/RELION_JOB_EXIT_SUCCESS
else
    touch {new_job_dir}/RELION_JOB_EXIT_FAILURE
fi

echo ""
echo "Job finished at: $(date)"
echo "Exit code: $EXIT_CODE"

exit $EXIT_CODE
'''
    with open(submit_script, 'w') as f:
        f.write(submit_content)
    submit_script.chmod(0o755)

    # Run the job directly in background
    import subprocess
    log_out = open(new_job_dir / 'run.out', 'w')
    log_err = open(new_job_dir / 'run.err', 'w')

    process = subprocess.Popen(
        ['bash', str(submit_script)],
        cwd=str(project_dir),
        stdout=log_out,
        stderr=log_err,
        start_new_session=True
    )
    log_out.close()
    log_err.close()

    return jsonify({
        'success': True,
        'processId': new_job_name,
        'jobId': new_job_name,
        'pid': process.pid,
        'message': f'Job re-submitted as {new_job_name}'
    })


# ============== File Endpoints ==============

@app.route('/api/files/nodes', methods=['GET'])
def get_file_nodes():
    """Browse pipeline nodes."""
    project_dir = get_project_dir()
    node_type = request.args.get('nodeType')

    nodes = get_pipeline_nodes(project_dir)

    if node_type:
        nodes = [n for n in nodes if n.get('type') == node_type]

    return jsonify(nodes)


@app.route('/api/files/content', methods=['GET'])
def get_file_content():
    """Get file content."""
    file_path = request.args.get('path')
    if not file_path:
        return error_response('Path required', 400)

    project_dir = get_project_dir()

    # Security: use safe_path to prevent path traversal
    try:
        full_path = safe_path(project_dir, file_path)
    except ValueError as e:
        return error_response('Access denied: path outside project', 403)

    if not full_path.exists():
        return error_response('File not found', 404)

    if full_path.is_dir():
        return error_response('Path is a directory', 400)

    # Check file size
    if full_path.stat().st_size > 10 * 1024 * 1024:  # 10MB limit
        return error_response('File too large', 400)

    try:
        content = full_path.read_text()
        return jsonify({
            'path': str(file_path),
            'content': content
        })
    except UnicodeDecodeError:
        return error_response('Binary file', 400)


@app.route('/api/files/list', methods=['GET'])
def list_files():
    """List directory contents."""
    dir_path = request.args.get('path', '')
    absolute = request.args.get('absolute', 'false').lower() == 'true'
    project_dir = get_project_dir()

    # Directories blocked from absolute browsing (sensitive system paths)
    _BLOCKED_ABSOLUTE_PREFIXES = (
        '/etc', '/root', '/proc', '/sys', '/dev',
        '/boot', '/usr/share/keyrings', '/run/secrets',
    )

    # Handle absolute paths (for importing from anywhere on the system)
    if absolute or dir_path.startswith('/'):
        if dir_path == '' or dir_path == '.':
            full_path = Path.home()
        else:
            full_path = Path(dir_path)
        # Security: block sensitive system directories
        try:
            resolved = full_path.resolve()
        except Exception as e:
            print(f"[API] list_directory: resolve() failed for {dir_path!r}: {e}", flush=True)
            return error_response('Invalid path', 400)
        resolved_str = str(resolved)
        if any(resolved_str == p or resolved_str.startswith(p + '/') for p in _BLOCKED_ABSOLUTE_PREFIXES):
            return error_response('Access denied: path not allowed', 403)
        full_path = resolved
    else:
        # Handle '.' as project root
        if dir_path == '.' or dir_path == '':
            full_path = Path(project_dir)
        else:
            full_path = Path(project_dir) / dir_path

    try:
        full_path = full_path.resolve()
    except Exception as e:
        print(f"[API] list_directory: relative resolve() failed for {dir_path!r}: {e}", flush=True)
        return error_response('Invalid path', 400)

    if not full_path.exists():
        return error_response('Directory not found', 404)

    if not full_path.is_dir():
        return error_response('Not a directory', 400)

    items = []

    # Add parent directory entry if not at root
    if full_path != Path('/'):
        items.append({
            'name': '..',
            'type': 'dir',
            'path': str(full_path.parent),
        })

    for item in sorted(full_path.iterdir()):
        try:
            # Skip hidden files unless in home directory
            if item.name.startswith('.') and full_path != Path.home():
                continue

            # Return format expected by frontend: { name, type: 'file' | 'dir' }
            items.append({
                'name': item.name,
                'type': 'dir' if item.is_dir() else 'file',
                'path': str(item),
            })
        except PermissionError:
            continue

    return jsonify(items)


@app.route('/api/files/upload', methods=['POST'])
def upload_file():
    """Receive a single file from the browser and write it into the project.

    Query params:
      project_dir: absolute path of an allowed project (validated via
                   get_project_dir() — caller cannot escape the configured
                   project roots).
      subdir:      optional path relative to the project root (default
                   "uploads"). Created if missing. Validated via safe_path().

    Form field:
      file: the browser multipart file. Filename is normalised through
            werkzeug.secure_filename — this is the one place we want it,
            because the source is a browser-supplied multipart name, not a
            user-typed path that might legitimately contain glob characters.

    Behaviour:
      - Total request body capped by app.config['MAX_CONTENT_LENGTH']; Flask
        responds 413 automatically when exceeded.
      - Write is atomic: temp file alongside the destination, then os.replace.
      - Returns {status, filename, path, size}. `path` is project-relative so
        the frontend can drop it straight into the job-config form field.
    """
    from werkzeug.utils import secure_filename

    project_dir = get_project_dir()
    subdir = request.args.get('subdir', 'uploads')

    try:
        dest_dir = safe_path(Path(project_dir), subdir)
    except ValueError:
        return error_response('Access denied: subdir outside project', 403)
    dest_dir.mkdir(parents=True, exist_ok=True)

    if 'file' not in request.files:
        return error_response("No 'file' field in multipart form", 400)
    upload = request.files['file']
    if not upload or not upload.filename:
        return error_response('Empty filename', 400)

    safe_name = secure_filename(upload.filename)
    if not safe_name:
        return error_response('Filename rejected by sanitiser', 400)

    dest = dest_dir / safe_name
    tmp = dest.with_name(f'{safe_name}.partial-{uuid.uuid4().hex}')
    try:
        upload.save(str(tmp))
        os.replace(str(tmp), str(dest))
    except Exception as e:
        try:
            tmp.unlink(missing_ok=True)
        except Exception:
            pass
        return error_response(f'Upload failed: {e}', 500)

    rel = dest.relative_to(Path(project_dir))
    return jsonify({
        'status': 'ok',
        'filename': safe_name,
        'path': str(rel),
        'size': dest.stat().st_size,
    })


@app.route('/api/files/download/<path:file_path>', methods=['GET'])
def download_file(file_path):
    """Download a file from the project directory."""
    from flask import send_file

    project_dir = get_project_dir()

    # Security: use safe_path to prevent path traversal
    try:
        full_path = safe_path(project_dir, file_path)
    except ValueError as e:
        return error_response('Access denied: path outside project', 403)

    if not full_path.exists():
        return error_response('File not found', 404)

    if not full_path.is_file():
        return error_response('Not a file', 400)

    return send_file(str(full_path), as_attachment=True)


# ============== STAR File Endpoints ==============

@app.route('/api/star/parse', methods=['GET'])
def parse_star():
    """Parse a STAR file."""
    file_path = request.args.get('path')
    if not file_path:
        return error_response('Path required', 400)

    project_dir = get_project_dir()

    # Security: use safe_path to prevent path traversal
    try:
        full_path = safe_path(project_dir, file_path)
    except ValueError as e:
        return error_response('Access denied: path outside project', 403)

    if not full_path.exists():
        return error_response('File not found', 404)

    try:
        data = parse_star_file(str(full_path))
        return jsonify(data)
    except Exception as e:
        return error_response(str(e), 500)


@app.route('/api/star/write', methods=['POST'])
def write_star():
    """Write a STAR file."""
    data = request.get_json()
    file_path = data.get('path')
    content = data.get('content')

    if not file_path or not content:
        return error_response('Path and content required', 400)

    project_dir = get_project_dir()

    try:
        safe_path(project_dir, file_path)
    except ValueError:
        return error_response('Invalid file path', 400)

    full_path = Path(project_dir) / file_path

    try:
        write_star_file(str(full_path), content)
        return jsonify({'success': True})
    except Exception as e:
        return error_response(str(e), 500)


# ============== Project Endpoints ==============

@app.route('/api/projects', methods=['GET'])
def list_projects():
    """List available projects from all configured directories."""
    # Display name overrides (folder name -> friendly name)
    DISPLAY_NAMES = {
        'relion40_results': 'Tutorial',
    }
    # Projects to hide from the listing. Configurable via RELION_HIDDEN_PROJECTS
    # (comma-separated). Site admins can hide its legacy
    # workshop projects; customer beta installs default to "" (show all).
    HIDDEN_PROJECTS = {
        p.strip() for p in os.environ.get(
            'RELION_HIDDEN_PROJECTS', ''
        ).split(',') if p.strip()
    }

    projects = []
    seen = set()

    for base in config.get_all_project_dirs():
        base_dir = Path(base)
        if not base_dir.exists():
            continue
        for item in base_dir.iterdir():
            if item.is_dir() and item.name not in seen:
                seen.add(item.name)
                if item.name in HIDDEN_PROJECTS:
                    continue
                pipeline_file = item / 'default_pipeline.star'
                job_count = 0
                if pipeline_file.exists():
                    try:
                        star_data = parse_star_file(str(pipeline_file))
                        procs_block = star_data['data_blocks'].get('data_pipeline_processes', {})
                        for loop in procs_block.get('loops', []):
                            job_count = len(loop.get('rows', []))
                    except Exception as e:
                        print(f"[API] list_projects: failed to count jobs in {pipeline_file}: {e}", flush=True)
                projects.append({
                    'name': DISPLAY_NAMES.get(item.name, item.name),
                    'path': str(item),
                    'hasProject': pipeline_file.exists(),
                    'jobCount': job_count,
                })

    return jsonify(projects)



@app.route('/api/projects/select', methods=['POST'])
def select_project():
    """Select a project by name or path."""
    global current_project_dir

    data = request.get_json()
    project_name = data.get('project')
    project_path_str = data.get('path')

    if not project_name and not project_path_str:
        return error_response('Project name or path required', 400)

    # If full path provided, use it directly
    if project_path_str:
        project_path = Path(project_path_str)
        if not project_path.exists():
            return error_response('Project not found', 404)
    else:
        # Search all configured project directories
        project_path = None
        for base in config.get_all_project_dirs():
            candidate = Path(base) / project_name
            if candidate.exists():
                project_path = candidate
                break
        if not project_path:
            return error_response('Project not found', 404)

    current_project_dir = str(project_path)
    save_current_project(current_project_dir)
    init_job_manager()

    return jsonify({
        'success': True,
        'path': current_project_dir,
        'name': project_path.name
    })

@app.route('/api/projects/open', methods=['POST'])
def open_project():
    """Open a project."""
    global current_project_dir

    data = request.get_json()
    path = data.get('path')

    if not path:
        return error_response('Path required', 400)

    project_path = Path(path)
    if not project_path.exists():
        return error_response('Project not found', 404)

    current_project_dir = str(project_path)
    save_current_project(current_project_dir)
    init_job_manager()

    return jsonify({
        'success': True,
        'path': current_project_dir
    })


@app.route('/api/projects/create', methods=['POST'])
def create_project():
    """Create a new project."""
    global current_project_dir

    data = request.get_json()
    name = data.get('name')
    path = data.get('path')

    if not name:
        return error_response('Name required', 400)

    if path:
        project_path = Path(path) / name
    else:
        project_path = Path(config.DEFAULT_PROJECT_DIR) / name

    try:
        project_path.mkdir(parents=True, exist_ok=True)

        # Create empty pipeline file
        pipeline_file = project_path / 'default_pipeline.star'
        pipeline_file.write_text('''
# version 50001

data_pipeline_general

_rlnPipeLineJobCounter                       1

data_pipeline_processes

data_pipeline_nodes

data_pipeline_input_edges

data_pipeline_output_edges
''')

        current_project_dir = str(project_path)
        init_job_manager()

        return jsonify({
            'success': True,
            'path': current_project_dir
        })

    except Exception as e:
        return error_response(str(e), 500)


# ============== WebSocket Events ==============

@socketio.on('connect')
def handle_connect():
    """Handle WebSocket connection."""
    logger.info('WebSocket client connected')
    emit('connected', {'status': 'ok'})


@socketio.on('disconnect')
def handle_disconnect():
    """Handle WebSocket disconnection."""
    logger.info('WebSocket client disconnected')


@socketio.on('subscribe_pipeline')
def handle_subscribe_pipeline():
    """Subscribe to pipeline updates."""
    # Send current pipeline state
    project_dir = get_project_dir()
    processes = get_pipeline_processes(project_dir)
    emit('pipeline_update', {'processes': processes})


# ============== Job Results Endpoints ==============

@app.route('/api/jobs/<path:job_id>/results', methods=['GET'])
def get_job_results(job_id):
    """Get job results summary including output files and statistics."""
    project_dir = get_project_dir()

    try:
        safe_path(project_dir, job_id)
    except ValueError:
        return error_response('Invalid job path', 400)

    job_dir = Path(project_dir) / job_id

    if not job_dir.exists():
        return error_response('Job not found', 404)

    results = {
        'jobId': job_id,
        'jobType': job_id.split('/')[0] if '/' in job_id else 'Unknown',
        'outputFiles': [],
        'images': [],
        'starFiles': [],
        'pdfs': [],
        'stats': {}
    }

    # Scan job directory for output files
    for item in job_dir.iterdir():
        if item.is_file():
            ext = item.suffix.lower()
            file_info = {
                'name': item.name,
                'path': str(item.relative_to(project_dir)),
                'size': item.stat().st_size,
                'modified': item.stat().st_mtime
            }

            if ext in ['.mrc', '.mrcs']:
                results['images'].append({**file_info, 'type': 'mrc'})
            elif ext in ['.png', '.jpg', '.jpeg', '.gif']:
                results['images'].append({**file_info, 'type': 'image'})
            elif ext == '.eps':
                results['images'].append({**file_info, 'type': 'eps'})
            elif ext == '.star':
                results['starFiles'].append(file_info)
            elif ext == '.pdf':
                results['pdfs'].append(file_info)
            elif ext in ['.log', '.out', '.err']:
                results['outputFiles'].append({**file_info, 'type': 'log'})
            else:
                results['outputFiles'].append({**file_info, 'type': 'other'})

    # Parse job-specific statistics
    job_type = results['jobType']

    if job_type == 'MotionCorr':
        # Parse motion correction stats from corrected_micrographs.star
        # Check both job root and run/ subdirectory (RELION outputs vary)
        corr_star = job_dir / 'corrected_micrographs.star'
        if not corr_star.exists():
            corr_star = job_dir / 'run' / 'corrected_micrographs.star'
        if corr_star.exists():
            try:
                star_data = parse_star_file(str(corr_star))
                rows = get_table_rows(star_data, 'micrographs')
                results['stats']['micrographCount'] = len(rows)

                # Extract motion statistics using helper functions
                total_motion = get_float_column(star_data, 'micrographs', 'rlnAccumMotionTotal')
                early_motion = get_float_column(star_data, 'micrographs', 'rlnAccumMotionEarly')
                late_motion = get_float_column(star_data, 'micrographs', 'rlnAccumMotionLate')

                if total_motion:
                    results['stats']['motionTotal'] = compute_stats(total_motion)
                if early_motion:
                    results['stats']['motionEarly'] = compute_stats(early_motion)
                if late_motion:
                    results['stats']['motionLate'] = compute_stats(late_motion)
            except Exception as e:
                print(f"Error parsing motion stats: {e}")

    elif job_type == 'CtfFind':
        # Parse CTF stats - check both job root and run/ subdirectory
        ctf_star = job_dir / 'micrographs_ctf.star'
        if not ctf_star.exists():
            ctf_star = job_dir / 'run' / 'micrographs_ctf.star'
        if ctf_star.exists():
            try:
                star_data = parse_star_file(str(ctf_star))
                rows = get_table_rows(star_data, 'micrographs')
                results['stats']['micrographCount'] = len(rows)

                # Get defocus values (average of U and V)
                defocus_u = get_float_column(star_data, 'micrographs', 'rlnDefocusU')
                defocus_v = get_float_column(star_data, 'micrographs', 'rlnDefocusV')
                resolution_values = get_float_column(star_data, 'micrographs', 'rlnCtfMaxResolution')

                # Calculate average defocus
                if defocus_u and defocus_v and len(defocus_u) == len(defocus_v):
                    defocus_values = [(u + v) / 2 for u, v in zip(defocus_u, defocus_v)]
                    results['stats']['defocus'] = compute_stats(defocus_values)

                if resolution_values:
                    results['stats']['resolution'] = compute_stats(resolution_values)
            except Exception as e:
                print(f"Error parsing CTF stats: {e}")

    elif job_type == 'AutoPick':
        # Parse AutoPick stats from autopick star files
        particles_per_mic = []
        all_fom_values = []
        total_particles = 0

        # Find all *_autopick.star files (including in subdirectories like Movies/)
        for star_file in job_dir.glob('**/*_autopick.star'):
            try:
                micrograph_name = star_file.stem.replace('_autopick', '')

                # Parse the star file manually to get particle coordinates and FOMs
                with open(star_file, 'r') as f:
                    content = f.read()

                fom_values = []
                in_data = False
                for line in content.split('\n'):
                    line = line.strip()
                    if line.startswith('_rln'):
                        in_data = True
                        continue
                    if in_data and line and not line.startswith('#') and not line.startswith('data_') and not line.startswith('loop_'):
                        parts = line.split()
                        if len(parts) >= 3:
                            try:
                                fom = float(parts[2])  # FOM is typically 3rd column
                                fom_values.append(fom)
                                all_fom_values.append(fom)
                            except (ValueError, IndexError):
                                pass

                particle_count = len(fom_values)
                total_particles += particle_count
                particles_per_mic.append({
                    'micrograph': micrograph_name,
                    'count': particle_count
                })

            except Exception as e:
                print(f"Error parsing autopick file {star_file}: {e}")

        results['stats']['particleCount'] = total_particles
        results['stats']['particlesPerMicrograph'] = particles_per_mic

        if all_fom_values:
            results['stats']['fomDistribution'] = {
                'min': min(all_fom_values),
                'max': max(all_fom_values),
                'mean': sum(all_fom_values) / len(all_fom_values),
                'values': all_fom_values
            }

        # Check for visualization image
        viz_image = job_dir / 'particles_visualization.png'
        if viz_image.exists():
            results['autopickData'] = {
                'particles': [],  # We don't need to send all particle coords
                'visualizationUrl': f'/api/jobs/{job_id}/file/particles_visualization.png'
            }
        else:
            # Try to generate visualization if we have the required data
            results['autopickData'] = {
                'particles': [],
                'visualizationUrl': None
            }

    elif job_type == 'Class3D':
        # Parse Class3D stats from model.star files - check both job root and run/ subdirectory
        try:
            # Find the latest iteration model file
            model_files = sorted(job_dir.glob('run_it*_model.star'), reverse=True)
            if not model_files:
                model_files = sorted(job_dir.glob('run/run_it*_model.star'), reverse=True)
            if model_files:
                latest_model = model_files[0]
                star_data = parse_star_file(str(latest_model))

                # Extract iteration number from filename
                iter_match = re.search(r'run_it(\d+)_model', latest_model.name)
                iteration = int(iter_match.group(1)) if iter_match else 0
                results['stats']['iteration'] = iteration

                # Get class distribution from model_classes block
                rows = get_table_rows(star_data, 'model_classes')
                if rows:
                    results['stats']['classCount'] = len(rows)
                    class_distribution = []
                    resolutions = []

                    for i, row in enumerate(rows):
                        class_info = {'classNumber': i + 1}
                        try:
                            dist = float(row.get('rlnClassDistribution', 0))
                            class_info['distribution'] = dist
                            class_distribution.append(dist)
                        except (ValueError, TypeError):
                            pass
                        try:
                            res = float(row.get('rlnEstimatedResolution', 0))
                            class_info['resolution'] = res
                            resolutions.append(res)
                        except (ValueError, TypeError):
                            pass
                        results['stats'].setdefault('classes', []).append(class_info)

                    if class_distribution:
                        results['stats']['classDistribution'] = class_distribution
                    if resolutions:
                        results['stats']['resolutions'] = resolutions
                        results['stats']['bestResolution'] = min(resolutions)

                # Get general model info
                general_rows = get_table_rows(star_data, 'model_general')
                if general_rows:
                    row = general_rows[0]
                    try:
                        results['stats']['logLikelihood'] = float(row.get('rlnLogLikelihood', 0))
                    except (ValueError, TypeError):
                        pass

                # List MRC class files - check both job root and run/ subdirectory
                class_mrcs = sorted(job_dir.glob(f'run_it{iteration:03d}_class*.mrc'))
                if not class_mrcs:
                    class_mrcs = sorted(job_dir.glob(f'run/run_it{iteration:03d}_class*.mrc'))
                results['stats']['classMrcs'] = [str(f.relative_to(project_dir)) for f in class_mrcs if 'external' not in f.name]

        except Exception as e:
            print(f"Error parsing Class3D stats: {e}")
            import traceback
            traceback.print_exc()

    elif job_type == 'Class2D':
        # Parse Class2D stats similarly - check both job root and run/ subdirectory
        try:
            model_files = sorted(job_dir.glob('run_it*_model.star'), reverse=True)
            if not model_files:
                model_files = sorted(job_dir.glob('run/run_it*_model.star'), reverse=True)
            if model_files:
                latest_model = model_files[0]
                star_data = parse_star_file(str(latest_model))

                iter_match = re.search(r'run_it(\d+)_model', latest_model.name)
                iteration = int(iter_match.group(1)) if iter_match else 0
                results['stats']['iteration'] = iteration

                rows = get_table_rows(star_data, 'model_classes')
                if rows:
                    results['stats']['classCount'] = len(rows)
                    class_distribution = get_float_column(star_data, 'model_classes', 'ClassDistribution')
                    if class_distribution:
                        results['stats']['classDistribution'] = class_distribution

        except Exception as e:
            print(f"Error parsing Class2D stats: {e}")

    elif job_type == 'Import':
        # Parse Import job - list imported files
        # Check both job root and run/ subdirectory
        try:
            movies_star = job_dir / 'movies.star'
            if not movies_star.exists():
                movies_star = job_dir / 'run' / 'movies.star'
            micrographs_star = job_dir / 'micrographs.star'
            if not micrographs_star.exists():
                micrographs_star = job_dir / 'run' / 'micrographs.star'

            if movies_star.exists():
                star_data = parse_star_file(str(movies_star))
                rows = get_table_rows(star_data, 'movies')
                if rows:
                    results['stats']['movieCount'] = len(rows)
                    results['stats']['importType'] = 'movies'
            elif micrographs_star.exists():
                star_data = parse_star_file(str(micrographs_star))
                rows = get_table_rows(star_data, 'micrographs')
                if rows:
                    results['stats']['micrographCount'] = len(rows)
                    results['stats']['importType'] = 'micrographs'
        except Exception as e:
            print(f"Error parsing Import stats: {e}")

    elif job_type == 'Extract':
        # Parse Extract job stats - check both job root and run/ subdirectory
        try:
            particles_star = job_dir / 'particles.star'
            if not particles_star.exists():
                particles_star = job_dir / 'run' / 'particles.star'
            if particles_star.exists():
                star_data = parse_star_file(str(particles_star))
                rows = get_table_rows(star_data, 'particles')
                if rows:
                    results['stats']['particleCount'] = len(rows)
        except Exception as e:
            print(f"Error parsing Extract stats: {e}")

    elif job_type == 'InitialModel':
        # Parse InitialModel job - check both job root and run/ subdirectory
        try:
            initial_model = job_dir / 'initial_model.mrc'
            if not initial_model.exists():
                initial_model = job_dir / 'run' / 'initial_model.mrc'
            if initial_model.exists():
                results['stats']['modelGenerated'] = True
                results['stats']['modelPath'] = str(initial_model.relative_to(project_dir))

            # Check for run files in both locations
            model_files = sorted(job_dir.glob('run_it*_model.star'), reverse=True)
            if not model_files:
                model_files = sorted(job_dir.glob('run/run_it*_model.star'), reverse=True)
            if model_files:
                iter_match = re.search(r'run_it(\d+)_model', model_files[0].name)
                if iter_match:
                    results['stats']['iteration'] = int(iter_match.group(1))
        except Exception as e:
            print(f"Error parsing InitialModel stats: {e}")

    elif job_type == 'Refine3D':
        # Parse Refine3D stats - check both job root and run/ subdirectory
        try:
            # Find the latest iteration
            model_files = sorted(job_dir.glob('run_*_model.star'), reverse=True)
            if not model_files:
                model_files = sorted(job_dir.glob('run/run_*_model.star'), reverse=True)
            half_maps = sorted(job_dir.glob('run_*_half?_class001_unfil.mrc'))
            if not half_maps:
                half_maps = sorted(job_dir.glob('run/run_*_half?_class001_unfil.mrc'))

            if model_files:
                latest_model = model_files[0]
                star_data = parse_star_file(str(latest_model))

                iter_match = re.search(r'run_(?:it)?(\d+)_model', latest_model.name)
                if iter_match:
                    results['stats']['iteration'] = int(iter_match.group(1))

                general_rows = get_table_rows(star_data, 'model_general')
                if general_rows:
                    row = general_rows[0]
                    try:
                        results['stats']['resolution'] = float(row.get('rlnCurrentResolution', 0))
                    except (ValueError, TypeError):
                        pass

            results['stats']['halfMapsGenerated'] = len(half_maps) >= 2
        except Exception as e:
            print(f"Error parsing Refine3D stats: {e}")

    elif job_type == 'PostProcess':
        # Parse PostProcess stats - check both job root and run/ subdirectory
        try:
            postprocess_star = job_dir / 'postprocess.star'
            if not postprocess_star.exists():
                postprocess_star = job_dir / 'run' / 'postprocess.star'
            if postprocess_star.exists():
                star_data = parse_star_file(str(postprocess_star))

                general_rows = get_table_rows(star_data, 'general')
                if general_rows:
                    row = general_rows[0]
                    try:
                        results['stats']['finalResolution'] = float(row.get('rlnFinalResolution', 0))
                    except (ValueError, TypeError):
                        pass
                    try:
                        results['stats']['bFactor'] = float(row.get('rlnBfactorUsedForSharpening', 0))
                    except (ValueError, TypeError):
                        pass

            # Check for output files
            masked_map = job_dir / 'postprocess_masked.mrc'
            if not masked_map.exists():
                masked_map = job_dir / 'run' / 'postprocess_masked.mrc'
            if masked_map.exists():
                results['stats']['maskedMapPath'] = str(masked_map.relative_to(project_dir))
        except Exception as e:
            print(f"Error parsing PostProcess stats: {e}")

    elif job_type == 'CtfRefine':
        # Parse CtfRefine stats - RELION 5 writes outputs at the job root;
        # older / per-iteration runs may use the run/ subdirectory.
        try:
            particles_star = job_dir / 'particles_ctf_refine.star'
            if not particles_star.exists():
                particles_star = job_dir / 'run' / 'particles_ctf_refine.star'
            if particles_star.exists():
                star_data = parse_star_file(str(particles_star))
                # Table name is 'data_particles' in RELION 5 star files
                rows = get_table_rows(star_data, 'data_particles')
                if rows:
                    results['stats']['particleCount'] = len(rows)
                    results['stats']['ctfRefined'] = True

            # Job succeeded by Slurm exit marker — surface that even if the
            # particles star is split across Movies/ shards.
            if not results['stats'].get('ctfRefined') and (job_dir / 'RELION_JOB_EXIT_SUCCESS').exists():
                results['stats']['ctfRefined'] = True

            # logfile.pdf can also live at the job root
            logfile_pdf = job_dir / 'logfile.pdf'
            if not logfile_pdf.exists():
                logfile_pdf = job_dir / 'run' / 'logfile.pdf'
            if logfile_pdf.exists():
                results['stats']['logfilePath'] = str(logfile_pdf.relative_to(project_dir))

            # Surface aberration / beam-tilt diagnostic maps if present
            aberr_maps = sorted([str(p.relative_to(project_dir))
                                 for p in job_dir.glob('aberr_*.mrc')])
            beamtilt_maps = sorted([str(p.relative_to(project_dir))
                                    for p in job_dir.glob('beamtilt_*.mrc')])
            if aberr_maps:
                results['stats']['aberrationMaps'] = aberr_maps
            if beamtilt_maps:
                results['stats']['beamtiltMaps'] = beamtilt_maps
        except Exception as e:
            print(f"Error parsing CtfRefine stats: {e}")

    elif job_type == 'Polish':
        # Parse Polish stats - check both job root and run/ subdirectory
        try:
            shiny_star = job_dir / 'shiny.star'
            if not shiny_star.exists():
                shiny_star = job_dir / 'run' / 'shiny.star'
            if shiny_star.exists():
                star_data = parse_star_file(str(shiny_star))
                rows = get_table_rows(star_data, 'particles')
                if rows:
                    results['stats']['particleCount'] = len(rows)
                    results['stats']['polished'] = True
        except Exception as e:
            print(f"Error parsing Polish stats: {e}")

    elif job_type == 'MaskCreate':
        # Parse MaskCreate stats - check both job root and run/ subdirectory
        try:
            mask_file = job_dir / 'mask.mrc'
            if not mask_file.exists():
                mask_file = job_dir / 'run' / 'mask.mrc'
            if mask_file.exists():
                results['stats']['maskGenerated'] = True
                results['stats']['maskPath'] = str(mask_file.relative_to(project_dir))
        except Exception as e:
            print(f"Error parsing MaskCreate stats: {e}")

    elif job_type == 'Select':
        # Parse Select stats - check both job root and run/ subdirectory
        try:
            particles_star = job_dir / 'particles.star'
            if not particles_star.exists():
                particles_star = job_dir / 'run' / 'particles.star'
            micrographs_star = job_dir / 'micrographs_selected.star'
            if not micrographs_star.exists():
                micrographs_star = job_dir / 'run' / 'micrographs_selected.star'

            if particles_star.exists():
                star_data = parse_star_file(str(particles_star))
                rows = get_table_rows(star_data, 'particles')
                if rows:
                    results['stats']['particleCount'] = len(rows)
                    results['stats']['selectType'] = 'particles'
            elif micrographs_star.exists():
                star_data = parse_star_file(str(micrographs_star))
                rows = get_table_rows(star_data, 'micrographs')
                if rows:
                    results['stats']['micrographCount'] = len(rows)
                    results['stats']['selectType'] = 'micrographs'
        except Exception as e:
            print(f"Error parsing Select stats: {e}")

    elif job_type == 'LocalRes':
        # Parse LocalRes stats - check both job root and run/ subdirectory
        try:
            local_res_map = job_dir / 'relion_locres.mrc'
            if not local_res_map.exists():
                local_res_map = job_dir / 'run' / 'relion_locres.mrc'
            if local_res_map.exists():
                results['stats']['localResMapGenerated'] = True
                results['stats']['localResMapPath'] = str(local_res_map.relative_to(project_dir))
        except Exception as e:
            print(f"Error parsing LocalRes stats: {e}")

    elif job_type == 'ManualPick':
        # Parse ManualPick stats - check both job root and run/ subdirectory
        try:
            coords_star = job_dir / 'manualpick.star'
            if not coords_star.exists():
                coords_star = job_dir / 'run' / 'manualpick.star'
            if coords_star.exists():
                results['stats']['manualPickDone'] = True

            # Surface upstream CTF (or MotionCorr) job referenced by job.star so
            # the frontend's "Open Particle Picker" launcher can hand the picker
            # the correct micrograph source. job.star stores INPUTNODE values in
            # a (rlnJobOptionVariable, rlnJobOptionValue) table; fn_in points to
            # something like "CtfFind/job003/micrographs_ctf.star".
            job_star_path = job_dir / 'job.star'
            if job_star_path.exists():
                try:
                    content = job_star_path.read_text()
                    m = re.search(r'\bfn_in\b\s+(\S+)', content)
                    if m:
                        fn_in = m.group(1).strip().strip('"').strip("'")
                        if fn_in and fn_in.lower() != 'none':
                            results['stats']['inputMicrographsStar'] = fn_in
                            upstream = re.match(r'([A-Z][a-zA-Z0-9]+/job\d+)', fn_in)
                            if upstream:
                                results['stats']['inputCtfJob'] = upstream.group(1)
                except Exception as e:
                    print(f"Warning: Failed to parse ManualPick job.star: {e}")
        except Exception as e:
            print(f"Error parsing ManualPick stats: {e}")

    elif job_type == 'ModelAngelo':
        # ModelAngelo writes its atomic model to <job>/output.cif (or output_pdb.cif).
        # In RELION 5 it sometimes lives under run/ or output/. Report what we find.
        try:
            candidates = [
                job_dir / 'output.cif',
                job_dir / 'output_pdb.cif',
                job_dir / 'output' / 'output.cif',
                job_dir / 'run' / 'output.cif',
            ]
            cif = next((p for p in candidates if p.exists()), None)
            # Search for any .cif/.pdb under the job dir as a fallback
            if cif is None:
                for p in job_dir.rglob('*.cif'):
                    cif = p
                    break
            if cif is None:
                for p in job_dir.rglob('*.pdb'):
                    cif = p
                    break
            if cif is not None:
                results['stats']['atomicModelGenerated'] = True
                results['stats']['atomicModelPath'] = str(cif.relative_to(project_dir))
                results['stats']['atomicModelFormat'] = cif.suffix.lstrip('.').upper()
                try:
                    results['stats']['atomicModelSizeBytes'] = cif.stat().st_size
                except Exception:
                    pass
            log_file = job_dir / 'run.out'
            if log_file.exists():
                results['stats']['logAvailable'] = True
        except Exception as e:
            print(f"Error parsing ModelAngelo stats: {e}")

    elif job_type == 'DynaMight':
        # DynaMight produces a trained network + latent space visualizations.
        # Typical outputs: forward_deformations/, inverse_deformations/, latent_space_*.png,
        # checkpoint_*.pth or last.ckpt under the job dir.
        try:
            checkpoints = list(job_dir.rglob('*.ckpt')) + list(job_dir.rglob('*.pth'))
            latent_pngs = list(job_dir.rglob('latent_space*.png')) + list(job_dir.rglob('latent*.png'))
            deformations = [p for p in job_dir.glob('*deformations*') if p.is_dir()]
            results['stats']['checkpointsFound'] = len(checkpoints)
            if checkpoints:
                latest = max(checkpoints, key=lambda p: p.stat().st_mtime)
                results['stats']['latestCheckpoint'] = str(latest.relative_to(project_dir))
            results['stats']['latentPlotsFound'] = len(latent_pngs)
            if latent_pngs:
                results['stats']['latentPlotPath'] = str(latent_pngs[0].relative_to(project_dir))
            results['stats']['deformationDirs'] = [str(p.relative_to(project_dir)) for p in deformations]
        except Exception as e:
            print(f"Error parsing DynaMight stats: {e}")

    return jsonify(results)


@app.route('/api/jobs/<path:job_id>/file/<path:filename>', methods=['GET'])
def serve_job_file(job_id, filename):
    """Serve a file from a job directory (or viz cache)."""
    project_dir = get_project_dir()
    file_path = Path(project_dir) / job_id / filename

    if not file_path.exists():
        # Check visualization cache for generated PNGs
        cache_path = VIZ_CACHE_DIR / job_id.replace('/', '_') / filename
        if cache_path.exists():
            return send_file(str(cache_path))
        return error_response('File not found', 404)

    # Ensure file is within job directory (security)
    try:
        file_path = file_path.resolve()
        job_dir = (Path(project_dir) / job_id).resolve()
        if not str(file_path).startswith(str(job_dir)):
            return error_response('Invalid path', 403)
    except Exception as e:
        print(f"[API] serve_job_file: path validation failed for {job_id}/{filename}: {e}", flush=True)
        return error_response('Invalid path', 400)

    return send_file(str(file_path))


@app.route('/api/jobs/<path:job_id>/generate-visualization', methods=['POST'])
def generate_autopick_visualization(job_id):
    """Generate particle visualization for AutoPick job."""
    # Check for required libraries
    if not VISUALIZATION_AVAILABLE:
        return jsonify({
            'error': 'Visualization not available',
            'message': f'Missing required libraries: {", ".join(VISUALIZATION_MISSING_LIBS)}. Install with: pip install {" ".join(VISUALIZATION_MISSING_LIBS)}',
            'missingLibraries': VISUALIZATION_MISSING_LIBS
        }), 501

    project_dir = get_project_dir()
    job_dir = Path(project_dir) / job_id

    if not job_dir.exists():
        return error_response('Job not found', 404)

    try:
        import numpy as np
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        import mrcfile

        # Find the input micrograph from run.sh
        run_sh = job_dir / 'run.sh'
        input_star = None
        if run_sh.exists():
            content = run_sh.read_text()
            for part in content.split():
                if part.endswith('.star') and 'micrograph' in part.lower():
                    input_star = part
                    break
                elif '--i' in content:
                    # Find the argument after --i
                    parts = content.split('--i')
                    if len(parts) > 1:
                        input_star = parts[1].strip().split()[0]
                        break

        # Find autopick star files and corresponding micrographs (search recursively in subdirs)
        for star_file in job_dir.glob('**/*_autopick.star'):
            micrograph_name = star_file.stem.replace('_autopick', '')

            # Find the micrograph MRC file (search recursively in subdirs)
            mrc_path = None
            for search_dir in ['MotionCorr', 'Import']:
                for job_subdir in sorted(Path(project_dir).glob(f'{search_dir}/job*'), reverse=True):
                    # Check job root first, then subdirectories
                    potential_mrc = job_subdir / f'{micrograph_name}.mrc'
                    if potential_mrc.exists():
                        mrc_path = potential_mrc
                        break
                    # Search recursively in subdirs (e.g. Movies/)
                    for found in job_subdir.glob(f'**/{micrograph_name}.mrc'):
                        mrc_path = found
                        break
                    if mrc_path:
                        break
                if mrc_path:
                    break

            if not mrc_path or not mrc_path.exists():
                continue

            # Read the micrograph
            with mrcfile.open(str(mrc_path), mode='r') as mrc:
                micrograph = mrc.data.copy()

            # Read particle coordinates
            coords = []
            with open(star_file, 'r') as f:
                in_data = False
                for line in f:
                    line = line.strip()
                    if line.startswith('_rln'):
                        in_data = True
                        continue
                    if in_data and line and not line.startswith('#') and not line.startswith('data_') and not line.startswith('loop_'):
                        parts = line.split()
                        if len(parts) >= 3:
                            try:
                                x = float(parts[0])
                                y = float(parts[1])
                                fom = float(parts[2])
                                coords.append((x, y, fom))
                            except (ValueError, IndexError):
                                continue  # Skip malformed coordinate lines

            if not coords:
                continue

            # Create visualization
            fig, ax = plt.subplots(1, 1, figsize=(14, 14))
            vmin, vmax = np.percentile(micrograph, [1, 99])
            ax.imshow(micrograph, cmap='gray', vmin=vmin, vmax=vmax, origin='lower')

            # Draw circles at particle positions
            radius = 82.5  # average of 150-180 / 2

            for x, y, fom in coords:
                if fom > 0.4:
                    color = 'lime'
                elif fom > 0.2:
                    color = 'yellow'
                else:
                    color = 'orange'

                circle = plt.Circle((x, y), radius, fill=False, color=color, linewidth=1.5, alpha=0.8)
                ax.add_patch(circle)

            ax.set_title(f'AutoPick Results: {len(coords)} particles picked\n(Green: FOM>0.4, Yellow: FOM>0.2, Orange: FOM<0.2)', fontsize=14)
            ax.set_xlabel('X (pixels)')
            ax.set_ylabel('Y (pixels)')

            plt.tight_layout()
            output_path = get_viz_output_path(job_dir, 'particles_visualization.png', job_id)
            plt.savefig(str(output_path), dpi=150, bbox_inches='tight')
            plt.close()

            return jsonify({
                'success': True,
                'visualizationUrl': f'/api/jobs/{job_id}/file/particles_visualization.png'
            })

        return error_response('No micrograph found for visualization', 404)

    except ImportError as e:
        return error_response(f'Missing required library: {e}', 500)
    except Exception as e:
        return error_response(str(e), 500)


@app.route('/api/jobs/<path:job_id>/generate-class2d-visualization', methods=['POST'])
def generate_class2d_visualization(job_id):
    """Generate class averages visualization for Class2D job."""
    # Check for required libraries
    if not VISUALIZATION_AVAILABLE:
        return jsonify({
            'error': 'Visualization not available',
            'message': f'Missing required libraries: {", ".join(VISUALIZATION_MISSING_LIBS)}. Install with: pip install {" ".join(VISUALIZATION_MISSING_LIBS)}',
            'missingLibraries': VISUALIZATION_MISSING_LIBS
        }), 501

    project_dir = get_project_dir()
    job_dir = Path(project_dir) / job_id

    if not job_dir.exists():
        return error_response('Job not found', 404)

    try:
        import numpy as np
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        import mrcfile

        # Find the final classes.mrcs file (highest iteration or _unmasked_classes.mrcs)
        classes_file = None

        # First try _unmasked_classes.mrcs
        unmasked = job_dir / '_unmasked_classes.mrcs'
        if unmasked.exists():
            classes_file = unmasked
        else:
            # Find highest iteration
            mrcs_files = list(job_dir.glob('*_it*_classes.mrcs'))
            if mrcs_files:
                # Sort by iteration number
                mrcs_files.sort(key=lambda x: int(x.stem.split('_it')[1].split('_')[0]))
                classes_file = mrcs_files[-1]

        if not classes_file:
            return error_response('No class averages found', 404)

        # Read the MRC stack
        with mrcfile.open(str(classes_file), mode='r') as mrc:
            data = mrc.data.copy()

        # Handle 2D vs 3D data
        if data.ndim == 2:
            # Single image
            num_classes = 1
            data = data[np.newaxis, ...]
        else:
            num_classes = data.shape[0]

        # Create grid layout
        ncols = min(5, num_classes)
        nrows = (num_classes + ncols - 1) // ncols

        fig, axes = plt.subplots(nrows, ncols, figsize=(ncols * 3, nrows * 3))
        if nrows == 1 and ncols == 1:
            axes = np.array([[axes]])
        elif nrows == 1:
            axes = axes[np.newaxis, :]
        elif ncols == 1:
            axes = axes[:, np.newaxis]

        for i in range(num_classes):
            row = i // ncols
            col = i % ncols
            ax = axes[row, col]

            img = data[i]
            vmin, vmax = np.percentile(img, [2, 98])
            ax.imshow(img, cmap='gray', vmin=vmin, vmax=vmax)
            ax.set_title(f'Class {i + 1}', fontsize=10)
            ax.axis('off')

        # Hide empty subplots
        for i in range(num_classes, nrows * ncols):
            row = i // ncols
            col = i % ncols
            axes[row, col].axis('off')

        plt.suptitle(f'2D Class Averages ({num_classes} classes)', fontsize=14)
        plt.tight_layout()

        output_path = get_viz_output_path(job_dir, 'class_averages.png', job_id)
        plt.savefig(str(output_path), dpi=150, bbox_inches='tight', facecolor='white')
        plt.close()

        return jsonify({
            'success': True,
            'visualizationUrl': f'/api/jobs/{job_id}/file/class_averages.png',
            'numClasses': num_classes
        })

    except ImportError as e:
        return error_response(f'Missing required library: {e}', 500)
    except Exception as e:
        return error_response(str(e), 500)


@app.route('/api/jobs/<path:job_id>/class2d/classes', methods=['GET'])
def get_class2d_classes(job_id):
    """Get all 2D classes with metadata and thumbnails for selection UI."""
    project_dir = get_project_dir()
    job_dir = Path(project_dir) / job_id

    if not job_dir.exists():
        return error_response('Job not found', 404)

    try:
        import base64
        from io import BytesIO
        import numpy as np
        import mrcfile
        from PIL import Image

        # Find model.star file with class metadata
        model_files = sorted(job_dir.glob('run_it*_model.star'), reverse=True)
        if not model_files:
            return error_response('No model.star file found', 404)

        latest_model = model_files[0]
        star_data = parse_star_file(str(latest_model))

        # Get iteration number
        import re
        iter_match = re.search(r'run_it(\d+)_model', latest_model.name)
        iteration = int(iter_match.group(1)) if iter_match else 0

        # Parse class metadata from model_classes table
        class_rows = get_table_rows(star_data, 'model_classes')
        if not class_rows:
            return error_response('No class data found in model.star', 404)

        # Find the classes MRC file
        classes_file = None
        unmasked = job_dir / '_unmasked_classes.mrcs'
        if unmasked.exists():
            classes_file = unmasked
        else:
            mrcs_files = list(job_dir.glob('*_it*_classes.mrcs'))
            if mrcs_files:
                mrcs_files.sort(key=lambda x: int(x.stem.split('_it')[1].split('_')[0]))
                classes_file = mrcs_files[-1]

        if not classes_file:
            return error_response('No class averages MRC file found', 404)

        # Read class images
        with mrcfile.open(str(classes_file), mode='r') as mrc:
            class_images = mrc.data.copy()

        if class_images.ndim == 2:
            class_images = class_images[np.newaxis, ...]

        # Parse data.star for particle counts per class
        data_files = sorted(job_dir.glob('run_it*_data.star'), reverse=True)
        particle_counts = {}
        total_particles = 0

        if data_files:
            data_star = parse_star_file(str(data_files[0]))
            particle_rows = get_table_rows(data_star, 'particles')
            if not particle_rows:
                particle_rows = get_table_rows(data_star, 'images')

            total_particles = len(particle_rows)
            for row in particle_rows:
                class_num = int(row.get('rlnClassNumber', 0))
                particle_counts[class_num] = particle_counts.get(class_num, 0) + 1

        # Build class data with thumbnails
        classes = []
        for i, row in enumerate(class_rows):
            class_num = i + 1  # Classes are 1-indexed

            # Get class image and convert to base64 thumbnail
            if i < len(class_images):
                img_data = class_images[i]
                # Normalize to 0-255
                vmin, vmax = np.percentile(img_data, [2, 98])
                if vmax > vmin:
                    img_normalized = np.clip((img_data - vmin) / (vmax - vmin) * 255, 0, 255).astype(np.uint8)
                else:
                    img_normalized = np.zeros_like(img_data, dtype=np.uint8)

                # Convert to PIL Image and resize for thumbnail
                pil_img = Image.fromarray(img_normalized, mode='L')
                # Resize to reasonable thumbnail size (100x100)
                pil_img = pil_img.resize((100, 100), Image.Resampling.LANCZOS)

                # Encode as base64
                buffer = BytesIO()
                pil_img.save(buffer, format='PNG')
                img_base64 = base64.b64encode(buffer.getvalue()).decode('utf-8')
                image_url = f'data:image/png;base64,{img_base64}'
            else:
                image_url = ''

            # Get class distribution (percentage)
            distribution = float(row.get('rlnClassDistribution', 0)) * 100

            # Get estimated resolution (handle inf/nan values)
            import math
            resolution = float(row.get('rlnEstimatedResolution', 999))
            if math.isinf(resolution) or math.isnan(resolution):
                resolution = 999.0

            # Get particle count for this class
            particle_count = particle_counts.get(class_num, 0)

            classes.append({
                'classNumber': class_num,
                'distribution': round(distribution, 2),
                'resolution': round(resolution, 2),
                'particleCount': particle_count,
                'imageUrl': image_url,
            })

        return jsonify({
            'classes': classes,
            'totalClasses': len(classes),
            'totalParticles': total_particles,
            'iteration': iteration,
            'modelFile': latest_model.name,
        })

    except ImportError as e:
        return error_response(f'Missing required library: {e}', 500)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return error_response(str(e), 500)


@app.route('/api/jobs/<path:job_id>/class2d/select', methods=['POST'])
def select_class2d_classes(job_id):
    """Export selected classes to a new particles STAR file."""
    project_dir = get_project_dir()
    job_dir = Path(project_dir) / job_id

    if not job_dir.exists():
        return error_response('Job not found', 404)

    data = request.get_json()
    selected_classes = data.get('selectedClasses', [])

    if not selected_classes:
        return error_response('No classes selected', 400)

    try:
        # Find data.star file with particle assignments
        data_files = sorted(job_dir.glob('run_it*_data.star'), reverse=True)
        if not data_files:
            return error_response('No data.star file found', 404)

        latest_data = data_files[0]
        star_data = parse_star_file(str(latest_data))

        # Get particles table
        particles_block_name = None
        for block_name in star_data.get('data_blocks', {}):
            if 'particles' in block_name.lower() or 'images' in block_name.lower():
                particles_block_name = block_name
                break

        if not particles_block_name:
            return error_response('No particles data found', 404)

        block = star_data['data_blocks'][particles_block_name]
        if not block.get('loops'):
            return error_response('No particle data in file', 404)

        # Filter particles by selected classes
        filtered_rows = []
        for loop in block['loops']:
            for row in loop['rows']:
                class_num = int(row.get('rlnClassNumber', 0))
                if class_num in selected_classes:
                    filtered_rows.append(row)

        if not filtered_rows:
            return error_response('No particles found in selected classes', 404)

        # Create new STAR file with filtered particles
        output_star = {
            'version': star_data.get('version', '3.1'),
            'data_blocks': {
                particles_block_name: {
                    'values': block.get('values', {}),
                    'loops': [{
                        'columns': block['loops'][0]['columns'],
                        'rows': filtered_rows
                    }]
                }
            }
        }

        # Also copy optics table if present
        for block_name, block_data in star_data.get('data_blocks', {}).items():
            if 'optics' in block_name.lower():
                output_star['data_blocks'][block_name] = block_data

        # Write filtered particles file
        output_path = job_dir / 'particles_selected.star'
        write_star_file(str(output_path), output_star)

        return jsonify({
            'success': True,
            'outputPath': str(output_path),
            'relativePath': f'{job_id}/particles_selected.star',
            'selectedClasses': selected_classes,
            'particleCount': len(filtered_rows),
        })

    except Exception as e:
        import traceback
        traceback.print_exc()
        return error_response(str(e), 500)


@app.route('/api/jobs/<path:job_id>/class3d/classes', methods=['GET'])
def get_class3d_classes(job_id):
    """Get all 3D classes with metadata and central slice thumbnails for selection UI."""
    project_dir = get_project_dir()
    job_dir = Path(project_dir) / job_id

    if not job_dir.exists():
        return error_response('Job not found', 404)

    try:
        import base64
        from io import BytesIO
        import numpy as np
        import mrcfile
        from PIL import Image
        import math
        import re

        # Find model.star file with class metadata
        model_files = sorted(job_dir.glob('run_it*_model.star'), reverse=True)
        if not model_files:
            return error_response('No model.star file found', 404)

        latest_model = model_files[0]
        star_data = parse_star_file(str(latest_model))

        # Get iteration number
        iter_match = re.search(r'run_it(\d+)_model', latest_model.name)
        iteration = int(iter_match.group(1)) if iter_match else 0

        # Parse class metadata from model_classes table
        class_rows = get_table_rows(star_data, 'model_classes')
        if not class_rows:
            return error_response('No class data found in model.star', 404)

        # Parse data.star for particle counts per class
        data_files = sorted(job_dir.glob('run_it*_data.star'), reverse=True)
        particle_counts = {}
        total_particles = 0

        if data_files:
            data_star = parse_star_file(str(data_files[0]))
            particle_rows = get_table_rows(data_star, 'particles')
            if not particle_rows:
                particle_rows = get_table_rows(data_star, 'images')

            total_particles = len(particle_rows)
            for row in particle_rows:
                class_num = int(row.get('rlnClassNumber', 0))
                particle_counts[class_num] = particle_counts.get(class_num, 0) + 1

        # Build class data with thumbnails from individual 3D class MRC files
        classes = []
        for i, row in enumerate(class_rows):
            class_num = i + 1  # Classes are 1-indexed

            # Find the class MRC file (run_it*_class{N}.mrc)
            class_mrc_pattern = f'run_it{iteration:03d}_class{class_num:03d}.mrc'
            class_mrc_files = list(job_dir.glob(class_mrc_pattern))

            # Fallback: try without leading zeros
            if not class_mrc_files:
                class_mrc_files = list(job_dir.glob(f'*_class{class_num:03d}.mrc'))
            if not class_mrc_files:
                class_mrc_files = list(job_dir.glob(f'*_class{class_num}.mrc'))

            image_url = ''
            if class_mrc_files:
                class_mrc = class_mrc_files[0]
                try:
                    with mrcfile.open(str(class_mrc), mode='r') as mrc:
                        volume_data = mrc.data.copy()

                    # Extract central XY slice (middle Z)
                    if volume_data.ndim == 3:
                        central_z = volume_data.shape[0] // 2
                        central_slice = volume_data[central_z]
                    else:
                        central_slice = volume_data

                    # Normalize to 0-255
                    vmin, vmax = np.percentile(central_slice, [2, 98])
                    if vmax > vmin:
                        img_normalized = np.clip((central_slice - vmin) / (vmax - vmin) * 255, 0, 255).astype(np.uint8)
                    else:
                        img_normalized = np.zeros_like(central_slice, dtype=np.uint8)

                    # Convert to PIL Image and resize for thumbnail
                    pil_img = Image.fromarray(img_normalized, mode='L')
                    pil_img = pil_img.resize((100, 100), Image.Resampling.LANCZOS)

                    # Encode as base64
                    buffer = BytesIO()
                    pil_img.save(buffer, format='PNG')
                    img_base64 = base64.b64encode(buffer.getvalue()).decode('utf-8')
                    image_url = f'data:image/png;base64,{img_base64}'
                except Exception as e:
                    print(f"Error reading class {class_num} MRC: {e}")

            # Get class distribution (percentage)
            distribution = float(row.get('rlnClassDistribution', 0)) * 100

            # Get estimated resolution (handle inf/nan values)
            resolution = float(row.get('rlnEstimatedResolution', 999))
            if math.isinf(resolution) or math.isnan(resolution):
                resolution = 999.0

            # Get particle count for this class
            particle_count = particle_counts.get(class_num, 0)

            classes.append({
                'classNumber': class_num,
                'distribution': round(distribution, 2),
                'resolution': round(resolution, 2),
                'particleCount': particle_count,
                'imageUrl': image_url,
            })

        return jsonify({
            'classes': classes,
            'totalClasses': len(classes),
            'totalParticles': total_particles,
            'iteration': iteration,
            'modelFile': latest_model.name,
        })

    except ImportError as e:
        return error_response(f'Missing required library: {e}', 500)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return error_response(str(e), 500)


@app.route('/api/jobs/<path:job_id>/class3d/select', methods=['POST'])
def select_class3d_classes(job_id):
    """Export selected 3D classes to a new particles STAR file."""
    project_dir = get_project_dir()
    job_dir = Path(project_dir) / job_id

    if not job_dir.exists():
        return error_response('Job not found', 404)

    data = request.get_json()
    selected_classes = data.get('selectedClasses', [])

    if not selected_classes:
        return error_response('No classes selected', 400)

    try:
        # Find data.star file with particle assignments
        data_files = sorted(job_dir.glob('run_it*_data.star'), reverse=True)
        if not data_files:
            return error_response('No data.star file found', 404)

        latest_data = data_files[0]
        star_data = parse_star_file(str(latest_data))

        # Get particles table
        particles_block_name = None
        for block_name in star_data.get('data_blocks', {}):
            if 'particles' in block_name.lower() or 'images' in block_name.lower():
                particles_block_name = block_name
                break

        if not particles_block_name:
            return error_response('No particles data found', 404)

        block = star_data['data_blocks'][particles_block_name]
        if not block.get('loops'):
            return error_response('No particle data in file', 404)

        # Filter particles by selected classes
        filtered_rows = []
        for loop in block['loops']:
            for row in loop['rows']:
                class_num = int(row.get('rlnClassNumber', 0))
                if class_num in selected_classes:
                    filtered_rows.append(row)

        if not filtered_rows:
            return error_response('No particles found in selected classes', 404)

        # Create new STAR file with filtered particles
        output_star = {
            'version': star_data.get('version', '3.1'),
            'data_blocks': {
                particles_block_name: {
                    'values': block.get('values', {}),
                    'loops': [{
                        'columns': block['loops'][0]['columns'],
                        'rows': filtered_rows
                    }]
                }
            }
        }

        # Also copy optics table if present
        for block_name, block_data in star_data.get('data_blocks', {}).items():
            if 'optics' in block_name.lower():
                output_star['data_blocks'][block_name] = block_data

        # Write filtered particles file
        output_path = job_dir / 'particles_selected.star'
        write_star_file(str(output_path), output_star)

        return jsonify({
            'success': True,
            'outputPath': str(output_path),
            'relativePath': f'{job_id}/particles_selected.star',
            'selectedClasses': selected_classes,
            'particleCount': len(filtered_rows),
        })

    except Exception as e:
        import traceback
        traceback.print_exc()
        return error_response(str(e), 500)


@app.route('/api/jobs/<path:job_id>/generate-initialmodel-visualization', methods=['POST'])
def generate_initialmodel_visualization(job_id):
    """Generate 3D map visualization for InitialModel job (central slices)."""
    # Check for required libraries
    if not VISUALIZATION_AVAILABLE:
        return jsonify({
            'error': 'Visualization not available',
            'message': f'Missing required libraries: {", ".join(VISUALIZATION_MISSING_LIBS)}. Install with: pip install {" ".join(VISUALIZATION_MISSING_LIBS)}',
            'missingLibraries': VISUALIZATION_MISSING_LIBS
        }), 501

    project_dir = get_project_dir()
    job_dir = Path(project_dir) / job_id

    if not job_dir.exists():
        return error_response('Job not found', 404)

    try:
        import numpy as np
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        import mrcfile

        # Find the final 3D model MRC file
        model_file = None

        # Look for _class001.mrc or similar (final model)
        class_files = list(job_dir.glob('_it*_class001.mrc'))
        if class_files:
            # Sort by iteration number, take highest
            class_files.sort(key=lambda x: int(x.stem.split('_it')[1].split('_')[0]))
            model_file = class_files[-1]
        else:
            # Try _class001.mrc directly
            direct_class = job_dir / '_class001.mrc'
            if direct_class.exists():
                model_file = direct_class

        if not model_file:
            # Try any .mrc file that's not a half-map
            for mrc_file in job_dir.glob('*.mrc'):
                if 'half' not in mrc_file.name.lower():
                    model_file = mrc_file
                    break

        if not model_file:
            return error_response('No 3D model found', 404)

        # Read the MRC file
        with mrcfile.open(str(model_file), mode='r') as mrc:
            data = mrc.data.copy()

        if data.ndim != 3:
            return error_response('Not a 3D volume', 400)

        # Get volume dimensions for the suptitle
        nz, ny, nx = data.shape

        # Create visualization with 3 orthogonal best-variance slices
        fig, axes = plt.subplots(1, 3, figsize=(15, 5))
        render_three_views(
            data, axes,
            titles=('XY Slice', 'XZ Slice', 'YZ Slice'),
        )

        plt.suptitle(f'Initial Model: {model_file.name}\nVolume size: {nx}×{ny}×{nz}', fontsize=14)
        plt.tight_layout()

        output_path = get_viz_output_path(job_dir, 'initial_model_slices.png', job_id)
        plt.savefig(str(output_path), dpi=150, bbox_inches='tight', facecolor='white')
        plt.close()

        return jsonify({
            'success': True,
            'visualizationUrl': f'/api/jobs/{job_id}/file/initial_model_slices.png',
            'modelFile': model_file.name,
            'volumeSize': [nx, ny, nz]
        })

    except ImportError as e:
        return error_response(f'Missing required library: {e}', 500)
    except Exception as e:
        return error_response(str(e), 500)


@app.route('/api/jobs/<path:job_id>/generate-class3d-visualization', methods=['POST'])
def generate_class3d_visualization(job_id):
    """Generate 3D class visualization for Class3D job (central slices of all classes)."""
    # Check for required libraries
    if not VISUALIZATION_AVAILABLE:
        return jsonify({
            'error': 'Visualization not available',
            'message': f'Missing required libraries: {", ".join(VISUALIZATION_MISSING_LIBS)}. Install with: pip install {" ".join(VISUALIZATION_MISSING_LIBS)}',
            'missingLibraries': VISUALIZATION_MISSING_LIBS
        }), 501

    project_dir = get_project_dir()
    job_dir = Path(project_dir) / job_id

    if not job_dir.exists():
        return error_response('Job not found', 404)

    try:
        import numpy as np
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        import mrcfile

        # Find the latest iteration class MRC files.
        # RELION 5 writes auxiliary files alongside the real class averages,
        # e.g. ``run_it025_class002_external_reconstruct_weight.mrc`` (a
        # Fourier-domain reconstruction weight, shape (N, N, N//2+1) with
        # large unscaled values). The naive glob ``run_it*_class*.mrc``
        # catches them and the regex below maps them to the same
        # (iter, class) key as the real ``run_it025_class002.mrc``, so the
        # auxiliary files silently overwrite the real ones when present.
        # Anchor the regex to the END of the filename to exclude any
        # underscore-suffixed RELION 5 sidecar files.
        class_files = sorted(job_dir.glob('run_it*_class*.mrc'))
        if not class_files:
            return error_response('No class MRC files found', 404)

        # Group by iteration and find the highest
        iterations = {}
        class_filename_re = re.compile(r'^run_it(\d+)_class(\d+)\.mrc$')
        for f in class_files:
            match = class_filename_re.match(f.name)
            if match:
                iter_num = int(match.group(1))
                class_num = int(match.group(2))
                if iter_num not in iterations:
                    iterations[iter_num] = {}
                iterations[iter_num][class_num] = f

        if not iterations:
            return error_response('Could not parse class files', 404)

        latest_iter = max(iterations.keys())
        class_dict = iterations[latest_iter]
        num_classes = len(class_dict)

        # Parse class distributions from model.star
        class_distributions = {}
        model_file = job_dir / f'run_it{latest_iter:03d}_model.star'
        if model_file.exists():
            star_data = parse_star_file(str(model_file))
            rows = get_table_rows(star_data, 'model_classes')
            for i, row in enumerate(rows):
                try:
                    dist = float(row.get('rlnClassDistribution', 0)) * 100
                    class_distributions[i + 1] = dist
                except (ValueError, TypeError):
                    continue  # Skip if class distribution can't be parsed

        # Create visualization grid
        cols = min(num_classes, 4)
        rows_count = (num_classes + cols - 1) // cols
        fig, axes = plt.subplots(rows_count, cols, figsize=(4 * cols, 4 * rows_count))
        if rows_count == 1 and cols == 1:
            axes = np.array([[axes]])
        elif rows_count == 1:
            axes = axes.reshape(1, -1)
        elif cols == 1:
            axes = axes.reshape(-1, 1)

        for class_num in sorted(class_dict.keys()):
            mrc_file = class_dict[class_num]
            row_idx = (class_num - 1) // cols
            col_idx = (class_num - 1) % cols
            ax = axes[row_idx, col_idx]

            with mrcfile.open(str(mrc_file), mode='r', permissive=True) as mrc:
                data = mrc.data.copy().astype(np.float32)

            dist_str = f" ({class_distributions.get(class_num, 0):.1f}%)" if class_num in class_distributions else ""
            # Class-average previews use a Z-axis SUM projection (RELION's own
            # GUI convention). A single slice can land tangent to elongated /
            # hollow molecules and split them into disconnected lobes; the sum
            # integrates the whole density column so every voxel contributes.
            # auto_crop=False keeps the molecule in its full box context.
            render_volume_preview(
                data,
                ax,
                title=f'Class {class_num}{dist_str}',
                projection='sum',
                auto_crop=False,
                contrast_percentile=(2.0, 99.0),
            )

        # Hide empty subplots
        for i in range(num_classes, rows_count * cols):
            row_idx = i // cols
            col_idx = i % cols
            axes[row_idx, col_idx].axis('off')

        plt.suptitle(f'Class3D Results - Iteration {latest_iter} ({num_classes} classes)', fontsize=14)
        plt.tight_layout()

        output_path = get_viz_output_path(job_dir, 'class3d_visualization.png', job_id)
        plt.savefig(str(output_path), dpi=150, bbox_inches='tight', facecolor='white')
        plt.close()

        return jsonify({
            'success': True,
            'visualizationUrl': f'/api/jobs/{job_id}/file/class3d_visualization.png',
            'iteration': latest_iter,
            'numClasses': num_classes,
            'classDistributions': class_distributions
        })

    except ImportError as e:
        return error_response(f'Missing required library: {e}', 500)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return error_response(str(e), 500)


@app.route('/api/jobs/<path:job_id>/generate-extract-visualization', methods=['POST'])
def generate_extract_visualization(job_id):
    """Generate particle montage visualization for Extract job."""
    # Check for required libraries
    if not VISUALIZATION_AVAILABLE:
        return jsonify({
            'error': 'Visualization not available',
            'message': f'Missing required libraries: {", ".join(VISUALIZATION_MISSING_LIBS)}. Install with: pip install {" ".join(VISUALIZATION_MISSING_LIBS)}',
            'missingLibraries': VISUALIZATION_MISSING_LIBS
        }), 501

    project_dir = get_project_dir()
    job_dir = Path(project_dir) / job_id

    if not job_dir.exists():
        return error_response('Job not found', 404)

    try:
        import numpy as np
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        import mrcfile

        # Find the particles.mrcs file (check job root first, then subdirectories)
        particles_file = None
        for pattern in ['particles.mrcs', '*_particles.mrcs', '*.mrcs', '**/*.mrcs']:
            files = list(job_dir.glob(pattern))
            if files:
                particles_file = files[0]
                break

        if not particles_file:
            return error_response('No particle stack found', 404)

        # Read the MRC stack
        with mrcfile.open(str(particles_file), mode='r') as mrc:
            data = mrc.data.copy()

        # Handle 2D vs 3D data
        if data.ndim == 2:
            num_particles = 1
            data = data[np.newaxis, ...]
        else:
            num_particles = data.shape[0]

        # Limit to first 100 particles for performance
        max_display = min(100, num_particles)
        data = data[:max_display]

        # Create grid layout
        ncols = min(10, max_display)
        nrows = (max_display + ncols - 1) // ncols

        fig, axes = plt.subplots(nrows, ncols, figsize=(ncols * 1.5, nrows * 1.5))
        if nrows == 1 and ncols == 1:
            axes = np.array([[axes]])
        elif nrows == 1:
            axes = axes[np.newaxis, :]
        elif ncols == 1:
            axes = axes[:, np.newaxis]

        for i in range(max_display):
            row = i // ncols
            col = i % ncols
            ax = axes[row, col]

            img = data[i]
            vmin, vmax = np.percentile(img, [2, 98])
            ax.imshow(img, cmap='gray', vmin=vmin, vmax=vmax)
            ax.axis('off')

        # Hide empty subplots
        for i in range(max_display, nrows * ncols):
            row = i // ncols
            col = i % ncols
            axes[row, col].axis('off')

        title = f'Extracted Particles ({num_particles} total'
        if num_particles > max_display:
            title += f', showing first {max_display}'
        title += ')'
        plt.suptitle(title, fontsize=12)
        plt.tight_layout()

        output_path = get_viz_output_path(job_dir, 'particle_montage.png', job_id)
        plt.savefig(str(output_path), dpi=100, bbox_inches='tight', facecolor='white')
        plt.close()

        return jsonify({
            'success': True,
            'imageUrl': f'/api/jobs/{job_id}/file/particle_montage.png',
            'numParticles': num_particles,
            'displayedParticles': max_display
        })

    except ImportError as e:
        return error_response(f'Missing required library: {e}', 500)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return error_response(str(e), 500)


@app.route('/api/jobs/<path:job_id>/generate-refine3d-visualization', methods=['POST'])
def generate_refine3d_visualization(job_id):
    """Generate 3D map visualization for Refine3D job (central slices + FSC curve)."""
    # Check for required libraries
    if not VISUALIZATION_AVAILABLE:
        return jsonify({
            'error': 'Visualization not available',
            'message': f'Missing required libraries: {", ".join(VISUALIZATION_MISSING_LIBS)}. Install with: pip install {" ".join(VISUALIZATION_MISSING_LIBS)}',
            'missingLibraries': VISUALIZATION_MISSING_LIBS
        }), 501

    project_dir = get_project_dir()
    job_dir = Path(project_dir) / job_id

    if not job_dir.exists():
        return error_response('Job not found', 404)

    try:
        import numpy as np
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        import mrcfile

        # Find the final refined 3D model MRC file
        model_file = None

        # Look for run_class001.mrc (final postprocessed model) or _class001.mrc
        for pattern in ['run_class001.mrc', '*_class001.mrc', '*half1*.mrc']:
            matches = list(job_dir.glob(pattern))
            if matches:
                # Prefer non-half maps
                for m in matches:
                    if 'half' not in m.name.lower():
                        model_file = m
                        break
                if not model_file:
                    model_file = matches[0]
                break

        if not model_file:
            # Try any .mrc file that's not a half-map
            for mrc_file in job_dir.glob('*.mrc'):
                if 'half' not in mrc_file.name.lower():
                    model_file = mrc_file
                    break

        if not model_file:
            # Fallback: use half1 map if job is still running (no combined map yet)
            half1_maps = sorted(job_dir.glob('*half1*.mrc'), key=lambda x: x.stat().st_mtime, reverse=True)
            if half1_maps:
                model_file = half1_maps[0]

        if not model_file:
            return error_response('No 3D model found', 404)

        # Read the MRC file
        with mrcfile.open(str(model_file), mode='r') as mrc:
            data = mrc.data.copy()
            voxel_size = float(mrc.voxel_size.x) if mrc.voxel_size.x > 0 else 1.0

        if data.ndim != 3:
            return error_response('Not a 3D volume', 400)

        # Get volume dimensions for the suptitle (slices rendered via render_three_views)
        nz, ny, nx = data.shape

        # Parse FSC from _fsc.star or _model.star file
        fsc_data = []
        fsc_file = None
        for pattern in ['*_fsc.star', '*_model.star']:
            matches = list(job_dir.glob(pattern))
            if matches:
                # Get the latest one (highest iteration)
                matches.sort(key=lambda x: x.stat().st_mtime, reverse=True)
                fsc_file = matches[0]
                break

        if fsc_file:
            try:
                with open(fsc_file, 'r') as f:
                    content = f.read()

                # Parse FSC data block
                in_fsc_block = False
                in_loop = False
                res_idx = None
                fsc_idx = None

                for line in content.split('\n'):
                    line = line.strip()

                    if 'data_fsc' in line.lower() or 'data_model_class' in line.lower():
                        in_fsc_block = True
                        continue

                    if in_fsc_block and line.startswith('loop_'):
                        in_loop = True
                        continue

                    if in_fsc_block and in_loop and line.startswith('_rln'):
                        if 'Resolution' in line and 'Angstrom' in line:
                            res_idx = len([l for l in content.split('\n') if l.strip().startswith('_rln') and content.split('\n').index(l) < content.split('\n').index(line)])
                        elif 'GoldStandardFsc' in line or 'FourierShellCorrelation' in line:
                            fsc_idx = len([l for l in content.split('\n') if l.strip().startswith('_rln') and content.split('\n').index(l) < content.split('\n').index(line)])
                        continue

                    if in_fsc_block and in_loop and line and not line.startswith('_') and not line.startswith('#') and not line.startswith('data_'):
                        parts = line.split()
                        if len(parts) >= 2:
                            try:
                                # Try to parse as resolution, FSC values
                                res = float(parts[0]) if res_idx == 0 else float(parts[1]) if res_idx == 1 else float(parts[0])
                                fsc = float(parts[1]) if fsc_idx == 1 else float(parts[2]) if fsc_idx == 2 else float(parts[1])
                                if 0 <= fsc <= 1 and res > 0:
                                    fsc_data.append({'resolution': res, 'fsc': fsc})
                            except (ValueError, IndexError):
                                pass

                    if in_fsc_block and line.startswith('data_') and line != 'data_fsc':
                        break

            except Exception as e:
                print(f"Error parsing FSC: {e}")

        # Create visualization with 3 slices + FSC curve
        if fsc_data:
            fig = plt.figure(figsize=(16, 10))
            gs = fig.add_gridspec(2, 3, height_ratios=[1, 0.8])
            axes = [fig.add_subplot(gs[0, i]) for i in range(3)]
            ax_fsc = fig.add_subplot(gs[1, :])
        else:
            fig, axes = plt.subplots(1, 3, figsize=(15, 5))

        # Render XY/XZ/YZ best-variance slices with consistent contrast
        render_three_views(
            data, axes,
            titles=('XY Slice', 'XZ Slice', 'YZ Slice'),
        )

        # Plot FSC curve if available
        final_resolution = None
        if fsc_data:
            resolutions = [d['resolution'] for d in fsc_data]
            fscs = [d['fsc'] for d in fsc_data]

            ax_fsc.plot(resolutions, fscs, 'b-', linewidth=2)
            ax_fsc.axhline(y=0.143, color='r', linestyle='--')
            ax_fsc.axhline(y=0.5, color='orange', linestyle='--', alpha=0.5)
            ax_fsc.set_xlabel('Resolution (Å)', fontsize=12)
            ax_fsc.set_ylabel('Fourier Shell Correlation', fontsize=12)
            ax_fsc.set_title('Gold-standard FSC Curve', fontsize=14)
            ax_fsc.grid(True, alpha=0.3)
            ax_fsc.set_xlim(max(resolutions), min(resolutions))  # Reverse x-axis (high to low resolution)
            ax_fsc.set_ylim(0, 1.05)

            # Find resolution at FSC=0.143
            for i in range(len(fscs) - 1):
                if fscs[i] >= 0.143 and fscs[i + 1] < 0.143:
                    # Linear interpolation
                    final_resolution = resolutions[i] + (0.143 - fscs[i]) * (resolutions[i + 1] - resolutions[i]) / (fscs[i + 1] - fscs[i])
                    ax_fsc.axvline(x=final_resolution, color='green', linestyle=':')
                    break

        title = f'Refined 3D Map: {model_file.name}\nVolume size: {nx}×{ny}×{nz}, Voxel size: {voxel_size:.2f} Å'
        if final_resolution:
            title += f'\nFinal Resolution: {final_resolution:.1f} Å (FSC=0.143)'
        plt.suptitle(title, fontsize=14)
        plt.tight_layout()

        output_path = get_viz_output_path(job_dir, 'refine3d_visualization.png', job_id)
        plt.savefig(str(output_path), dpi=150, bbox_inches='tight', facecolor='white')
        plt.close()

        return jsonify({
            'success': True,
            'visualizationUrl': f'/api/jobs/{job_id}/file/refine3d_visualization.png',
            'modelFile': model_file.name,
            'volumeSize': [nx, ny, nz],
            'voxelSize': voxel_size,
            'finalResolution': final_resolution
        })

    except ImportError as e:
        return error_response(f'Missing required library: {e}', 500)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return error_response(str(e), 500)


@app.route('/api/jobs/<path:job_id>/generate-postprocess-visualization', methods=['POST'])
def generate_postprocess_visualization(job_id):
    """Generate post-processed map visualization with FSC curves."""
    if not VISUALIZATION_AVAILABLE:
        return jsonify({
            'error': 'Visualization not available',
            'message': f'Missing required libraries: {", ".join(VISUALIZATION_MISSING_LIBS)}',
            'missingLibraries': VISUALIZATION_MISSING_LIBS
        }), 501

    project_dir = get_project_dir()
    job_dir = Path(project_dir) / job_id

    if not job_dir.exists():
        return error_response('Job not found', 404)

    try:
        import numpy as np
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        import mrcfile

        # Find the postprocessed map
        model_file = None
        for pattern in ['postprocess_masked.mrc', 'postprocess.mrc']:
            matches = list(job_dir.glob(pattern))
            if matches:
                model_file = matches[0]
                break

        if not model_file:
            return error_response('No post-processed map found', 404)

        # Read the MRC file
        with mrcfile.open(str(model_file), mode='r') as mrc:
            data = mrc.data.copy()
            voxel_size = float(mrc.voxel_size.x) if mrc.voxel_size.x > 0 else 1.0

        if data.ndim != 3:
            return error_response('Not a 3D volume', 400)

        # Get volume dimensions for the suptitle (slices rendered via render_three_views)
        nz, ny, nx = data.shape

        # Parse FSC from postprocess.star (contains multiple FSC curves)
        fsc_data = {'masked': [], 'unmasked': [], 'corrected': []}
        fsc_file = job_dir / 'postprocess.star'

        if fsc_file.exists():
            try:
                with open(fsc_file, 'r') as f:
                    content = f.read()

                # Parse postprocess FSC - has data_fsc block with multiple columns
                in_fsc_block = False
                in_loop = False
                columns = []

                for line in content.split('\n'):
                    line = line.strip()

                    if line == 'data_fsc':
                        in_fsc_block = True
                        columns = []
                        continue

                    if in_fsc_block and line.startswith('loop_'):
                        in_loop = True
                        continue

                    if in_fsc_block and in_loop and line.startswith('_rln'):
                        columns.append(line.split()[0])
                        continue

                    if in_fsc_block and in_loop and line and not line.startswith('_') and not line.startswith('#') and not line.startswith('data_'):
                        parts = line.split()
                        if len(parts) >= 4:
                            try:
                                # Standard postprocess.star columns:
                                # _rlnAngstromResolution, _rlnFourierShellCorrelationCorrected,
                                # _rlnFourierShellCorrelationUnmaskedMaps, _rlnFourierShellCorrelationMaskedMaps
                                res = float(parts[0])
                                corrected = float(parts[1]) if len(parts) > 1 else 0
                                unmasked = float(parts[2]) if len(parts) > 2 else 0
                                masked = float(parts[3]) if len(parts) > 3 else 0

                                if res > 0:
                                    fsc_data['corrected'].append({'resolution': res, 'fsc': corrected})
                                    fsc_data['unmasked'].append({'resolution': res, 'fsc': unmasked})
                                    fsc_data['masked'].append({'resolution': res, 'fsc': masked})
                            except (ValueError, IndexError):
                                pass

                    if in_fsc_block and line.startswith('data_') and line != 'data_fsc':
                        break

            except Exception as e:
                print(f"Error parsing PostProcess FSC: {e}")

        # Create visualization with 3 slices + FSC curves
        has_fsc = any(fsc_data[k] for k in fsc_data)
        if has_fsc:
            fig = plt.figure(figsize=(16, 10))
            gs = fig.add_gridspec(2, 3, height_ratios=[1, 0.8])
            axes = [fig.add_subplot(gs[0, i]) for i in range(3)]
            ax_fsc = fig.add_subplot(gs[1, :])
        else:
            fig, axes = plt.subplots(1, 3, figsize=(15, 5))

        # Render XY/XZ/YZ best-variance slices with consistent contrast
        render_three_views(
            data, axes,
            titles=('XY Slice', 'XZ Slice', 'YZ Slice'),
        )

        # Plot FSC curves
        final_resolution = None
        if has_fsc:
            colors = {'corrected': 'blue', 'masked': 'green', 'unmasked': 'gray'}
            labels = {'corrected': 'Corrected (phase-randomized)', 'masked': 'Masked', 'unmasked': 'Unmasked'}

            for key in ['unmasked', 'masked', 'corrected']:
                if fsc_data[key]:
                    resolutions = [d['resolution'] for d in fsc_data[key]]
                    fscs = [d['fsc'] for d in fsc_data[key]]
                    linewidth = 2 if key == 'corrected' else 1.5
                    alpha = 1.0 if key == 'corrected' else 0.7
                    ax_fsc.plot(resolutions, fscs, color=colors[key], linewidth=linewidth,
                               label=labels[key], alpha=alpha)

            ax_fsc.axhline(y=0.143, color='r', linestyle='--', label='FSC=0.143 threshold')
            ax_fsc.set_xlabel('Resolution (Å)', fontsize=12)
            ax_fsc.set_ylabel('Fourier Shell Correlation', fontsize=12)
            ax_fsc.set_title('Post-Processing FSC Curves', fontsize=14)
            ax_fsc.legend(loc='upper right')
            ax_fsc.grid(True, alpha=0.3)

            # Get resolution limits from data
            if fsc_data['corrected']:
                resolutions = [d['resolution'] for d in fsc_data['corrected']]
                ax_fsc.set_xlim(max(resolutions), min(resolutions))
            ax_fsc.set_ylim(-0.05, 1.05)

            # Find resolution at FSC=0.143 from corrected curve
            if fsc_data['corrected']:
                fscs = [d['fsc'] for d in fsc_data['corrected']]
                resolutions = [d['resolution'] for d in fsc_data['corrected']]
                for i in range(len(fscs) - 1):
                    if fscs[i] >= 0.143 and fscs[i + 1] < 0.143:
                        final_resolution = resolutions[i] + (0.143 - fscs[i]) * (resolutions[i + 1] - resolutions[i]) / (fscs[i + 1] - fscs[i])
                        ax_fsc.axvline(x=final_resolution, color='purple', linestyle=':',
                                      label=f'Final res: {final_resolution:.2f} Å')
                        ax_fsc.legend(loc='upper right')
                        break

        title = f'Post-Processed Map: {model_file.name}\nVolume size: {nx}×{ny}×{nz}, Voxel size: {voxel_size:.2f} Å'
        if final_resolution:
            title += f'\nFinal Resolution: {final_resolution:.2f} Å (FSC=0.143)'
        plt.suptitle(title, fontsize=14)
        plt.tight_layout()

        output_path = get_viz_output_path(job_dir, 'postprocess_visualization.png', job_id)
        plt.savefig(str(output_path), dpi=150, bbox_inches='tight', facecolor='white')
        plt.close()

        return jsonify({
            'success': True,
            'visualizationUrl': f'/api/jobs/{job_id}/file/postprocess_visualization.png',
            'modelFile': model_file.name,
            'volumeSize': [nx, ny, nz],
            'voxelSize': voxel_size,
            'finalResolution': final_resolution
        })

    except ImportError as e:
        return error_response(f'Missing required library: {e}', 500)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return error_response(str(e), 500)


@app.route('/api/jobs/<path:job_id>/shifts', methods=['GET'])
def get_motion_shifts(job_id):
    """Get per-frame motion shifts for motion correction job."""
    project_dir = get_project_dir()

    try:
        safe_path(project_dir, job_id)
    except ValueError:
        return error_response('Invalid job path', 400)

    job_dir = Path(project_dir) / job_id

    if not job_dir.exists():
        return error_response('Job not found', 404)

    shifts_data = []

    # Find all .star files with shift data (recursive — per-micrograph
    # shift files live in Movies/ subdirectory, not the job root)
    for star_file in job_dir.glob('**/*.star'):
        if star_file.name == 'corrected_micrographs.star':
            continue

        try:
            content = star_file.read_text()
            if 'data_global_shift' in content:
                star_data = parse_star_file(str(star_file))
                global_shift_block = star_data.get('data_blocks', {}).get('data_global_shift', {})

                if global_shift_block:
                    micrograph_name = star_file.stem
                    shifts = []

                    # Get data from loops
                    for loop in global_shift_block.get('loops', []):
                        columns = loop.get('columns', [])
                        rows = loop.get('rows', [])

                        frame_col = next((c for c in columns if 'FrameNumber' in c), None)
                        shift_x_col = next((c for c in columns if 'ShiftX' in c), None)
                        shift_y_col = next((c for c in columns if 'ShiftY' in c), None)

                        for row in rows:
                            try:
                                shifts.append({
                                    'frame': int(row.get(frame_col, 0)) if frame_col else 0,
                                    'shiftX': float(row.get(shift_x_col, 0)) if shift_x_col else 0,
                                    'shiftY': float(row.get(shift_y_col, 0)) if shift_y_col else 0
                                })
                            except (ValueError, TypeError) as e:
                                print(f"Error parsing shift row: {e}")

                    if shifts:
                        shifts_data.append({
                            'micrograph': micrograph_name,
                            'shifts': shifts
                        })
        except Exception as e:
            print(f"Error parsing shifts from {star_file}: {e}")

    return jsonify(shifts_data)


# ============== 3D Mesh Generation ==============

@app.route('/api/jobs/<path:job_id>/generate-mesh', methods=['GET'])
def generate_mesh(job_id):
    """Generate 3D mesh from MRC volume using marching cubes algorithm."""
    # Check for required libraries (mesh generation needs extra libs)
    if not VISUALIZATION_AVAILABLE:
        return jsonify({
            'error': 'Mesh generation not available',
            'message': f'Missing required libraries: {", ".join(VISUALIZATION_MISSING_LIBS)}. Install with: pip install {" ".join(VISUALIZATION_MISSING_LIBS)} scikit-image scipy',
            'missingLibraries': VISUALIZATION_MISSING_LIBS
        }), 501

    project_dir = get_project_dir()
    job_dir = Path(project_dir) / job_id

    if not job_dir.exists():
        return error_response('Job not found', 404)

    try:
        import numpy as np
        import mrcfile
        from skimage import measure

        # Get optional parameters
        mrc_filename = request.args.get('mrc_file')
        threshold = request.args.get('threshold', type=float)

        # Find MRC file
        model_file = None

        if mrc_filename:
            # Use specified file
            model_file = job_dir / mrc_filename
            if not model_file.exists():
                return error_response(f'MRC file not found: {mrc_filename}', 404)
        else:
            # Auto-detect MRC file based on job type
            # Priority: postprocess.mrc > mask.mrc > *_class001.mrc > any .mrc
            for pattern in ['postprocess.mrc', 'postprocess_masked.mrc', 'mask.mrc',
                           'run_class001.mrc', '*_class001.mrc', '*_it???_class001.mrc']:
                matches = list(job_dir.glob(pattern))
                if matches:
                    # Prefer non-half maps
                    for m in matches:
                        if 'half' not in m.name.lower():
                            model_file = m
                            break
                    if not model_file:
                        model_file = matches[0]
                    break

            if not model_file:
                # Try any .mrc file that's not a half-map
                for mrc_file in job_dir.glob('*.mrc'):
                    if 'half' not in mrc_file.name.lower():
                        model_file = mrc_file
                        break

            if not model_file:
                # Fallback: use half1 map if job is still running (no combined map yet)
                half1_maps = sorted(job_dir.glob('*half1*.mrc'), key=lambda x: x.stat().st_mtime, reverse=True)
                if half1_maps:
                    model_file = half1_maps[0]

        if not model_file:
            return error_response('No MRC file found in job directory', 404)

        # Read the MRC file
        with mrcfile.open(str(model_file), mode='r') as mrc:
            data = mrc.data.copy()
            voxel_size = float(mrc.voxel_size.x) if mrc.voxel_size.x > 0 else 1.0

        if data.ndim != 3:
            return error_response('Not a 3D volume', 400)

        # Get volume statistics
        min_val = float(np.min(data))
        max_val = float(np.max(data))
        mean_val = float(np.mean(data))
        std_val = float(np.std(data))

        # Calculate suggested threshold (typically 2-3 sigma above mean)
        suggested_threshold_abs = mean_val + 2.5 * std_val

        # Normalize data to 0-1 range for consistent thresholding
        if max_val > min_val:
            data_normalized = (data - min_val) / (max_val - min_val)
            suggested_threshold = (suggested_threshold_abs - min_val) / (max_val - min_val)
            suggested_threshold = max(0.1, min(0.9, suggested_threshold))  # Clamp to reasonable range
        else:
            data_normalized = np.zeros_like(data)
            suggested_threshold = 0.5

        # Use provided threshold or suggested
        if threshold is None:
            threshold = suggested_threshold
        else:
            threshold = max(0.01, min(0.99, threshold))  # Clamp threshold

        # Downsample large volumes for performance
        nz, ny, nx = data_normalized.shape
        max_dim = 128  # Max dimension for mesh generation
        scale_factor = 1

        if max(nz, ny, nx) > max_dim:
            scale_factor = max(nz, ny, nx) / max_dim
            new_shape = (
                max(1, int(nz / scale_factor)),
                max(1, int(ny / scale_factor)),
                max(1, int(nx / scale_factor))
            )
            # Simple downsampling using zoom
            from scipy.ndimage import zoom
            zoom_factors = (new_shape[0] / nz, new_shape[1] / ny, new_shape[2] / nx)
            data_normalized = zoom(data_normalized, zoom_factors, order=1)

        # Generate isosurface using marching cubes
        try:
            verts, faces, normals, values = measure.marching_cubes(
                data_normalized,
                level=threshold,
                spacing=(voxel_size * scale_factor,) * 3,
                allow_degenerate=False
            )
        except Exception as e:
            # Try with slightly different threshold if marching cubes fails
            threshold_alt = threshold * 0.9 if threshold > 0.5 else threshold * 1.1
            verts, faces, normals, values = measure.marching_cubes(
                data_normalized,
                level=threshold_alt,
                spacing=(voxel_size * scale_factor,) * 3,
                allow_degenerate=True
            )

        # Limit mesh complexity for browser performance
        max_vertices = 500000
        if len(verts) > max_vertices:
            # Decimate mesh (simple approach - skip vertices)
            step = len(verts) // max_vertices + 1
            # For proper decimation, use mesh simplification algorithms
            # For now, we'll just send what we have with a warning
            pass

        # Convert to flat lists for JSON
        vertices = verts.flatten().tolist()
        normals_flat = normals.flatten().tolist()
        indices = faces.flatten().tolist()

        return jsonify({
            'vertices': vertices,
            'normals': normals_flat,
            'indices': indices,
            'threshold': threshold,
            'suggestedThreshold': suggested_threshold,
            'volumeSize': [int(nx), int(ny), int(nz)],
            'voxelSize': voxel_size,
            'minVal': min_val,
            'maxVal': max_val,
            'mrcFile': model_file.name
        })

    except ImportError as e:
        return error_response(f'Missing required library: {e}. Install with: pip install scikit-image scipy', 500)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return error_response(str(e), 500)


@app.route('/api/jobs/<path:job_id>/3d-results-summary', methods=['GET'])
def get_3d_results_summary(job_id):
    """Get comprehensive 3D results data for the Results3DDialog.

    Returns:
        - jobType: Type of job (Refine3D, Class3D, InitialModel, PostProcess)
        - jobInfo: Job metadata (resolution, voxel size, etc.)
        - mrcFiles: List of MRC files with metadata
        - fscData: FSC curve data (if available)
        - outputFiles: All output files with types
    """
    project_dir = get_project_dir()

    try:
        safe_path(project_dir, job_id)
    except ValueError:
        return error_response('Invalid job path', 400)

    job_dir = Path(project_dir) / job_id

    if not job_dir.exists():
        return error_response('Job not found', 404)

    try:
        import mrcfile

        # Determine job type from job_id
        job_type = job_id.split('/')[0] if '/' in job_id else 'Unknown'

        # Initialize response structure
        result = {
            'jobType': job_type,
            'jobInfo': {
                'jobId': job_id,
                'jobType': job_type,
            },
            'mrcFiles': [],
            'fscData': [],
            'outputFiles': []
        }

        # Collect all output files
        for f in job_dir.rglob('*'):
            if f.is_file():
                rel_path = str(f.relative_to(job_dir))
                # Skip hidden files and backup files
                if rel_path.startswith('.') or '~' in rel_path:
                    continue

                # Determine file type
                ext = f.suffix.lower()
                if ext == '.mrc':
                    file_type = 'mrc'
                elif ext == '.star':
                    file_type = 'star'
                elif ext == '.pdf':
                    file_type = 'pdf'
                else:
                    file_type = 'other'

                result['outputFiles'].append({
                    'name': rel_path,
                    'path': str(f),
                    'size': f.stat().st_size,
                    'type': file_type
                })

        # Collect MRC files with metadata
        mrc_files = list(job_dir.glob('*.mrc')) + list(job_dir.glob('**/*.mrc'))
        mrc_files = list(set(mrc_files))  # Remove duplicates

        for mrc_path in mrc_files:
            mrc_info = {
                'filename': mrc_path.name,
            }

            # Extract class number if present
            import re
            class_match = re.search(r'class(\d+)', mrc_path.name, re.IGNORECASE)
            if class_match:
                mrc_info['classNumber'] = int(class_match.group(1))

            # Try to read voxel size from MRC header
            try:
                with mrcfile.open(str(mrc_path), mode='r') as mrc:
                    voxel_size = float(mrc.voxel_size.x) if mrc.voxel_size.x > 0 else 1.0
                    mrc_info['voxelSize'] = voxel_size
                    result['jobInfo']['voxelSize'] = voxel_size
                    result['jobInfo']['volumeSize'] = list(mrc.data.shape)
            except Exception as e:
                print(f"[API] mrc voxel-size read failed for {mrc_path.name}: {e}", flush=True)

            result['mrcFiles'].append(mrc_info)

        # Sort MRC files - prefer non-half maps and final iterations
        result['mrcFiles'].sort(key=lambda x: (
            'half' in x['filename'].lower(),  # Put half maps last
            -x.get('classNumber', 0)  # Higher class numbers first
        ))

        # Parse FSC data for Refine3D, PostProcess jobs
        if job_type in ['Refine3D', 'PostProcess']:
            fsc_data = _parse_fsc_data(job_dir, job_type)
            result['fscData'] = fsc_data

            # Calculate final resolution from FSC data
            if fsc_data:
                fscs = [d['fsc'] for d in fsc_data if d.get('type') != 'unmasked']
                resolutions = [d['resolution'] for d in fsc_data if d.get('type') != 'unmasked']
                if len(fscs) > 1:
                    for i in range(len(fscs) - 1):
                        if fscs[i] >= 0.143 and fscs[i + 1] < 0.143:
                            final_resolution = resolutions[i] + (0.143 - fscs[i]) * (resolutions[i + 1] - resolutions[i]) / (fscs[i + 1] - fscs[i])
                            result['jobInfo']['finalResolution'] = round(final_resolution, 2)
                            break

        # For Class3D, parse class distribution from model.star
        if job_type == 'Class3D':
            _add_class3d_metadata(job_dir, result)

        # Parse iteration from filenames
        iter_match = re.search(r'it(\d+)', str(job_dir))
        for f in job_dir.glob('*_it*'):
            iter_match = re.search(r'it(\d+)', f.name)
            if iter_match:
                result['jobInfo']['iteration'] = int(iter_match.group(1))
                break

        return jsonify(result)

    except Exception as e:
        import traceback
        traceback.print_exc()
        return error_response(str(e), 500)


def _parse_fsc_data(job_dir, job_type):
    """Parse FSC data from STAR files."""
    fsc_data = []

    # Find FSC or model star files
    fsc_files = []
    for pattern in ['*_fsc.star', '*_model.star', 'postprocess.star']:
        fsc_files.extend(job_dir.glob(pattern))

    if not fsc_files:
        return fsc_data

    # Use the most recent one
    fsc_files.sort(key=lambda x: x.stat().st_mtime, reverse=True)
    fsc_file = fsc_files[0]

    try:
        with open(fsc_file, 'r') as f:
            content = f.read()

        # For PostProcess, look for different FSC types
        if job_type == 'PostProcess':
            # Parse masked FSC
            masked_fsc = _extract_fsc_block(content, 'data_fsc_masked')
            for item in masked_fsc:
                item['type'] = 'masked'
            fsc_data.extend(masked_fsc)

            # Parse unmasked FSC
            unmasked_fsc = _extract_fsc_block(content, 'data_fsc_unmasked')
            for item in unmasked_fsc:
                item['type'] = 'unmasked'
            fsc_data.extend(unmasked_fsc)

            # Parse corrected FSC
            corrected_fsc = _extract_fsc_block(content, 'data_fsc')
            for item in corrected_fsc:
                item['type'] = 'corrected'
            fsc_data.extend(corrected_fsc)
        else:
            # For Refine3D, parse standard FSC
            fsc_data = _extract_fsc_block(content, 'data_fsc')
            if not fsc_data:
                fsc_data = _extract_fsc_block(content, 'data_model_class')

    except Exception as e:
        print(f"Error parsing FSC: {e}")

    return fsc_data


def _extract_fsc_block(content, block_name):
    """Extract FSC values from a specific data block."""
    fsc_data = []
    lines = content.split('\n')

    in_block = False
    in_loop = False
    col_names = []

    for line in lines:
        line = line.strip()

        if line.startswith(f'{block_name}') or line.lower().startswith(f'{block_name.lower()}'):
            in_block = True
            col_names = []
            continue

        if in_block and line.startswith('loop_'):
            in_loop = True
            continue

        if in_block and in_loop and line.startswith('_rln'):
            col_names.append(line.split()[0])
            continue

        if in_block and in_loop and line and not line.startswith('_') and not line.startswith('#'):
            if line.startswith('data_'):
                break

            parts = line.split()
            if len(parts) >= 2 and len(col_names) >= 2:
                try:
                    # Find resolution and FSC columns
                    res_idx = None
                    fsc_idx = None
                    for i, col in enumerate(col_names):
                        if 'Resolution' in col and 'Angstrom' in col:
                            res_idx = i
                        elif 'FourierShellCorrelation' in col or 'GoldStandardFsc' in col:
                            fsc_idx = i

                    if res_idx is not None and fsc_idx is not None and len(parts) > max(res_idx, fsc_idx):
                        res = float(parts[res_idx])
                        fsc = float(parts[fsc_idx])
                        if 0 <= fsc <= 1 and res > 0:
                            fsc_data.append({'resolution': res, 'fsc': fsc})
                except (ValueError, IndexError):
                    pass

    return fsc_data


def _add_class3d_metadata(job_dir, result):
    """Add Class3D-specific metadata (class distribution, resolution, particle counts)."""
    model_files = list(job_dir.glob('*_model.star'))
    if not model_files:
        return

    model_files.sort(key=lambda x: x.stat().st_mtime, reverse=True)
    model_file = model_files[0]

    try:
        with open(model_file, 'r') as f:
            content = f.read()

        # Parse class distribution from model_classes block
        lines = content.split('\n')
        in_class_block = False
        in_loop = False
        col_names = []

        class_metadata = {}

        for line in lines:
            line = line.strip()

            if 'data_model_classes' in line.lower():
                in_class_block = True
                col_names = []
                continue

            if in_class_block and line.startswith('loop_'):
                in_loop = True
                continue

            if in_class_block and in_loop and line.startswith('_rln'):
                col_names.append(line.split()[0])
                continue

            if in_class_block and in_loop and line and not line.startswith('_') and not line.startswith('#'):
                if line.startswith('data_'):
                    break

                parts = line.split()
                if len(parts) >= len(col_names):
                    try:
                        # Find column indices
                        dist_idx = next((i for i, c in enumerate(col_names) if 'ClassDistribution' in c), None)
                        res_idx = next((i for i, c in enumerate(col_names) if 'EstimatedResolution' in c), None)

                        class_num = len(class_metadata) + 1

                        if dist_idx is not None:
                            distribution = float(parts[dist_idx]) * 100  # Convert to percentage
                            class_metadata[class_num] = {'distribution': distribution}

                        if res_idx is not None and class_num in class_metadata:
                            class_metadata[class_num]['resolution'] = float(parts[res_idx])

                    except (ValueError, IndexError):
                        pass

        # Update MRC files with class metadata
        for mrc_info in result['mrcFiles']:
            class_num = mrc_info.get('classNumber')
            if class_num and class_num in class_metadata:
                mrc_info['distribution'] = class_metadata[class_num].get('distribution')
                mrc_info['resolution'] = class_metadata[class_num].get('resolution')

        # Calculate total particles
        total_particles = sum(m.get('particleCount', 0) for m in result['mrcFiles'])
        if total_particles > 0:
            result['jobInfo']['totalParticles'] = total_particles

    except Exception as e:
        print(f"Error parsing Class3D metadata: {e}")


# ============== Config / Defaults ==============

@app.route('/api/config/defaults', methods=['GET'])
def config_defaults():
    """Return server-side defaults the frontend needs at startup.

    Eliminates hardcoded paths in the React bundle. The default project
    directory was previously baked into JobConfigForm.tsx as a constant,
    which would break any deployment whose project root differs from
    ${HOME}/relion_projects.

    NOTE: in this module, `config` is the imported `config.py` module,
    not the singleton instance. Use the module-level alias
    `config.DEFAULT_PROJECT_DIR` (set at config.py top-level), and call
    methods on the singleton via `config.config.get_all_project_dirs()`.
    """
    try:
        all_dirs = config.config.get_all_project_dirs()
    except AttributeError:
        # Fallback if get_all_project_dirs is unavailable on this build
        all_dirs = [config.DEFAULT_PROJECT_DIR]
    return jsonify({
        'defaultProjectDir': config.DEFAULT_PROJECT_DIR,
        'allProjectDirs': all_dirs,
    })


# ============== Health Check ==============

@app.route('/api/health', methods=['GET'])
def health_check():
    """Health check endpoint."""
    return jsonify({
        'status': 'ok',
        'relion_path': config.RELION_BIN_PATH,
        'project_dir': get_project_dir(),
        'visualization_available': VISUALIZATION_AVAILABLE,
        'missing_libraries': VISUALIZATION_MISSING_LIBS
    })


@app.route('/api/visualization/status', methods=['GET'])
def visualization_status():
    """Check if visualization features are available."""
    return jsonify({
        'available': VISUALIZATION_AVAILABLE,
        'missingLibraries': VISUALIZATION_MISSING_LIBS,
        'installCommand': f'pip install {" ".join(VISUALIZATION_MISSING_LIBS)}' if VISUALIZATION_MISSING_LIBS else None
    })


# ============== Frontend static serving (standalone mode only) ==============
# Set RELION_SERVE_FRONTEND=1 when running Flask standalone (e.g., Mantis HPC)
# On OOD/Passenger, leave unset — Passenger serves the frontend via public/ symlink

if os.environ.get('RELION_SERVE_FRONTEND'):
    FRONTEND_DIR = Path(__file__).parent.parent / 'frontend'

    @app.route('/', defaults={'path': ''})
    @app.route('/<path:path>')
    def serve_frontend(path):
        """Serve the React frontend build (standalone mode only)."""
        if path and (FRONTEND_DIR / path).exists():
            return send_from_directory(str(FRONTEND_DIR), path)
        return send_from_directory(str(FRONTEND_DIR), 'index.html')


# ============== Main ==============

if __name__ == '__main__':
    # Ensure default project directory exists
    Path(config.DEFAULT_PROJECT_DIR).mkdir(parents=True, exist_ok=True)

    # Initialize job manager
    init_job_manager()

    print(f"Starting RELION Backend API Server")
    print(f"  RELION binaries: {config.RELION_BIN_PATH}")
    print(f"  Project directory: {get_project_dir()}")
    print(f"  Server: http://{config.HOST}:{config.PORT}")

    socketio.run(app, host=config.HOST, port=config.PORT, debug=config.DEBUG, allow_unsafe_werkzeug=True)
