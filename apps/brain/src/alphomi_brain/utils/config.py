import json
import os
from pathlib import Path
from typing import Any, Dict, Optional

import yaml

_CONFIG_NAMES = ("config.yaml", "config.yml")


def _find_config_path(start_dir: Path) -> Optional[Path]:
    current = start_dir
    while True:
        for name in _CONFIG_NAMES:
            candidate = current / name
            if candidate.exists():
                return candidate
        if current.parent == current:
            return None
        current = current.parent


def _normalize_env_value(value: Any) -> str:
    if isinstance(value, list):
        return ",".join(str(item) for item in value)
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=True)
    return str(value)


def load_config_from_yaml(section: Optional[str] = None) -> Dict[str, Any]:
    config_path = _find_config_path(Path.cwd())
    if not config_path:
        return {}

    with config_path.open("r", encoding="utf-8") as handle:
        parsed = yaml.safe_load(handle) or {}

    if not isinstance(parsed, dict):
        return {}

    scoped = parsed.get(section, parsed) if section else parsed
    if not isinstance(scoped, dict):
        return {}

    for key, value in scoped.items():
        if value is None:
            continue
        if key in os.environ:
            continue
        os.environ[key] = _normalize_env_value(value)

    return scoped
