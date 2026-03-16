#!/usr/bin/env bash
set -euo pipefail

# 端口发现与注册表逻辑的“非侵入式”冒烟测试：
# - 不占用默认端口
# - 不修改 temp/ports.json（避免影响 pnpm dev）
# - 通过独立 registry 文件验证 discovery 行为与 Python 语法

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

SMOKE_REGISTRY="temp/ports-smoke.json"
DEV_REGISTRY="temp/ports.json"

echo "[smoke] repo root: $ROOT_DIR"
echo "[smoke] using isolated registry: $SMOKE_REGISTRY"

mkdir -p temp

cat > "$SMOKE_REGISTRY" <<'JSON'
{
  "driver": {
    "port": 13077,
    "url": "http://127.0.0.1:13077",
    "ready": true,
    "updatedAt": "2026-01-27T00:00:00.000Z"
  },
  "brain": {
    "port": 18042,
    "url": "http://127.0.0.1:18042",
    "ready": false,
    "updatedAt": "2026-01-27T00:00:00.000Z"
  }
}
JSON

echo "[smoke] wrote $SMOKE_REGISTRY"

echo "[smoke] compile python modules (brain core/tools)..."
python3 -m compileall apps/brain/src/alphomi_brain/core apps/brain/src/alphomi_brain/tools >/dev/null
echo "[smoke] python compile: OK"

echo "[smoke] check discovery candidate ordering with isolated registry..."
PORT_REGISTRY_PATH="$SMOKE_REGISTRY" PYTHONPATH="$ROOT_DIR/apps/brain/src" python3 - <<'PY'
from alphomi_brain.core.discovery import resolve_registry_path, read_registry, build_driver_candidates

print("[py] registry_path =", resolve_registry_path())
reg = read_registry()
print("[py] registry.driver =", reg.get("driver"))

cands = build_driver_candidates()
print("[py] first 8 candidates:")
for i, c in enumerate(cands[:8], 1):
    print(f"  {i}. {c}")

assert cands[0].endswith(":13077"), "registry candidate should be first"
print("[py] assertion passed: registry candidate is prioritized")
PY

echo
echo "[smoke] ✅ done. Next step (as you planned):"
echo "  pnpm dev"
echo
echo "[smoke] tips:"
echo "  - dev mode registry: temp/ports.json"
echo "  - isolated smoke registry (this script): $SMOKE_REGISTRY"

if [[ "${1:-}" == "--dev" ]]; then
  echo
  echo "[smoke] entering blocking dev mode..."
  echo "[smoke] will start: pnpm dev"
  echo "[smoke] and watch: $DEV_REGISTRY"
  echo "[smoke] stop with: Ctrl+C"
  echo

  # 避免 watcher 先读到历史残留内容，先写入一个空对象
  if [[ -f "$DEV_REGISTRY" ]]; then
    cat > "$DEV_REGISTRY" <<'JSON'
{}
JSON
    echo "[smoke] reset dev registry placeholder: $DEV_REGISTRY"
  fi

  (
    # 轻量 watcher：注册表出现或变化时打印一次
    last=""
    while true; do
      if [[ -f "$DEV_REGISTRY" ]]; then
        current="$(cat "$DEV_REGISTRY" 2>/dev/null || true)"
        if [[ "$current" != "$last" && -n "$current" ]]; then
          echo "[watch] $DEV_REGISTRY updated:"
          echo "$current"
          last="$current"
        fi
      fi
      sleep 1
    done
  ) &
  WATCH_PID=$!

  cleanup() {
    if [[ -n "${WATCH_PID:-}" ]]; then
      kill "$WATCH_PID" >/dev/null 2>&1 || true
    fi
  }
  trap cleanup EXIT INT TERM

  pnpm dev
fi
