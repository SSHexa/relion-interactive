#!/bin/bash
# Build the React frontend for production.
# Output: frontend/build/  (ready to be copied to $RELION_FRONTEND_DIR)
set -e
cd "$(dirname "$0")/../frontend"
npm ci
npm run build
echo
echo "Build complete: $(pwd)/build"
echo "Copy this dir to your deploy target — e.g."
echo "  sudo rsync -a --delete build/ /opt/relion5/frontend/"
