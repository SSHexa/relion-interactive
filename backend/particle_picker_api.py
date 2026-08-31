"""
Particle Picker API Module

Provides REST API endpoints for the interactive particle picking application.
"""
import os
import io
import json
import glob
import uuid
import hashlib
from pathlib import Path
from typing import List, Dict, Optional, Tuple
from flask import Blueprint, request, jsonify, send_file, Response

# Try to import visualization libraries
try:
    import numpy as np
    import mrcfile
    from PIL import Image
    VISUALIZATION_AVAILABLE = True
except ImportError as e:
    VISUALIZATION_AVAILABLE = False
    print(f"Warning: Particle picker visualization disabled. Missing: {e}")

from star_parser import parse_star_file, write_star_file, get_next_job_number, get_table_rows

# Create Blueprint
particle_picker_bp = Blueprint('particle_picker', __name__, url_prefix='/api/particle-picker')


def error_response(message: str, status: int = 400, details: dict = None):
    """Standardized error response helper."""
    response = {'error': message}
    if details:
        response['details'] = details
    return jsonify(response), status


def safe_path(base_dir: Path, user_path: str) -> Path:
    """
    Safely resolve a user-provided path within a base directory.

    Prevents path traversal attacks by ensuring the resolved path
    is within the base directory bounds.
    """
    base = Path(base_dir).resolve()
    requested = (base / user_path).resolve()

    try:
        requested.relative_to(base)
    except ValueError:
        raise ValueError(f"Path traversal attempt blocked: {user_path}")

    return requested


# In-memory cache for picker jobs
picker_jobs = {}


def get_project_path(project: str) -> Path:
    """Get and validate project path."""
    project_path = Path(project)
    if not project_path.exists():
        raise ValueError(f"Project path does not exist: {project}")
    return project_path


def parse_ctf_star(project_path: Path, ctf_job: str = None) -> Dict[str, Dict]:
    """Parse CTF data from CtfFind job output."""
    ctf_data = {}

    # Find CTF job directory
    ctf_dir = project_path / 'CtfFind'
    if not ctf_dir.exists():
        return ctf_data

    if ctf_job:
        job_dirs = [ctf_dir / ctf_job]
    else:
        # Find latest CTF job
        job_dirs = sorted(ctf_dir.glob('job*'), reverse=True)

    for job_dir in job_dirs:
        star_file = job_dir / 'micrographs_ctf.star'
        if star_file.exists():
            try:
                data = parse_star_file(str(star_file))
                # Use get_table_rows which handles both 'micrographs' and 'data_micrographs'
                rows = get_table_rows(data, 'micrographs')
                for row in rows:
                    mic_name = Path(row.get('rlnMicrographName', '')).stem
                    ctf_data[mic_name] = {
                        'defocusU': float(row.get('rlnDefocusU', 0)),
                        'defocusV': float(row.get('rlnDefocusV', 0)),
                        'defocusAngle': float(row.get('rlnDefocusAngle', 0)),
                        'maxResolution': float(row.get('rlnCtfMaxResolution', 99)),
                        'ctfFom': float(row.get('rlnCtfFigureOfMerit', 0)),
                        'phaseShift': float(row.get('rlnPhaseShift', 0)),
                        'powerSpectrum': row.get('rlnCtfImage', ''),
                    }
                if rows:
                    break
            except Exception as e:
                print(f"Error parsing CTF star: {e}")

    return ctf_data


def parse_motioncorr_star(project_path: Path, motioncorr_job: str = None) -> Dict[str, Dict]:
    """Parse motion correction data."""
    motion_data = {}

    motion_dir = project_path / 'MotionCorr'
    if not motion_dir.exists():
        return motion_data

    if motioncorr_job:
        job_dirs = [motion_dir / motioncorr_job]
    else:
        job_dirs = sorted(motion_dir.glob('job*'), reverse=True)

    for job_dir in job_dirs:
        star_file = job_dir / 'corrected_micrographs.star'
        if star_file.exists():
            try:
                data = parse_star_file(str(star_file))
                # Use get_table_rows which handles both 'micrographs' and 'data_micrographs'
                rows = get_table_rows(data, 'micrographs')
                for row in rows:
                    mic_name = Path(row.get('rlnMicrographName', '')).stem
                    motion_data[mic_name] = {
                        'path': row.get('rlnMicrographName', ''),
                        'motionTotal': float(row.get('rlnAccumMotionTotal', 0)),
                        'motionEarly': float(row.get('rlnAccumMotionEarly', 0)),
                        'motionLate': float(row.get('rlnAccumMotionLate', 0)),
                    }
                if rows:
                    break
            except Exception as e:
                print(f"Error parsing MotionCorr star: {e}")

    return motion_data


def parse_autopick_coords(project_path: Path, mic_name: str, autopick_job: str = None) -> Tuple[List[Dict], int, str]:
    """Parse autopick coordinates for a micrograph."""
    particles = []
    box_size = 200
    source = ''

    autopick_dir = project_path / 'AutoPick'
    if not autopick_dir.exists():
        return particles, box_size, source

    if autopick_job:
        job_dirs = [autopick_dir / autopick_job]
    else:
        job_dirs = sorted(autopick_dir.glob('job*'), reverse=True)

    for job_dir in job_dirs:
        # Look for coordinate files matching the micrograph
        coord_patterns = [
            f"*{mic_name}*_autopick.star",
            f"*{mic_name}*.star",
        ]

        for pattern in coord_patterns:
            coord_files = list(job_dir.glob(f"**/{pattern}"))
            if coord_files:
                coord_file = coord_files[0]
                try:
                    data = parse_star_file(str(coord_file))
                    # Check various table names using get_table_rows
                    for table_name in ['', 'coordinate', 'particles', 'micrographs']:
                        rows = get_table_rows(data, table_name)
                        if rows:
                            for i, row in enumerate(rows):
                                particles.append({
                                    'id': f"ap_{i}",
                                    'x': float(row.get('rlnCoordinateX', 0)),
                                    'y': float(row.get('rlnCoordinateY', 0)),
                                    'fom': float(row.get('rlnAutopickFigureOfMerit', 0.5)),
                                    'source': 'autopick',
                                })
                            break

                    # Try to get box size from job params
                    source = f"AutoPick/{job_dir.name}"
                    break
                except Exception as e:
                    print(f"Error parsing autopick coords: {e}")

        if particles:
            break

    return particles, box_size, source


def mrc_to_png(mrc_path: Path, scale: float = 1.0) -> bytes:
    """Convert MRC file to PNG image bytes."""
    if not VISUALIZATION_AVAILABLE:
        raise RuntimeError("Visualization libraries not available")

    with mrcfile.open(str(mrc_path), mode='r', permissive=True) as mrc:
        data = mrc.data

        # Handle 3D stacks (take middle slice or sum)
        if len(data.shape) == 3:
            data = np.mean(data, axis=0)

        # Normalize to 0-255
        data = data.astype(np.float32)
        data_min, data_max = np.percentile(data, [2, 98])
        data = np.clip(data, data_min, data_max)
        data = ((data - data_min) / (data_max - data_min) * 255).astype(np.uint8)

        # Create PIL image
        img = Image.fromarray(data)

        # Scale if needed
        if scale != 1.0:
            new_size = (int(img.width * scale), int(img.height * scale))
            img = img.resize(new_size, Image.Resampling.LANCZOS)

        # Convert to PNG bytes
        img_bytes = io.BytesIO()
        img.save(img_bytes, format='PNG')
        img_bytes.seek(0)

        return img_bytes.getvalue()


# Backend disk cache for converted picker PNGs.
# Keyed by (mrc absolute path, mtime, scale) so MotionCorr reruns invalidate
# automatically. No eviction yet — picker datasets are bounded.
PICKER_IMAGE_CACHE_DIR = Path.home() / '.relion5_backend' / 'picker_image_cache'


def _picker_cache_etag(mrc_path: Path, scale: float) -> str:
    """Stable cache key / HTTP ETag for a (mrc, scale) pair."""
    try:
        mtime = mrc_path.stat().st_mtime_ns
    except OSError:
        mtime = 0
    raw = f"{mrc_path}|{mtime}|{scale}"
    return hashlib.sha1(raw.encode('utf-8')).hexdigest()


def _load_cached_or_render(mrc_path: Path, scale: float) -> Tuple[bytes, str]:
    """Return (png_bytes, etag). Reads from disk cache if present; otherwise
    invokes mrc_to_png() and writes through to cache. Cache failures are
    logged but never fatal — the user still gets their image."""
    etag = _picker_cache_etag(mrc_path, scale)
    cache_file = PICKER_IMAGE_CACHE_DIR / f"{etag}.png"
    if cache_file.exists():
        try:
            print(f"[picker-image] CACHE HIT {mrc_path.name} scale={scale}", flush=True)
            return cache_file.read_bytes(), etag
        except OSError as e:
            print(f"[picker-image] cache read failed: {e}", flush=True)
    print(f"[picker-image] CACHE MISS {mrc_path.name} scale={scale}", flush=True)
    png_data = mrc_to_png(mrc_path, scale)
    try:
        PICKER_IMAGE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        # Atomic write so a concurrent reader never sees a half-written file.
        tmp = cache_file.with_suffix('.png.tmp')
        tmp.write_bytes(png_data)
        tmp.replace(cache_file)
    except OSError as e:
        print(f"[picker-image] cache write failed: {e}", flush=True)
    return png_data, etag


@particle_picker_bp.route('/micrographs', methods=['GET'])
def get_micrographs():
    """Get list of micrographs with quality metrics."""
    try:
        project = request.args.get('project', '')
        ctf_job = request.args.get('ctf_job', '')
        autopick_job = request.args.get('autopick_job', '')
        motioncorr_job = request.args.get('motioncorr_job', '')
        manualpick_job = request.args.get('manualpick_job', '')

        project_path = get_project_path(project)

        # When opened from a ManualPick job's results panel, the picker doesn't
        # know which CtfFind/MotionCorr job produced the input micrographs.
        # Resolve that here by reading the ManualPick job.star's fn_in value,
        # which looks like 'CtfFind/job003/micrographs_ctf.star' (or sometimes
        # a MotionCorr path). We promote the upstream job ref to ctf_job /
        # motioncorr_job so the rest of this handler stays generic.
        if manualpick_job and not (ctf_job or motioncorr_job):
            try:
                # manualpick_job can arrive as 'job045' or 'ManualPick/job045'
                mp_rel = manualpick_job
                if not mp_rel.startswith('ManualPick/'):
                    mp_rel = f'ManualPick/{mp_rel}'
                mp_dir = safe_path(project_path, mp_rel)
                job_star = mp_dir / 'job.star'
                if job_star.exists():
                    content = job_star.read_text()
                    import re as _re
                    m = _re.search(r'\bfn_in\b\s+(\S+)', content)
                    if m:
                        fn_in = m.group(1).strip().strip('"').strip("'")
                        upstream = _re.match(r'([A-Z][a-zA-Z0-9]+)/(job\d+)', fn_in)
                        if upstream:
                            up_type, up_job = upstream.group(1), upstream.group(2)
                            if up_type == 'CtfFind':
                                ctf_job = up_job
                            elif up_type == 'MotionCorr':
                                motioncorr_job = up_job
            except Exception as e:
                print(f"[particle-picker] Failed to resolve ManualPick upstream: {e}", flush=True)

        # Parse CTF data
        ctf_data = parse_ctf_star(project_path, ctf_job if ctf_job else None)

        # Parse MotionCorr data
        motion_data = parse_motioncorr_star(project_path, motioncorr_job if motioncorr_job else None)

        # Count particles per micrograph
        particle_counts = {}
        autopick_dir = project_path / 'AutoPick'
        if autopick_dir.exists():
            for job_dir in sorted(autopick_dir.glob('job*'), reverse=True):
                coord_files = list(job_dir.glob('**/*_autopick.star'))
                for coord_file in coord_files:
                    try:
                        data = parse_star_file(str(coord_file))
                        for table_name in ['', 'coordinate', 'particles']:
                            rows = get_table_rows(data, table_name)
                            if rows:
                                mic_name = coord_file.stem.replace('_autopick', '')
                                particle_counts[mic_name] = len(rows)
                                break
                    except Exception as e:
                        print(f"Warning: Failed to parse autopick file {coord_file}: {e}")
                break  # Only use latest job

        # Build micrograph list
        micrographs = []

        # Get micrographs from CTF or MotionCorr data
        all_mic_names = set(list(ctf_data.keys()) + list(motion_data.keys()))

        for mic_name in sorted(all_mic_names):
            ctf = ctf_data.get(mic_name, {})
            motion = motion_data.get(mic_name, {})

            micrograph = {
                'id': mic_name,
                'name': mic_name,
                'path': motion.get('path', ''),
                'width': 4096,  # Default, will be updated when image is loaded
                'height': 4096,
                'pixelSize': 1.0,  # Should come from optics table
                'metrics': {
                    'defocusU': ctf.get('defocusU', 0),
                    'defocusV': ctf.get('defocusV', 0),
                    'defocusAngle': ctf.get('defocusAngle', 0),
                    'maxResolution': ctf.get('maxResolution', 99),
                    'ctfFom': ctf.get('ctfFom', 0),
                    'particleCount': particle_counts.get(mic_name, 0),
                    'motionTotal': motion.get('motionTotal', 0),
                    'motionEarly': motion.get('motionEarly', 0),
                    'motionLate': motion.get('motionLate', 0),
                },
            }
            micrographs.append(micrograph)

        return jsonify({
            'micrographs': micrographs,
            'total': len(micrographs),
            'ctfJob': ctf_job,
            'autopickJob': autopick_job,
            'motioncorrJob': motioncorr_job,
            'manualpickJob': manualpick_job,
        })

    except Exception as e:
        return error_response(str(e), 500)


@particle_picker_bp.route('/micrograph-image', methods=['GET'])
def get_micrograph_image():
    """Get micrograph image as PNG."""
    try:
        project = request.args.get('project', '')
        mic_id = request.args.get('mic_id', '')
        scale = float(request.args.get('scale', 0.25))
        mode = request.args.get('mode', 'raw')

        if not VISUALIZATION_AVAILABLE:
            return error_response('Visualization libraries not available', 500)

        project_path = get_project_path(project)

        # Find MRC file
        mrc_file = None

        # Try MotionCorr first
        motion_dir = project_path / 'MotionCorr'
        if motion_dir.exists():
            for job_dir in sorted(motion_dir.glob('job*'), reverse=True):
                # Check corrected micrographs
                patterns = [
                    f"**/*{mic_id}*.mrc",
                    f"Movies/*{mic_id}*.mrc",
                    f"*{mic_id}*.mrc",
                ]
                for pattern in patterns:
                    matches = list(job_dir.glob(pattern))
                    if matches:
                        mrc_file = matches[0]
                        break
                if mrc_file:
                    break

        if not mrc_file:
            return error_response(f'MRC file not found for {mic_id}', 404)

        # Compute ETag first so we can short-circuit on If-None-Match without
        # decoding the MRC. ETag is cheap (one stat() call).
        etag = _picker_cache_etag(mrc_file, scale)
        client_etag = request.headers.get('If-None-Match', '').strip().strip('"')
        if client_etag and client_etag == etag:
            return Response(status=304, headers={
                'ETag': f'"{etag}"',
                'Cache-Control': 'public, max-age=3600',
            })

        # Cache hit serves bytes from disk; miss runs the full pipeline.
        png_data, _ = _load_cached_or_render(mrc_file, scale)

        return Response(png_data, mimetype='image/png', headers={
            'ETag': f'"{etag}"',
            'Cache-Control': 'public, max-age=3600',
        })

    except Exception as e:
        return error_response(str(e), 500)


@particle_picker_bp.route('/ctf-image', methods=['GET'])
def get_ctf_image():
    """Get CTF power spectrum image."""
    try:
        project = request.args.get('project', '')
        mic_id = request.args.get('mic_id', '')

        if not VISUALIZATION_AVAILABLE:
            return error_response('Visualization libraries not available', 500)

        project_path = get_project_path(project)

        # Find CTF image
        ctf_dir = project_path / 'CtfFind'
        ctf_image = None

        for job_dir in sorted(ctf_dir.glob('job*'), reverse=True):
            patterns = [
                f"**/*{mic_id}*.ctf:mrc",
                f"**/*{mic_id}*_ctf.mrc",
                f"**/*{mic_id}*.mrc",
            ]
            for pattern in patterns:
                matches = list(job_dir.glob(pattern))
                if matches:
                    ctf_image = matches[0]
                    break
            if ctf_image:
                break

        if not ctf_image:
            return error_response('CTF image not found', 404)

        # Convert to PNG
        png_data = mrc_to_png(ctf_image, scale=1.0)

        return Response(png_data, mimetype='image/png')

    except Exception as e:
        return error_response(str(e), 500)


@particle_picker_bp.route('/particles', methods=['GET'])
def get_particles():
    """Get particle coordinates for a micrograph."""
    try:
        project = request.args.get('project', '')
        mic_id = request.args.get('mic_id', '')
        source = request.args.get('source', '')

        project_path = get_project_path(project)

        particles, box_size, autopick_source = parse_autopick_coords(
            project_path, mic_id, source if source else None
        )

        # Also check for ManualPick coordinates
        manual_dir = project_path / 'ManualPick'
        if manual_dir.exists():
            for job_dir in sorted(manual_dir.glob('job*'), reverse=True):
                coord_files = list(job_dir.glob(f"**/*{mic_id}*.star"))
                for coord_file in coord_files:
                    try:
                        data = parse_star_file(str(coord_file))
                        for table_name in ['', 'coordinate', 'particles']:
                            rows = get_table_rows(data, table_name)
                            if rows:
                                for i, row in enumerate(rows):
                                    particles.append({
                                        'id': f"mp_{i}",
                                        'x': float(row.get('rlnCoordinateX', 0)),
                                        'y': float(row.get('rlnCoordinateY', 0)),
                                        'fom': 1.0,
                                        'source': 'manual',
                                    })
                                break
                    except Exception as e:
                        print(f"Warning: Failed to parse manual pick file {coord_file}: {e}")
                break

        return jsonify({
            'particles': particles,
            'boxSize': box_size,
            'source': autopick_source,
            'micrographId': mic_id,
        })

    except Exception as e:
        return error_response(str(e), 500)


@particle_picker_bp.route('/particles', methods=['POST'])
def save_particles():
    """Save particle coordinates."""
    try:
        data = request.json
        project = data.get('project', '')
        mic_id = data.get('mic_id', '')
        particles = data.get('particles', [])
        box_size = data.get('box_size', 200)

        project_path = get_project_path(project)

        # Create or update ManualPick job
        manual_dir = project_path / 'ManualPick'
        manual_dir.mkdir(exist_ok=True)

        # Find or create job directory
        job_dirs = sorted(manual_dir.glob('job*'))
        if job_dirs:
            job_dir = job_dirs[-1]
        else:
            job_number = get_next_job_number(str(project_path))
            job_dir = manual_dir / f'job{job_number:03d}'
            job_dir.mkdir()

            # Create job.star with correct format for write_star_file
            job_star = {
                'data_blocks': {
                    'data_job': {
                        'loops': [{
                            'columns': ['rlnJobTypeLabel', 'rlnJobIsContinue'],
                            'rows': [{'rlnJobTypeLabel': 'relion.manualpick', 'rlnJobIsContinue': '0'}]
                        }]
                    }
                }
            }
            write_star_file(str(job_dir / 'job.star'), job_star)

        # Write coordinate file with correct format for write_star_file
        coord_file = job_dir / f'{mic_id}_manualpick.star'

        star_data = {
            'data_blocks': {
                'data_': {
                    'loops': [{
                        'columns': ['rlnCoordinateX', 'rlnCoordinateY'],
                        'rows': [
                            {
                                'rlnCoordinateX': str(p['x']),
                                'rlnCoordinateY': str(p['y']),
                            }
                            for p in particles
                        ]
                    }]
                }
            }
        }

        write_star_file(str(coord_file), star_data)

        return jsonify({
            'success': True,
            'message': f'Saved {len(particles)} particles',
            'path': str(coord_file),
        })

    except Exception as e:
        return error_response(str(e), 500)


@particle_picker_bp.route('/run-picker', methods=['POST'])
def run_picker():
    """Run AI picker (LoG or Topaz) on micrographs."""
    try:
        data = request.json
        project = data.get('project', '')
        picker = data.get('picker', 'log')
        micrograph_ids = data.get('micrograph_ids', [])
        params = data.get('params', {})

        # Generate job ID
        job_id = str(uuid.uuid4())[:8]

        # Store job status
        picker_jobs[job_id] = {
            'status': 'running',
            'progress': 0,
            'picker': picker,
            'micrographs': micrograph_ids,
            'params': params,
        }

        # TODO: Actually run the picker in background
        # For now, just return immediately
        picker_jobs[job_id]['status'] = 'completed'
        picker_jobs[job_id]['progress'] = 100

        return jsonify({
            'jobId': job_id,
            'status': 'running',
        })

    except Exception as e:
        return error_response(str(e), 500)


@particle_picker_bp.route('/picker-status/<job_id>', methods=['GET'])
def get_picker_status(job_id: str):
    """Get status of a picker job."""
    job = picker_jobs.get(job_id)
    if not job:
        return error_response('Job not found', 404)

    return jsonify({
        'status': job['status'],
        'progress': job['progress'],
    })


@particle_picker_bp.route('/export', methods=['POST'])
def export_particles():
    """Export particles to STAR file."""
    try:
        data = request.json
        project = data.get('project', '')
        format_type = data.get('format', 'star')
        include_rejected = data.get('includeRejected', False)

        project_path = get_project_path(project)

        # Collect all particles from ManualPick
        manual_dir = project_path / 'ManualPick'
        if not manual_dir.exists():
            return error_response('No manual picks found', 404)

        # Find latest job
        job_dirs = sorted(manual_dir.glob('job*'))
        if not job_dirs:
            return error_response('No manual pick jobs found', 404)

        job_dir = job_dirs[-1]
        output_path = job_dir / 'manualpick.star'

        # Collect all coordinate files
        all_particles = []
        coord_files = list(job_dir.glob('*_manualpick.star'))

        for coord_file in coord_files:
            mic_name = coord_file.stem.replace('_manualpick', '')
            try:
                coord_data = parse_star_file(str(coord_file))
                rows = get_table_rows(coord_data, '')
                for row in rows:
                    all_particles.append({
                        'micrograph': mic_name,
                        'x': row.get('rlnCoordinateX', '0'),
                        'y': row.get('rlnCoordinateY', '0'),
                    })
            except Exception as e:
                print(f"Warning: Failed to parse coordinate file {coord_file}: {e}")

        # Write combined STAR file with correct format for write_star_file
        combined_data = {
            'data_blocks': {
                'data_coordinate_files': {
                    'loops': [{
                        'columns': ['rlnMicrographName', 'rlnMicrographCoordinates'],
                        'rows': [
                            {
                                'rlnMicrographName': f.stem.replace('_manualpick', ''),
                                'rlnMicrographCoordinates': str(f),
                            }
                            for f in coord_files
                        ]
                    }]
                }
            }
        }

        write_star_file(str(output_path), combined_data)

        return jsonify({
            'success': True,
            'outputPath': str(output_path),
            'particleCount': len(all_particles),
        })

    except Exception as e:
        return error_response(str(e), 500)


@particle_picker_bp.route('/create-manualpick-job', methods=['POST'])
def create_manualpick_job():
    """Create a ManualPick job in the RELION pipeline."""
    try:
        data = request.json
        project = data.get('project', '')
        job_alias = data.get('job_alias', '')

        project_path = get_project_path(project)

        manual_dir = project_path / 'ManualPick'
        manual_dir.mkdir(exist_ok=True)

        # Find next available job number (check if directory exists)
        job_number = get_next_job_number(str(project_path))
        job_dir = manual_dir / f'job{job_number:03d}'

        # If directory exists, find next available number
        while job_dir.exists():
            job_number += 1
            job_dir = manual_dir / f'job{job_number:03d}'

        job_name = f'job{job_number:03d}'
        job_dir.mkdir()

        # Create job.star with correct format for write_star_file
        job_star = {
            'data_blocks': {
                'data_job': {
                    'loops': [{
                        'columns': ['rlnJobTypeLabel', 'rlnJobIsContinue'],
                        'rows': [{'rlnJobTypeLabel': 'relion.manualpick', 'rlnJobIsContinue': '0'}]
                    }]
                }
            }
        }
        write_star_file(str(job_dir / 'job.star'), job_star)

        # Create success marker
        (job_dir / 'RELION_JOB_EXIT_SUCCESS').touch()

        # Create note.txt
        with open(job_dir / 'note.txt', 'w') as f:
            f.write(f"ManualPick job created by RELION Web UI Particle Picker\n")
            if job_alias:
                f.write(f"Alias: {job_alias}\n")

        return jsonify({
            'success': True,
            'jobPath': str(job_dir),
            'jobId': job_name,
        })

    except Exception as e:
        return error_response(str(e), 500)


@particle_picker_bp.route('/metrics', methods=['GET'])
def get_metrics():
    """Get metrics data for charts."""
    try:
        project = request.args.get('project', '')
        metric = request.args.get('metric', 'defocus')

        project_path = get_project_path(project)

        # Parse CTF data for metrics
        ctf_data = parse_ctf_star(project_path)
        motion_data = parse_motioncorr_star(project_path)

        data_points = []
        values = []

        all_mics = set(list(ctf_data.keys()) + list(motion_data.keys()))

        for mic_name in sorted(all_mics):
            ctf = ctf_data.get(mic_name, {})
            motion = motion_data.get(mic_name, {})

            if metric == 'defocus':
                value = (ctf.get('defocusU', 0) + ctf.get('defocusV', 0)) / 2
            elif metric == 'resolution':
                value = ctf.get('maxResolution', 99)
            elif metric == 'ctfFom':
                value = ctf.get('ctfFom', 0)
            elif metric == 'motion':
                value = motion.get('motionTotal', 0)
            else:
                value = 0

            data_points.append({
                'micrographId': mic_name,
                'micrographName': mic_name,
                'value': value,
            })
            values.append(value)

        # Calculate statistics
        if values:
            import statistics
            return jsonify({
                'metric': metric,
                'data': data_points,
                'min': min(values),
                'max': max(values),
                'mean': statistics.mean(values),
                'std': statistics.stdev(values) if len(values) > 1 else 0,
            })
        else:
            return jsonify({
                'metric': metric,
                'data': [],
                'min': 0,
                'max': 0,
                'mean': 0,
                'std': 0,
            })

    except Exception as e:
        return error_response(str(e), 500)


@particle_picker_bp.route('/ctf-data', methods=['GET'])
def get_ctf_data():
    """Get CTF data for a specific micrograph."""
    try:
        project = request.args.get('project', '')
        mic_id = request.args.get('mic_id', '')

        project_path = get_project_path(project)
        ctf_data = parse_ctf_star(project_path)

        if mic_id in ctf_data:
            return jsonify(ctf_data[mic_id])
        else:
            return error_response('CTF data not found', 404)

    except Exception as e:
        return error_response(str(e), 500)
