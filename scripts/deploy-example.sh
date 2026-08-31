#!/bin/bash
# Example deploy: rsync backend + frontend build to a remote OOD host.
#
# Usage:
#   OOD_HOST=ood.example.edu OOD_USER=admin ./scripts/deploy-example.sh
#
# Env vars:
#   OOD_HOST       (REQUIRED)  target host
#   OOD_USER       (default: current user)
#   REMOTE_ROOT    (default: /opt/relion5)   base install path on the OOD host
#   INSTALL_APP    (default: 0)  set to 1 to also copy the OOD app package
#                                 to /var/www/ood/apps/sys/relion5_webui
#
set -e

: "${OOD_HOST:?set OOD_HOST=<your-ood-hostname>}"
OOD_USER="${OOD_USER:-$USER}"
REMOTE_ROOT="${REMOTE_ROOT:-/opt/relion5}"
INSTALL_APP="${INSTALL_APP:-0}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Sanity: frontend built?
if [ ! -d frontend/build ]; then
    echo "frontend/build/ not found — run scripts/build-frontend.sh first" >&2
    exit 1
fi

echo "Deploying to ${OOD_USER}@${OOD_HOST}:${REMOTE_ROOT}"

# Backend
rsync -avz --delete \
    --exclude 'config.json' \
    --exclude '__pycache__' \
    --exclude '*.pyc' \
    --exclude 'venv/' \
    backend/ "${OOD_USER}@${OOD_HOST}:${REMOTE_ROOT}/backend/"

# Frontend build
rsync -avz --delete \
    frontend/build/ "${OOD_USER}@${OOD_HOST}:${REMOTE_ROOT}/frontend/"

# Particle picker SPA (served at /particle-picker/ from the backend)
if [ -d particle-picker/build ]; then
    rsync -avz --delete \
        particle-picker/build/ "${OOD_USER}@${OOD_HOST}:${REMOTE_ROOT}/particle-picker/"
elif [ -d particle-picker ]; then
    rsync -avz --delete \
        particle-picker/ "${OOD_USER}@${OOD_HOST}:${REMOTE_ROOT}/particle-picker/"
fi

# OOD app package (only if explicitly requested; usually one-shot install)
if [ "${INSTALL_APP}" = "1" ]; then
    echo "Also installing OOD app package"
    ssh "${OOD_USER}@${OOD_HOST}" \
        "sudo mkdir -p /var/www/ood/apps/sys/relion5_webui"
    rsync -avz --rsync-path='sudo rsync' \
        ood-app/ "${OOD_USER}@${OOD_HOST}:/var/www/ood/apps/sys/relion5_webui/"
fi

echo
echo "Deploy complete. Reminders:"
echo "  1. Ensure a venv exists at ${REMOTE_ROOT}/backend/venv"
echo "     (or set RELION_BACKEND_DIR to point elsewhere)"
echo "  2. Config lives at /etc/ood/config/apps/relion5_webui/env"
