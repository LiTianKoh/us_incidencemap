# INCIDENCE - start backend + frontend with one command.
# Ctrl+C stops both cleanly.

$ErrorActionPreference = "Stop"

Write-Host "Starting backend on http://localhost:8000 ..."
$backend = Start-Process -PassThru -NoNewWindow powershell -ArgumentList @(
    "-NoProfile", "-Command",
    "cd backend; .\venv\Scripts\Activate.ps1; uvicorn api.main:app --reload"
)

Write-Host "Starting frontend on http://localhost:5173 ..."
$frontend = Start-Process -PassThru -NoNewWindow powershell -ArgumentList @(
    "-NoProfile", "-Command",
    "cd frontend; npm run dev"
)

function Stop-Tree($processId) {
    # Kill the process and all of its children (handles npm -> node on Windows)
    Get-CimInstance Win32_Process -Filter "ParentProcessId=$processId" |
        ForEach-Object { Stop-Tree $_.ProcessId }
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
}

try {
    Wait-Process -Id $backend.Id, $frontend.Id -Any
}
finally {
    Write-Host ""
    Write-Host "Stopping..."
    Stop-Tree $backend.Id
    Stop-Tree $frontend.Id
}
