from __future__ import annotations

from typing import Iterable, Set

from ..core.teaching_store import teaching_store
from ..utils.tool_settings import is_tool_enabled


def resolve_available_tool_names(
    default_tool_names: Iterable[str],
    available_tool_names: Set[str] | None = None,
) -> Set[str]:
    if available_tool_names is not None:
        return set(available_tool_names)
    return {name for name in default_tool_names if is_tool_enabled(name)}


def has_any(tool_names: Set[str], *candidates: str) -> bool:
    return any(candidate in tool_names for candidate in candidates)


def has_all(tool_names: Set[str], *candidates: str) -> bool:
    return all(candidate in tool_names for candidate in candidates)


def format_tool_list(tool_names: Iterable[str]) -> str:
    ordered = sorted(set(tool_names))
    return ", ".join(ordered) if ordered else "none"


def get_saved_teaching_catalog_lines(limit: int = 12) -> list[str]:
    try:
        assets = teaching_store.list_assets(limit=max(1, limit))
    except Exception:
        return []

    lines: list[str] = []
    for asset in assets:
        if not isinstance(asset, dict):
            continue
        title = str(asset.get("title") or "").strip()
        if not title:
            continue
        source_domain = str(asset.get("sourceDomain") or "").strip()
        if source_domain:
            lines.append(f"- {title} ({source_domain})")
        else:
            lines.append(f"- {title}")
    return lines
