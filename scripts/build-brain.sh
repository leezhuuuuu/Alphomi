#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRAIN_DIR="$ROOT_DIR/apps/brain"
DIST_DIR="$BRAIN_DIR/dist"
BUILD_DIR="$BRAIN_DIR/build"
PYTHON_BIN="${PYTHON_BIN:-python3}"

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "[build-brain] python3 is required" >&2
  exit 1
fi

if command -v uv >/dev/null 2>&1; then
  uv sync --project "$BRAIN_DIR" --extra dev
  uv run --project "$BRAIN_DIR" pyinstaller \
    --clean \
    --onefile \
    --name alphomi-brain \
    "$BRAIN_DIR/src/alphomi_brain/main.py" \
    --distpath "$DIST_DIR" \
    --workpath "$BUILD_DIR" \
    --specpath "$BUILD_DIR"
  exit 0
fi

if [[ ! -d "$BRAIN_DIR/.venv" ]]; then
  "$PYTHON_BIN" -m venv "$BRAIN_DIR/.venv"
fi

source "$BRAIN_DIR/.venv/bin/activate"
python -m pip install --upgrade pip
python -m pip install -e "$BRAIN_DIR" pyinstaller
pyinstaller \
  --clean \
  --onefile \
  --name alphomi-brain \
  "$BRAIN_DIR/src/alphomi_brain/main.py" \
  --distpath "$DIST_DIR" \
  --workpath "$BUILD_DIR" \
  --specpath "$BUILD_DIR"
