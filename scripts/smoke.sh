#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DRIVER_URL="${DRIVER_URL:-http://127.0.0.1:13000}"
DRIVER_PID=""

cleanup() {
  if [[ -n "$DRIVER_PID" ]]; then
    kill "$DRIVER_PID" >/dev/null 2>&1 || true
    wait "$DRIVER_PID" 2>/dev/null || true
  fi
}

wait_for_driver() {
  local attempts=30
  local delay=1
  for ((i=1; i<=attempts; i++)); do
    if curl -fsS "$DRIVER_URL/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay"
  done
  return 1
}

trap cleanup EXIT

echo "[smoke] repo root: $ROOT_DIR"
if [[ "${SKIP_WORKSPACE_TESTS:-0}" == "1" ]]; then
  echo "[smoke] skipping workspace tests because SKIP_WORKSPACE_TESTS=1"
else
  echo "[smoke] running workspace tests..."
  pnpm test
fi

echo "[smoke] running port discovery smoke..."
bash "$ROOT_DIR/test/port-discovery-smoke.sh"

if curl -fsS "$DRIVER_URL/health" >/dev/null 2>&1; then
  echo "[smoke] reusing running driver at $DRIVER_URL"
else
  echo "[smoke] starting local driver for storage smoke..."
  mkdir -p "$ROOT_DIR/temp"
  pnpm --filter @alphomi/driver dev >"$ROOT_DIR/temp/driver-smoke.log" 2>&1 &
  DRIVER_PID=$!
  if ! wait_for_driver; then
    echo "[smoke] driver failed to become healthy. See temp/driver-smoke.log" >&2
    exit 1
  fi
fi

echo "[smoke] running driver storage smoke..."
node "$ROOT_DIR/test/driver-storage-smoke.mjs"

echo "[smoke] running driver snapshot smoke..."
node "$ROOT_DIR/test/driver-snapshot-smoke.mjs"

echo "[smoke] running tool settings driver smoke..."
node "$ROOT_DIR/test/tool-settings-smoke.mjs"

echo "[smoke] running brain tool policy smoke..."
uv run --project "$ROOT_DIR/apps/brain" python "$ROOT_DIR/test/brain-tool-policy-smoke.py"

echo "[smoke] running brain llm settings smoke..."
uv run --project "$ROOT_DIR/apps/brain" python "$ROOT_DIR/test/brain-llm-settings-smoke.py"

echo "[smoke] running optional LLM file-edit E2E..."
python3 "$ROOT_DIR/test/llm_apply_patch_e2e.py"

echo "[smoke] all checks completed"
