from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

import httpx


def _candidate_registry_paths(start: Path) -> Iterable[Path]:
    current = start
    while True:
        # 优先工作区 temp/ports.json
        yield current / "temp" / "ports.json"
        # 以及当前目录下的 ports.json（兼容生产环境）
        yield current / "ports.json"
        if current.parent == current:
            break
        current = current.parent


def resolve_registry_path() -> Optional[Path]:
    from_env = os.getenv("PORT_REGISTRY_PATH")
    if from_env:
        return Path(from_env)

    for candidate in _candidate_registry_paths(Path.cwd()):
        if candidate.exists():
            return candidate
    return None


def read_registry() -> Dict[str, Any]:
    path = resolve_registry_path()
    if not path:
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


async def probe_driver(base_url: str) -> bool:
    try:
        async with httpx.AsyncClient(timeout=0.8) as client:
            health = await client.get(f"{base_url}/health")
            if health.status_code != 200:
                return False
    except Exception:
        return False

    # /tools 能进一步确认这是正确的 driver
    try:
        async with httpx.AsyncClient(timeout=1.5) as client:
            tools = await client.get(f"{base_url}/tools")
            if tools.status_code != 200:
                return False
            data = tools.json()
            return bool(data.get("success"))
    except httpx.ReadTimeout:
        # /tools 超时但 /health 成功时，允许作为候选
        return True
    except Exception:
        return False


def _normalize_url(url: str) -> str:
    return url.rstrip("/")


def build_driver_candidates() -> List[str]:
    reg = read_registry()
    candidates: List[str] = []
    seen = set()

    def add(url: Optional[str]) -> None:
        if not url:
            return
        normalized = _normalize_url(url)
        if normalized in seen:
            return
        seen.add(normalized)
        candidates.append(normalized)

    # 1) 显式环境变量
    add(os.getenv("PRAS_URL"))
    add(os.getenv("DRIVER_URL"))

    driver_port = os.getenv("DRIVER_PORT")
    if driver_port:
        add(f"http://127.0.0.1:{driver_port}")

    # 2) 端口注册表（若存在）
    driver_entry = reg.get("driver") if isinstance(reg, dict) else None
    if isinstance(driver_entry, dict):
        add(driver_entry.get("url"))
        port = driver_entry.get("port")
        if isinstance(port, int):
            add(f"http://127.0.0.1:{port}")

    # 3) 默认端口 + 小范围扫描
    default_port = int(os.getenv("PRAS_DEFAULT_PORT", "13000"))
    add(f"http://127.0.0.1:{default_port}")
    add(f"http://localhost:{default_port}")

    for port in range(default_port, default_port + 101):
        add(f"http://127.0.0.1:{port}")

    return candidates


async def discover_driver_url() -> str:
    for url in build_driver_candidates():
        if await probe_driver(url):
            os.environ["PRAS_URL"] = url
            return url

    fallback = f"http://127.0.0.1:{int(os.getenv('PRAS_DEFAULT_PORT', '13000'))}"
    os.environ["PRAS_URL"] = fallback
    return fallback
