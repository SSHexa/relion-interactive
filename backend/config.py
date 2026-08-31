"""
Configuration handling for RELION Web Backend
"""
import os
import json
from pathlib import Path

class Config:
    """Configuration manager for RELION backend."""

    def __init__(self, config_file: str = None):
        """Initialize configuration from file or environment."""
        self.config_file = config_file or os.environ.get(
            'RELION_CONFIG_FILE',
            str(Path(__file__).parent / 'config.json')
        )
        self.load()

    def load(self):
        """Load configuration from JSON file, with environment-variable overrides.

        Resolution order for each setting: env var → JSON file → built-in default.
        Customer-facing env vars use the ``RELION_`` prefix and are documented
        in ``docs/CONFIGURATION.md`` and ``ood-app/template/env.example``.
        """
        try:
            with open(self.config_file, 'r') as f:
                config = json.load(f)
        except FileNotFoundError:
            config = {}

        def env_or(env_key, json_key, default):
            return os.environ.get(env_key, config.get(json_key, default))

        # RELION paths
        self.relion_bin_path = env_or('RELION_BIN_PATH', 'relion_bin_path', '/opt/relion/bin')
        self.relion_container = env_or('RELION_CONTAINER', 'relion_container', '')
        self.singularity_bin = env_or('RELION_APPTAINER_BIN', 'singularity_bin', '/usr/bin/singularity')
        self.container_bind = env_or('RELION_CONTAINER_BIND', 'container_bind', '/shared:/shared')
        self.slurm_partition = env_or('RELION_PARTITION', 'slurm_partition', 'local')
        self.dynamight_bin_path = env_or('RELION_DYNAMIGHT_BIN', 'dynamight_bin_path', '')
        self.ctffind_executable = env_or('RELION_CTFFIND_BIN', 'ctffind_executable', '/usr/local/bin/ctffind')
        self.mpi_run = env_or('RELION_MPIRUN', 'mpi_run', 'mpirun')

        # cluster_mode gates dual-filesystem / SSH-proxy behaviour. Almost
        # every deployment should leave this at "generic" — that path is
        # a plain local-Slurm setup. Set to "cyclecloud" only when your
        # OOD host and compute nodes see DIFFERENT shared filesystems and
        # you need the /sched-shared NFS bind + SSH-based project prep.
        # See docs/CYCLECLOUD.md.
        self.cluster_mode = env_or('RELION_CLUSTER_MODE', 'cluster_mode', 'generic')

        # deployment_mode: "ood", "headless", or "local". Defaults to "ood".
        self.deployment_mode = env_or('RELION_DEPLOYMENT_MODE', 'deployment_mode', 'ood')

        # auth_mode: "passthrough" (reverse proxy handles auth), "basic", "none".
        self.auth_mode = env_or('RELION_AUTH_MODE', 'auth_mode', 'passthrough')

        # Slurm proxy commands (advanced: forward sbatch/squeue/scancel over
        # SSH to a separate scheduler VM). Most sites leave these unset and
        # run sbatch locally.
        self.sbatch_command = env_or('RELION_SBATCH_PROXY', 'sbatch_command', None)
        self.squeue_command = env_or('RELION_SQUEUE_PROXY', 'squeue_command', None)
        self.scancel_command = env_or('RELION_SCANCEL_PROXY', 'scancel_command', None)

        # cyclecloud-mode only: SSH into a separate scheduler VM to run
        # project-prep commands as the scheduler-side account (usually
        # different UID from the OOD-side user).
        self.cc_scheduler_host = env_or('RELION_CC_HOST', 'cc_scheduler_host', None)
        self.cc_scheduler_user = env_or('RELION_CC_USER', 'cc_scheduler_user', '')

        # cyclecloud-mode only: OOD NFS server address that compute nodes
        # mount at /sched-shared to see user data. Required when
        # cluster_mode='cyclecloud'.
        self.ood_nfs_server = env_or('RELION_OOD_NFS_SERVER', 'ood_nfs_server', None)

        # CORS allowlist for the Flask backend. Default "*" is safe when
        # the backend is only reachable via localhost (via OOD's reverse
        # proxy). Set to your site's OOD hostname to restrict.
        cors_raw = env_or('RELION_CORS_ORIGINS', 'cors_origins', '*')
        if isinstance(cors_raw, str):
            self.cors_origins = [o.strip() for o in cors_raw.split(',') if o.strip()]
        else:
            self.cors_origins = list(cors_raw)

        # Project settings
        self.project_base_dir = env_or('RELION_DEFAULT_PROJECTS_DIR', 'project_base_dir', os.getcwd())
        self.DEFAULT_PROJECT_DIR = self.project_base_dir
        # additional_project_dirs may come from config.json OR
        # RELION_ADDITIONAL_PROJECT_DIRS (comma-separated). Set the env var
        # to an empty string to explicitly disable additional dirs.
        _add_env = os.environ.get('RELION_ADDITIONAL_PROJECT_DIRS')
        if _add_env is not None:
            self.additional_project_dirs = [
                d.strip() for d in _add_env.split(',') if d.strip()
            ]
        else:
            self.additional_project_dirs = config.get('additional_project_dirs', [])
        # execution_mode: "slurm" (submit via sbatch) or "local" (subprocess).
        # Default "slurm" so existing installs (prod, v0.2 headless) stay on sbatch.
        # The v0.3 local variant sets RELION_EXECUTION_MODE=local in start.sh.
        self.execution_mode = env_or('RELION_EXECUTION_MODE', 'execution_mode', 'slurm')

        # Server settings
        self.environment = env_or('RELION_ENVIRONMENT', 'environment', 'development')
        self.host = env_or('RELION_HOST', 'host', '0.0.0.0')
        self.port = int(env_or('RELION_BACKEND_PORT', 'port', 5000))
        self.debug = str(env_or('RELION_DEBUG', 'debug', False)).lower() in ('1', 'true', 'yes')

        # Legacy env-var fallbacks for backwards compatibility
        self.project_base_dir = os.environ.get('PROJECT_DIR', self.project_base_dir)
        self.port = int(os.environ.get('RELION_API_PORT', self.port))

    def is_cyclecloud(self) -> bool:
        """True when running on a cyclecloud-mode cluster."""
        return self.cluster_mode == 'cyclecloud'

    def is_headless(self) -> bool:
        return self.deployment_mode == 'headless'

    def get_all_project_dirs(self):
        """Return all configured project directories.

        Expands ${VAR} and ~ so config.json entries like
        "project_base_dir": "${HOME}/relion_projects" resolve per-user
        at request time rather than at backend startup.
        """
        def _resolve(p):
            return os.path.expanduser(os.path.expandvars(str(p)))
        dirs = [_resolve(self.project_base_dir)]
        dirs.extend(_resolve(d) for d in self.additional_project_dirs)
        # Drop empty strings and duplicates, preserve order
        seen = set()
        out = []
        for d in dirs:
            if d and d not in seen:
                seen.add(d)
                out.append(d)
        return out

    def get_relion_command(self, command: str) -> str:
        """Get full path to a RELION command."""
        return os.path.join(self.relion_bin_path, command)

    def to_dict(self) -> dict:
        """Return configuration as dictionary."""
        return {
            'relion_bin_path': self.relion_bin_path,
            'relion_container': self.relion_container,
            'project_base_dir': self.project_base_dir,
            'execution_mode': self.execution_mode,
            'environment': self.environment,
        }

# Global config instance
config = Config()

# Module-level aliases for backwards compatibility.
# app.py uses `import config` (the module), so all attributes the app accesses
# directly need to be exposed here at module scope.
DEFAULT_PROJECT_DIR = config.project_base_dir
PROJECT_DIR = config.project_base_dir
RELION_BIN_PATH = config.relion_bin_path
HOST = config.host
PORT = config.port
DEBUG = config.debug
cors_origins = config.cors_origins
cluster_mode = config.cluster_mode
deployment_mode = config.deployment_mode
auth_mode = config.auth_mode

def get_all_project_dirs():
    """Module-level wrapper for config.get_all_project_dirs()."""
    return config.get_all_project_dirs()
