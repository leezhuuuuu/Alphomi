#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[bootstrap] installing pnpm workspace dependencies..."
pnpm install

echo "[bootstrap] syncing root config.example.yaml..."
pnpm sync:config-template

if [[ ! -f "$ROOT_DIR/config.yaml" && -f "$ROOT_DIR/config.example.yaml" ]]; then
  echo "[bootstrap] creating config.yaml from config.example.yaml..."
  cp "$ROOT_DIR/config.example.yaml" "$ROOT_DIR/config.yaml"
fi

if command -v uv >/dev/null 2>&1; then
  echo "[bootstrap] syncing brain environment with uv..."
  uv sync --project apps/brain --extra dev
else
  echo "[bootstrap] uv not found, falling back to venv + pip..."
  python3 -m venv apps/brain/.venv
  source apps/brain/.venv/bin/activate
  python -m pip install --upgrade pip
  python -m pip install -e apps/brain
fi

echo "[bootstrap] installing Playwright browsers..."
pnpm --filter @alphomi/driver exec playwright install

echo "[bootstrap] complete"
