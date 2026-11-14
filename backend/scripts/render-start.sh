#!/usr/bin/env bash
set -euo pipefail

BACKEND_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$BACKEND_ROOT"
export APP_ENV=production
export STORAGE_BACKEND="${STORAGE_BACKEND:-supabase}"
export FACE_ENGINE="${FACE_ENGINE:-insightface}"
export FACE_MODEL_DIR="${FACE_MODEL_DIR:-$BACKEND_ROOT/models}"
export FACE_CPU_THREADS="${FACE_CPU_THREADS:-1}"
export OMP_NUM_THREADS="${OMP_NUM_THREADS:-1}"
export OPENBLAS_NUM_THREADS="${OPENBLAS_NUM_THREADS:-1}"
export FACE_CORS_ORIGINS="${FACE_CORS_ORIGINS:-https://chamcongeco.vercel.app}"

exec uv run --no-sync uvicorn backend.main:app --host 0.0.0.0 \
    --port "${PORT:-10000}" --workers 1 --no-access-log
