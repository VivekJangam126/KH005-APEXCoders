#!/bin/bash
# Start ClaritySQL FastAPI Backend
# Run from the backend/ directory
set -e

echo "Starting ClaritySQL FastAPI Backend..."
cd "$(dirname "$0")"

# Create venv if it doesn't exist
if [ ! -d "venv" ]; then
  echo "Creating virtual environment..."
  python3 -m venv venv || python -m venv venv
fi

# Activate venv (Linux/Mac or Git Bash on Windows)
if [ -f "venv/bin/activate" ]; then
  source venv/bin/activate
elif [ -f "venv/Scripts/activate" ]; then
  source venv/Scripts/activate
else
  echo "ERROR: Could not find venv activation script."
  exit 1
fi

# Install/update requirements
echo "Installing dependencies..."
pip install -r requirements.txt -q

echo ""
echo "Backend running on http://localhost:8000"
echo "API docs:         http://localhost:8000/docs"
echo "Frontend expects: http://localhost:5173 (run frontend separately)"
echo ""

# Start FastAPI with reload
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
