"""
STAR file parser for RELION pipeline files.
"""
import re
import threading
from typing import Dict, List, Any, Optional
from pathlib import Path

# Lock for thread-safe pipeline STAR file modifications.
# Both add_process_to_pipeline() and update_process_status() modify
# default_pipeline.star — this prevents concurrent writes.
_pipeline_star_lock = threading.Lock()


def parse_star_file(filepath: str) -> Dict[str, Any]:
    """Parse a STAR file and return its contents as a dictionary."""
    result = {
        'data_blocks': {},
        'version': None
    }

    if not Path(filepath).exists():
        return result

    with open(filepath, 'r') as f:
        content = f.read()

    # Check for RELION version
    version_match = re.search(r'# version (\d+\.\d+)', content)
    if version_match:
        result['version'] = version_match.group(1)

    # Split into data blocks
    blocks = re.split(r'\n(data_\w+)\s*\n', content)

    current_block = None
    for i, block in enumerate(blocks):
        if block.startswith('data_'):
            current_block = block
            result['data_blocks'][current_block] = {
                'loops': [],
                'values': {}
            }
        elif current_block and block.strip():
            parse_data_block(block, result['data_blocks'][current_block])

    return result


def parse_data_block(content: str, block_data: Dict) -> None:
    """Parse a single data block."""
    lines = content.strip().split('\n')

    i = 0
    while i < len(lines):
        line = lines[i].strip()

        if line.startswith('loop_'):
            # Parse loop
            loop_data = {'columns': [], 'rows': []}
            i += 1

            # Get column names
            while i < len(lines) and lines[i].strip().startswith('_'):
                col_match = re.match(r'_(\w+)\s*(?:#\d+)?', lines[i].strip())
                if col_match:
                    loop_data['columns'].append(col_match.group(1))
                i += 1

            # Get data rows
            while i < len(lines) and lines[i].strip() and not lines[i].strip().startswith('data_') and not lines[i].strip().startswith('loop_'):
                row_line = lines[i].strip()
                if row_line and not row_line.startswith('#'):
                    values = parse_star_line(row_line)
                    if len(values) == len(loop_data['columns']):
                        row_dict = dict(zip(loop_data['columns'], values))
                        loop_data['rows'].append(row_dict)
                i += 1

            block_data['loops'].append(loop_data)
            continue

        elif line.startswith('_'):
            # Parse single value
            match = re.match(r'_(\w+)\s+(.+)', line)
            if match:
                block_data['values'][match.group(1)] = match.group(2).strip()

        i += 1


def parse_star_line(line: str) -> List[str]:
    """Parse a single line of STAR data, handling quoted strings."""
    values = []
    current = ''
    in_quotes = False

    for char in line:
        if char == '"' and not in_quotes:
            in_quotes = True
        elif char == '"' and in_quotes:
            in_quotes = False
        elif char in ' \t' and not in_quotes:
            if current:
                values.append(current)
                current = ''
        else:
            current += char

    if current:
        values.append(current)

    return values


def write_star_file(filepath: str, data: Dict[str, Any]) -> None:
    """Write a STAR file from dictionary data."""
    with open(filepath, 'w') as f:
        if data.get('version'):
            f.write(f"\n# version {data['version']}\n")

        for block_name, block_data in data.get('data_blocks', {}).items():
            f.write(f"\n{block_name}\n\n")

            # Write single values
            for key, value in block_data.get('values', {}).items():
                f.write(f"_{key} {value}\n")

            # Write loops
            for loop in block_data.get('loops', []):
                f.write("loop_\n")
                for i, col in enumerate(loop['columns']):
                    f.write(f"_{col} #{i+1}\n")

                for row in loop['rows']:
                    values = [str(row.get(col, '')) for col in loop['columns']]
                    f.write(' '.join(values) + '\n')

                f.write('\n')


def normalize_job_type(type_label: str) -> str:
    """Normalize job type from pipeline format (e.g., 'relion.postprocess') to UI format ('PostProcess')."""
    if not type_label:
        return ''

    # Remove 'relion.' prefix if present
    if type_label.startswith('relion.'):
        type_label = type_label[7:]  # Remove 'relion.' prefix

    # Convert to PascalCase (e.g., 'postprocess' -> 'PostProcess', 'ctfrefine' -> 'CtfRefine')
    # Handle common job types with specific mappings
    type_mappings = {
        'import': 'Import',
        'motioncorr': 'MotionCorr',
        'ctffind': 'CtfFind',
        'autopick': 'AutoPick',
        'extract': 'Extract',
        'class2d': 'Class2D',
        'select': 'Select',
        'inimodel': 'InitialModel',
        'class3d': 'Class3D',
        'refine3d': 'Refine3D',
        'ctfrefine': 'CtfRefine',
        'polish': 'Polish',
        'postprocess': 'PostProcess',
        'maskcreate': 'MaskCreate',
        'localres': 'LocalRes',
        'manualpick': 'ManualPick',
        'classselect': 'ClassSelect',
        'joinstar': 'JoinStar',
        'subtract': 'Subtract',
        # Tomography job types
        'tomoimport': 'TomoImport',
        'tomoexcludetilts': 'TomoExcludeTilts',
        'tomoaligntilts': 'TomoAlignTilts',
        'tomoreconstruct': 'TomoReconstruct',
        'tomodenoise': 'TomoDenoise',
        'tomoimportparticles': 'TomoImportParticles',
        'tomosubtomo': 'TomoSubtomo',
        'tomoctfrefine': 'TomoCtfRefine',
        # Alternative underscore formats
        'tomo_import': 'TomoImport',
        'tomo_exclude_tilts': 'TomoExcludeTilts',
        'tomo_align_tilts': 'TomoAlignTilts',
        'tomo_reconstruct': 'TomoReconstruct',
        'tomo_denoise': 'TomoDenoise',
        'tomo_import_particles': 'TomoImportParticles',
        'tomo_subtomo': 'TomoSubtomo',
        'tomo_ctf_refine': 'TomoCtfRefine',
        # RELION-prefixed versions
        'relion.import': 'Import',
        'relion.motioncorr': 'MotionCorr',
        'relion.ctffind': 'CtfFind',
        'relion.autopick': 'AutoPick',
        'relion.extract': 'Extract',
        'relion.class2d': 'Class2D',
        'relion.select': 'Select',
        'relion.inimodel': 'InitialModel',
        'relion.class3d': 'Class3D',
        'relion.refine3d': 'Refine3D',
        'relion.ctfrefine': 'CtfRefine',
        'relion.polish': 'Polish',
        'relion.postprocess': 'PostProcess',
        'relion.maskcreate': 'MaskCreate',
        'relion.localres': 'LocalRes',
        'relion.manualpick': 'ManualPick',
        'relion.classselect': 'ClassSelect',
        'relion.joinstar': 'JoinStar',
        'relion.subtract': 'Subtract',
        # RELION-prefixed tomo types
        'relion.tomoimport': 'TomoImport',
        'relion.tomoexcludetilts': 'TomoExcludeTilts',
        'relion.tomoaligntilts': 'TomoAlignTilts',
        'relion.tomoreconstruct': 'TomoReconstruct',
        'relion.tomodenoise': 'TomoDenoise',
        'relion.tomoimportparticles': 'TomoImportParticles',
        'relion.tomosubtomo': 'TomoSubtomo',
        'relion.tomoctfrefine': 'TomoCtfRefine',
    }

    # Try direct mapping first (case-insensitive)
    lower_type = type_label.lower()
    if lower_type in type_mappings:
        return type_mappings[lower_type]

    # RELION 5 emits dotted subtypes (e.g. 'localres.own', 'modelangelo.inference',
    # 'select.interactive', 'extract.reextract', 'relion.modelangelo.inference').
    # Strip the suffix and retry mapping. Also handle the new RELION 5 families
    # that didn't exist in the base table above.
    if '.' in lower_type:
        base = lower_type.split('.')[0]
        # Re-add 'relion.' family resolution: 'relion.modelangelo.inference' -> 'modelangelo'
        if base == 'relion' and lower_type.count('.') >= 1:
            base = lower_type.split('.')[1]
        if base in type_mappings:
            return type_mappings[base]
        relion5_extras = {
            'modelangelo': 'ModelAngelo',
            'dynamight': 'DynaMight',
            'motionrefine': 'Polish',  # RELION 5 renamed Polish -> MotionRefine in some flows
            'initial': 'InitialModel',
            'initialmodel': 'InitialModel',
        }
        if base in relion5_extras:
            return relion5_extras[base]

    # Direct (no-dot) RELION 5 families
    relion5_extras_direct = {
        'modelangelo': 'ModelAngelo',
        'dynamight': 'DynaMight',
        'motionrefine': 'Polish',
    }
    if lower_type in relion5_extras_direct:
        return relion5_extras_direct[lower_type]

    # Fallback: capitalize each word (e.g., 'customjob' -> 'Customjob')
    return type_label.title().replace('_', '')


def get_pipeline_processes(project_dir: str) -> List[Dict[str, Any]]:
    """Get all processes from the pipeline STAR file with input/output edges."""
    pipeline_file = Path(project_dir) / 'default_pipeline.star'

    if not pipeline_file.exists():
        return []

    data = parse_star_file(str(pipeline_file))
    processes = []
    process_inputs = {}  # Map process_id -> list of input nodes
    process_outputs = {}  # Map process_id -> list of output nodes

    # Parse input edges: node -> process
    input_edges_block = data['data_blocks'].get('data_pipeline_input_edges', {})
    for loop in input_edges_block.get('loops', []):
        for row in loop['rows']:
            from_node = row.get('rlnPipeLineEdgeFromNode', '')
            to_process = row.get('rlnPipeLineEdgeProcess', '').rstrip('/')
            if to_process:
                if to_process not in process_inputs:
                    process_inputs[to_process] = []
                # Convert absolute paths to relative (e.g., /path/to/project/Import/job001/... -> Import/job001/...)
                if from_node:
                    # Extract relative path from absolute path
                    match = re.search(r'([A-Z][a-zA-Z0-9]+/job\d+(?:/[^\s]+)?)', from_node)
                    if match:
                        from_node = match.group(1)
                    if from_node not in process_inputs[to_process]:
                        process_inputs[to_process].append(from_node)

    # Parse output edges: process -> node
    output_edges_block = data['data_blocks'].get('data_pipeline_output_edges', {})
    for loop in output_edges_block.get('loops', []):
        for row in loop['rows']:
            from_process = row.get('rlnPipeLineEdgeProcess', '').rstrip('/')
            to_node = row.get('rlnPipeLineEdgeToNode', '')
            if from_process:
                if from_process not in process_outputs:
                    process_outputs[from_process] = []
                if to_node and to_node not in process_outputs[from_process]:
                    process_outputs[from_process].append(to_node)

    # Look for pipeline_processes data block
    processes_block = data['data_blocks'].get('data_pipeline_processes', {})

    for loop in processes_block.get('loops', []):
        for row in loop['rows']:
            process_id = row.get('rlnPipeLineProcessName', '').rstrip('/')
            # Convert status to numeric ProcessStatus values
            # STAR file may have strings ('Succeeded', 'Running', 'Failed') or ints
            STATUS_MAP = {
                'Scheduled': 0, 'Running': 1, 'Succeeded': 2,
                'Aborted': 3, 'Failed': 4,
            }
            status_val = row.get('rlnPipeLineProcessStatusLabel', 'Unknown')
            if isinstance(status_val, str):
                if status_val.isdigit():
                    status_val = int(status_val)
                else:
                    status_val = STATUS_MAP.get(status_val, 0)
            process = {
                'id': process_id,
                'name': process_id.split('/')[-1] if process_id else '',
                # RELION writes the literal string 'None' when no alias was set.
                # Surface that as an empty string so the UI can fall back cleanly.
                'alias': (lambda a: '' if a in ('None', 'none', None) else a)(
                    row.get('rlnPipeLineProcessAlias', '')
                ),
                'type': normalize_job_type(row.get('rlnPipeLineProcessTypeLabel', '')),
                'status': status_val,
                'inputNodes': process_inputs.get(process_id, []),
                'outputNodes': process_outputs.get(process_id, []),
            }
            processes.append(process)

    return processes


def get_pipeline_nodes(project_dir: str) -> List[Dict[str, Any]]:
    """Get all nodes from the pipeline STAR file."""
    pipeline_file = Path(project_dir) / 'default_pipeline.star'

    if not pipeline_file.exists():
        return []

    data = parse_star_file(str(pipeline_file))
    nodes = []

    # Look for pipeline_nodes data block
    nodes_block = data['data_blocks'].get('data_pipeline_nodes', {})

    for loop in nodes_block.get('loops', []):
        for row in loop['rows']:
            node_path = row.get('rlnPipeLineNodeName', '')
            # Extract just the filename for display, keep full path for selection
            node_name = node_path.split('/')[-1] if node_path else ''
            # Also include job name for context
            parts = node_path.split('/')
            if len(parts) >= 2:
                node_name = f"{parts[-2]}/{parts[-1]}"  # e.g., "job001/corrected_micrographs.star"
            node = {
                'name': node_name,
                'path': node_path,  # Full path for selection
                'type': row.get('rlnPipeLineNodeTypeLabel', ''),
            }
            nodes.append(node)

    return nodes


def get_table_rows(star_data: Dict[str, Any], table_name: str) -> List[Dict[str, Any]]:
    """Get rows from a specific table in STAR data.

    Handles both 'micrographs' and 'data_micrographs' style table names.
    """
    data_blocks = star_data.get('data_blocks', {})

    # Try the exact name first
    block = data_blocks.get(table_name, {})

    # If not found, try with 'data_' prefix
    if not block and not table_name.startswith('data_'):
        block = data_blocks.get(f'data_{table_name}', {})

    rows = []
    for loop in block.get('loops', []):
        rows.extend(loop.get('rows', []))
    return rows


def get_float_column(data, table_or_column: str, column_name: str = None) -> List[float]:
    """Extract a column as floats from table rows.

    Can be called two ways:
    1. get_float_column(rows, column_name) - rows is a list of dicts
    2. get_float_column(star_data, table_name, column_name) - star_data is parsed STAR data
    """
    # Determine which calling style
    if column_name is None:
        # Called with (rows, column_name)
        rows = data
        column = table_or_column
    else:
        # Called with (star_data, table_name, column_name)
        rows = get_table_rows(data, table_or_column)
        column = column_name

    values = []
    for row in rows:
        try:
            val = float(row.get(column, 0))
            values.append(val)
        except (ValueError, TypeError):
            pass
    return values


def compute_stats(values: List[float]) -> Dict[str, Any]:
    """Compute basic statistics for a list of values.

    Returns min/max/mean/std plus the original `values` array so the
    frontend can render per-item bar charts (e.g. per-micrograph motion).
    """
    if not values:
        return {'min': 0, 'max': 0, 'mean': 0, 'std': 0, 'values': []}

    n = len(values)
    mean = sum(values) / n
    variance = sum((x - mean) ** 2 for x in values) / n if n > 1 else 0

    return {
        'min': min(values),
        'max': max(values),
        'mean': mean,
        'std': variance ** 0.5,
        'values': list(values),
    }


def get_next_job_number(project_dir: str) -> int:
    """Get the next available job number from pipeline."""
    pipeline_file = Path(project_dir) / 'default_pipeline.star'

    if not pipeline_file.exists():
        return 1

    data = parse_star_file(str(pipeline_file))
    general_block = data['data_blocks'].get('data_pipeline_general', {})
    counter = general_block.get('values', {}).get('rlnPipeLineJobCounter', '1')

    try:
        return int(counter) + 1
    except ValueError:
        return 1


def _sanitize_pipeline_token(value: str, default: str = 'None') -> str:
    """Collapse whitespace in a STAR pipeline column value to underscores.

    The processes table is space-delimited with a fixed 4-column layout
    (name, alias, type, status). A multi-word alias such as 'Import movies'
    written by RELION's --pipeline_control breaks the row into 5 tokens,
    which the parser silently drops because column count no longer matches
    the loop header. We collapse whitespace at every Python write site so
    rows stay well-formed even when the C++ pipeliner produces sloppy values.
    See FIX_LOG #81.
    """
    s = (value if value is not None else '').strip()
    if not s:
        return default
    return re.sub(r'\s+', '_', s)


def add_process_to_pipeline(project_dir: str, job_type: str, job_number: int,
                           alias: str = 'None', status: str = 'Running',
                           input_nodes: List[str] = None,
                           output_nodes: List[Dict] = None) -> str:
    """Add a process to the pipeline STAR file, or update if it already exists.

    Checks for an existing process with the same name before appending.
    If found, updates status/alias in-place to prevent duplicates.
    """
    alias = _sanitize_pipeline_token(alias, default='None')
    with _pipeline_star_lock:
        pipeline_file = Path(project_dir) / 'default_pipeline.star'
        process_id = f"{job_type}/job{job_number:03d}"
        process_name = process_id + '/'

        # Read existing or create new
        if pipeline_file.exists():
            data = parse_star_file(str(pipeline_file))
            # Defensive: any pre-existing process rows may have aliases with
            # embedded whitespace (e.g. RELION wrote "Import movies"). Sanitize
            # them now so the eventual write-back produces a well-formed file.
            _proc_block = data.get('data_blocks', {}).get('data_pipeline_processes', {})
            for _loop in _proc_block.get('loops', []):
                for _row in _loop.get('rows', []):
                    _row['rlnPipeLineProcessAlias'] = _sanitize_pipeline_token(
                        _row.get('rlnPipeLineProcessAlias', 'None'), 'None')
        else:
            data = {
                'data_blocks': {
                    'data_pipeline_general': {'values': {'rlnPipeLineJobCounter': '0'}, 'loops': []},
                    'data_pipeline_processes': {'values': {}, 'loops': [{'columns': ['rlnPipeLineProcessName', 'rlnPipeLineProcessAlias', 'rlnPipeLineProcessTypeLabel', 'rlnPipeLineProcessStatusLabel'], 'rows': []}]},
                    'data_pipeline_nodes': {'values': {}, 'loops': [{'columns': ['rlnPipeLineNodeName', 'rlnPipeLineNodeTypeLabel'], 'rows': []}]},
                    'data_pipeline_input_edges': {'values': {}, 'loops': [{'columns': ['rlnPipeLineEdgeFromNode', 'rlnPipeLineEdgeProcess'], 'rows': []}]},
                    'data_pipeline_output_edges': {'values': {}, 'loops': [{'columns': ['rlnPipeLineEdgeProcess', 'rlnPipeLineEdgeToNode'], 'rows': []}]},
                }
            }

        # Update job counter
        if 'data_pipeline_general' in data['data_blocks']:
            data['data_blocks']['data_pipeline_general']['values']['rlnPipeLineJobCounter'] = str(job_number)

        # Check if process already exists (prevent duplicates)
        existing_row = None
        processes_block = data['data_blocks'].get('data_pipeline_processes', {})
        if processes_block.get('loops'):
            for row in processes_block['loops'][0]['rows']:
                if row.get('rlnPipeLineProcessName', '').rstrip('/') == process_id:
                    existing_row = row
                    break

        if existing_row:
            # Update existing entry in-place
            existing_row['rlnPipeLineProcessAlias'] = alias
            existing_row['rlnPipeLineProcessStatusLabel'] = status
        else:
            # Add new process
            if processes_block.get('loops'):
                processes_block['loops'][0]['rows'].append({
                    'rlnPipeLineProcessName': process_name,
                    'rlnPipeLineProcessAlias': alias,
                    'rlnPipeLineProcessTypeLabel': f'relion.{job_type.lower()}',
                    'rlnPipeLineProcessStatusLabel': status
                })

            # Add input edges (only for new processes)
            if input_nodes:
                input_edges_block = data['data_blocks'].get('data_pipeline_input_edges', {})
                if input_edges_block.get('loops'):
                    for node in input_nodes:
                        input_edges_block['loops'][0]['rows'].append({
                            'rlnPipeLineEdgeFromNode': node,
                            'rlnPipeLineEdgeProcess': process_name
                        })

            # Add output edges (only for new processes)
            if output_nodes:
                output_edges_block = data['data_blocks'].get('data_pipeline_output_edges', {})
                nodes_block = data['data_blocks'].get('data_pipeline_nodes', {})
                if output_edges_block.get('loops') and nodes_block.get('loops'):
                    for node in output_nodes:
                        node_name = node.get('name', '') if isinstance(node, dict) else node
                        node_type = node.get('type', 'Unknown') if isinstance(node, dict) else 'Unknown'
                        output_edges_block['loops'][0]['rows'].append({
                            'rlnPipeLineEdgeProcess': process_name,
                            'rlnPipeLineEdgeToNode': node_name
                        })
                        nodes_block['loops'][0]['rows'].append({
                            'rlnPipeLineNodeName': node_name,
                            'rlnPipeLineNodeTypeLabel': node_type
                        })

        write_star_file(str(pipeline_file), data)
        return process_id


def update_process_status(project_dir: str, process_id: str, status: str) -> bool:
    """Update the status of a process in the pipeline. Thread-safe."""
    with _pipeline_star_lock:
        pipeline_file = Path(project_dir) / 'default_pipeline.star'

        if not pipeline_file.exists():
            return False

        data = parse_star_file(str(pipeline_file))
        processes_block = data['data_blocks'].get('data_pipeline_processes', {})

        for loop in processes_block.get('loops', []):
            for row in loop['rows']:
                if row.get('rlnPipeLineProcessName', '').rstrip('/') == process_id.rstrip('/'):
                    row['rlnPipeLineProcessStatusLabel'] = status
                    write_star_file(str(pipeline_file), data)
                    return True

        return False


def add_output_node_to_pipeline(project_dir: str, process_id: str,
                                node_name: str, node_type: str) -> bool:
    """Add an output node for a process."""
    pipeline_file = Path(project_dir) / 'default_pipeline.star'

    if not pipeline_file.exists():
        return False

    data = parse_star_file(str(pipeline_file))

    # Add to nodes
    nodes_block = data['data_blocks'].get('data_pipeline_nodes', {})
    if nodes_block.get('loops'):
        nodes_block['loops'][0]['rows'].append({
            'rlnPipeLineNodeName': node_name,
            'rlnPipeLineNodeTypeLabel': node_type
        })

    # Add output edge
    output_edges_block = data['data_blocks'].get('data_pipeline_output_edges', {})
    if output_edges_block.get('loops'):
        output_edges_block['loops'][0]['rows'].append({
            'rlnPipeLineEdgeProcess': process_id + '/',
            'rlnPipeLineEdgeToNode': node_name
        })

    write_star_file(str(pipeline_file), data)
    return True
