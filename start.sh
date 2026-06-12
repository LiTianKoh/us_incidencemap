#!/bin/bash
# INCIDENCE — start backend + frontend with one command.
# Ctrl+C stops both cleanly.

set -e

# Kill both child processes on exit (Ctrl+C, normal exit, or error)
trap 'echo; echo "Stopping..."; kill $(jobs -p) 2>/dev/null' EXIT

echo "Starting backend on http://localhost:8000 ..."
(
  cd backend
  source venv/bin/activate
  uvicorn api.main:app --reload
) &

echo "Starting frontend on http://localhost:5173 ..."
(
  cd frontend
  npm run dev
) &

# Wait for both background jobs to finish; trap above handles cleanup on exit
wait