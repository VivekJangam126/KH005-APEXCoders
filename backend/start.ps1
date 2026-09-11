# Start ClaritySQL FastAPI Backend (Windows PowerShell)
# Run from the backend/ directory
Write-Host "Starting ClaritySQL FastAPI Backend..." -ForegroundColor Green

Set-Location $PSScriptRoot

# Create venv if it doesn't exist
if (-not (Test-Path "venv")) {
    Write-Host "Creating virtual environment..." -ForegroundColor Yellow
    python -m venv venv
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Failed to create virtual environment. Ensure Python 3.9+ is installed." -ForegroundColor Red
        exit 1
    }
}

# Activate venv
$activateScript = "venv\Scripts\Activate.ps1"
if (Test-Path $activateScript) {
    & $activateScript
} else {
    Write-Host "ERROR: Could not find venv activation script." -ForegroundColor Red
    exit 1
}

# Install/update requirements
Write-Host "Installing dependencies..." -ForegroundColor Yellow
pip install -r requirements.txt -q
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to install requirements." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Backend running on http://localhost:8000" -ForegroundColor Green
Write-Host "API docs:         http://localhost:8000/docs" -ForegroundColor Cyan
Write-Host "Frontend expects: http://localhost:5173 (run frontend separately)" -ForegroundColor Cyan
Write-Host ""

# Start FastAPI with reload
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
