#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[clean] removing generated artifacts..."
rm -rf \
  dist \
  dist-electron \
  out \
  build \
  coverage \
  temp \
  tmp \
  logs \
  artifacts \
  apps/brain/build \
  apps/brain/dist \
  apps/brain/logs \
  apps/brain/.turbo \
  apps/desktop/out \
  apps/desktop/.turbo \
  apps/driver/dist \
  apps/driver/.turbo

echo "[clean] done"
