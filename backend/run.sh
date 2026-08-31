#!/bin/bash

# RELION Backend Server Startup Script

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Set environment variables
export RELION_BIN_PATH="${RELION_BIN_PATH:-/Users/lakshmi/Documents/Apps/relion5/relion/build/bin}"
export RELION_PROJECT_DIR="${RELION_PROJECT_DIR:-$HOME/relion_projects}"
export RELION_API_HOST="${RELION_API_HOST:-0.0.0.0}"
export RELION_API_PORT="${RELION_API_PORT:-5000}"

# Check if virtual environment exists
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
fi

# Activate virtual environment
source venv/bin/activate

# Install dependencies if needed
if [ ! -f "venv/.installed" ]; then
    echo "Installing dependencies..."
    pip install -r requirements.txt
    touch venv/.installed
fi

# Create project directory if it doesn't exist
mkdir -p "$RELION_PROJECT_DIR"

echo "Starting RELION Backend API Server..."
echo "  RELION binaries: $RELION_BIN_PATH"
echo "  Project directory: $RELION_PROJECT_DIR"
echo "  Server: http://$RELION_API_HOST:$RELION_API_PORT"
echo ""

python app.py
