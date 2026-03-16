#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRAIN_DIR="$ROOT_DIR/apps/brain"
cd "$ROOT_DIR"

if command -v uv >/dev/null 2>&1; then
  exec uv run --project "$BRAIN_DIR" python -m alphomi_brain.main
fi

if [[ -x "$BRAIN_DIR/.venv/bin/python" ]]; then
  export PYTHONPATH="$BRAIN_DIR/src${PYTHONPATH:+:$PYTHONPATH}"
  exec "$BRAIN_DIR/.venv/bin/python" -m alphomi_brain.main
fi

echo "[brain-dev] missing uv and missing apps/brain/.venv" >&2
echo "[brain-dev] run: pnpm bootstrap" >&2
exit 1
