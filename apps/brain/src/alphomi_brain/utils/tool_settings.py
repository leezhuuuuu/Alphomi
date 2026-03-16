import json
import os
from pathlib import Path
from typing import Dict, Optional

_CONFIG_NAME = "tool-settings.json"
_CACHE_PATH: Optional[Path] = None
_CACHE_MTIME_NS: Optional[int] = None
_CACHE_TOOL_STATES: Dict[str, bool] = {}


def _find_workspace_root(start_dir: Path) -> Optional[Path]:
    current = start_dir
    while True:
        if (current / "pnpm-workspace.yaml").exists() or (current / "turbo.json").exists():
            return current
        if current.parent == current:
            return None
        current = current.parent


def resolve_tool_settings_path() -> Optional[Path]:
    from_env = os.getenv("ALPHOMI_TOOL_SETTINGS_PATH")
    if from_env:
        return Path(from_env).expanduser().resolve()

    workspace_root = _find_workspace_root(Path.cwd())
    if not workspace_root:
        return None
    return workspace_root / "temp" / _CONFIG_NAME


def _normalize_bool(value) -> Optional[bool]:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "1", "yes", "y", "on"}:
            return True
        if lowered in {"false", "0", "no", "n", "off"}:
            return False
    return None


def load_tool_states() -> Dict[str, bool]:
    global _CACHE_PATH, _CACHE_MTIME_NS, _CACHE_TOOL_STATES

    path = resolve_tool_settings_path()
    if not path or not path.exists():
        _CACHE_PATH = path
        _CACHE_MTIME_NS = None
        _CACHE_TOOL_STATES = {}
        return _CACHE_TOOL_STATES

    stat = path.stat()
    if _CACHE_PATH == path and _CACHE_MTIME_NS == stat.st_mtime_ns:
        return _CACHE_TOOL_STATES

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        payload = {}

    next_states: Dict[str, bool] = {}
    tools = payload.get("tools") if isinstance(payload, dict) else {}
    if isinstance(tools, dict):
        for name, raw_value in tools.items():
            normalized = _normalize_bool(raw_value)
            if normalized is not None:
                next_states[str(name)] = normalized

    _CACHE_PATH = path
    _CACHE_MTIME_NS = stat.st_mtime_ns
    _CACHE_TOOL_STATES = next_states
    return _CACHE_TOOL_STATES


def is_tool_enabled(name: str) -> bool:
    states = load_tool_states()
    return states.get(name, True)
