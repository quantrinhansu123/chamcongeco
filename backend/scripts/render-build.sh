#!/usr/bin/env bash
set -euo pipefail

BACKEND_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$BACKEND_ROOT"
export FACE_MODEL_DIR="${FACE_MODEL_DIR:-$BACKEND_ROOT/models}"

uv sync --frozen --no-dev
uv run --no-sync python scripts/download_models.py
