from __future__ import annotations

import os
from typing import Any, Dict, Optional

import httpx

from ..utils.config import read_config_from_yaml, was_env_injected_from_yaml
from .discovery import read_registry


RuntimeLLMValueSource = str


def _trim(value: Any) -> str:
    return str(value or "").strip()


def _normalize_endpoint_mode(value: Any) -> str:
    trimmed = _trim(value)
    if trimmed in {"chat_completions", "responses"}:
        return trimmed
    return "auto"


def _explicit_env_value(key: str) -> Optional[str]:
    value = _trim(os.getenv(key))
    if not value:
        return None
    if was_env_injected_from_yaml(key):
        return None
    return value


def _config_value(config: Dict[str, Any], key: str) -> Optional[str]:
    value = _trim(config.get(key))
    return value or None


def _add_candidate(candidates: list[str], seen: set[str], value: Optional[str]) -> None:
    candidate = _trim(value)
    if not candidate:
        return
    candidate = candidate.rstrip("/")
    if candidate in seen:
        return
    seen.add(candidate)
    candidates.append(candidate)


def build_desktop_control_candidates() -> list[str]:
    registry = read_registry()
    candidates: list[str] = []
    seen: set[str] = set()

    _add_candidate(candidates, seen, os.getenv("DESKTOP_CONTROL_URL"))

    desktop_port = _trim(os.getenv("DESKTOP_CONTROL_PORT"))
    if desktop_port:
        _add_candidate(candidates, seen, f"http://127.0.0.1:{desktop_port}")

    desktop_entry = registry.get("desktopControl") if isinstance(registry, dict) else None
    if isinstance(desktop_entry, dict):
        _add_candidate(candidates, seen, desktop_entry.get("url"))
        port = desktop_entry.get("port")
        if isinstance(port, int):
            _add_candidate(candidates, seen, f"http://127.0.0.1:{port}")

    default_port = int(os.getenv("DESKTOP_CONTROL_DEFAULT_PORT", "13001"))
    _add_candidate(candidates, seen, f"http://127.0.0.1:{default_port}")
    _add_candidate(candidates, seen, f"http://localhost:{default_port}")

    return candidates


async def fetch_desktop_effective_llm_settings() -> Dict[str, Any]:
    for base_url in build_desktop_control_candidates():
        try:
            async with httpx.AsyncClient(timeout=1.0) as client:
                response = await client.get(f"{base_url}/llm/effective", params={"includeApiKey": "1"})
            if response.status_code != 200:
                continue
            payload = response.json()
            if isinstance(payload, dict):
                data = payload.get("data")
                if isinstance(data, dict):
                    return data
        except Exception:
            continue
    return {}


async def resolve_runtime_llm_config() -> Dict[str, Any]:
    config = read_config_from_yaml("brain")
    desktop = await fetch_desktop_effective_llm_settings()

    env_base_url = _explicit_env_value("LLM_BASE_URL")
    env_model = _explicit_env_value("LLM_MODEL")
    env_endpoint_mode = _explicit_env_value("LLM_ENDPOINT_MODE")
    env_api_key = _explicit_env_value("LLM_API_KEY")

    desktop_base_url = _trim(desktop.get("baseUrl"))
    desktop_model = _trim(desktop.get("model"))
    desktop_endpoint_mode = _normalize_endpoint_mode(desktop.get("endpointMode"))
    desktop_api_key = _trim(desktop.get("apiKey"))
    desktop_has_endpoint_mode = isinstance(desktop, dict) and "endpointMode" in desktop

    config_base_url = _config_value(config, "LLM_BASE_URL")
    config_model = _config_value(config, "LLM_MODEL")
    config_endpoint_mode = _config_value(config, "LLM_ENDPOINT_MODE")
    config_api_key = _config_value(config, "LLM_API_KEY")

    base_url = env_base_url or desktop_base_url or config_base_url or ""
    model = env_model or desktop_model or config_model or "glm-4"
    endpoint_mode = _normalize_endpoint_mode(
        env_endpoint_mode or desktop_endpoint_mode or config_endpoint_mode
    )
    api_key = env_api_key or desktop_api_key or config_api_key or ""

    return {
        "base_url": base_url,
        "model": model,
        "endpoint_mode": endpoint_mode,
        "api_key": api_key,
        "sources": {
            "base_url": "environment"
            if env_base_url
            else "user"
            if desktop_base_url
            else "config"
            if config_base_url
            else "unset",
            "model": "environment"
            if env_model
            else "user"
            if desktop_model
            else "config"
            if config_model
            else "default",
            "endpoint_mode": "environment"
            if env_endpoint_mode
            else "user"
            if desktop_has_endpoint_mode
            else "config"
            if config_endpoint_mode
            else "default",
            "api_key": "environment"
            if env_api_key
            else "user"
            if desktop_api_key
            else "config"
            if config_api_key
            else "unset",
        },
    }
