from __future__ import annotations

from typing import Iterable, Set

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
