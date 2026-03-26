from __future__ import annotations

from .prompt_utils import (
    format_tool_list,
    get_saved_teaching_catalog_lines,
    has_any,
    has_all,
    resolve_available_tool_names,
)
from .streaming_workflow import StreamingWorkflow


FAST_LOCAL_TOOLS = {
    "manage_todos",
    "manage_skills",
    "manage_teachings",
    "exec_command",
    "write_stdin",
    "file_edit",
}

FAST_BROWSER_TOOLS = {
    "browser_navigate",
    "browser_click",
    "browser_type",
    "browser_snapshot",
    "browser_tabs",
    "browser_render_markdown",
    "browser_inspect_visual",
    "browser_ask_visual",
    "browser_click_point",
    "browser_type_point",
}

FAST_DEFAULT_TOOL_NAMES = FAST_LOCAL_TOOLS | FAST_BROWSER_TOOLS


def _get_installed_skill_names() -> list[str]:
    try:
        from skills_mcp import local

        skills = local.get_installed_skills()
    except Exception:
        return []

    names: list[str] = []
    for skill in skills or []:
        if not isinstance(skill, dict):
            continue
        name = skill.get("name")
        if isinstance(name, str) and name:
            names.append(name)
    return names


def build_fast_system_prompt(available_tool_names: set[str] | None = None) -> str:
    names = resolve_available_tool_names(FAST_DEFAULT_TOOL_NAMES, available_tool_names)
    installed_skills = _get_installed_skill_names()
    skills_block = "\n".join(installed_skills) if installed_skills else "none"
    saved_teachings = get_saved_teaching_catalog_lines()
    teachings_block = "\n".join(saved_teachings) if saved_teachings else "none"

    lines: list[str] = ["You are the Alphomi agent using the minimax-m2.1 model.", ""]
    lines.append("# Core Capabilities")
    capability_index = 1

    if has_any(names, *FAST_BROWSER_TOOLS):
        browser_summary = "available browser tools"
        if has_all(names, "browser_navigate", "browser_click", "browser_type", "browser_snapshot"):
            browser_summary = "navigate, click, type, and inspect webpages"
        elif "browser_snapshot" in names:
            browser_summary = "inspect and operate on webpages"
        lines.append(f"{capability_index}. Browser Control: Use {browser_summary}.")
        capability_index += 1

    if "manage_skills" in names:
        lines.append(f"{capability_index}. Skill Extension: You can self-evolve using the manage_skills tool.")
        capability_index += 1

    if "manage_teachings" in names:
        lines.append(
            f"{capability_index}. Teaching Reuse: You can reuse previously saved teachings with the manage_teachings tool."
        )
        capability_index += 1

    if has_any(names, "exec_command", "file_edit", "write_stdin"):
        file_parts: list[str] = []
        if "exec_command" in names:
            file_parts.append("exec_command for read/list/process startup")
        if "file_edit" in names:
            file_parts.append("file_edit for modifications")
        if "write_stdin" in names:
            file_parts.append("write_stdin for interactive sessions")
        lines.append(f"{capability_index}. Local Workspace Operations: Use {', '.join(file_parts)}.")

    if "manage_skills" in names:
        lines.extend(
            [
                "",
                "# Skill Management Rules (STRICT)",
                "1. To check installed skills, ALWAYS use manage_skills(action='list').",
                "2. To find skills, use manage_skills(action='search', query='...').",
                "3. To install a skill, use manage_skills(action='install', name='...').",
                "4. To learn a skill, use manage_skills(action='details', name='...').",
            ]
        )

    if "manage_teachings" in names:
        lines.extend(
            [
                "",
                "# Teaching Reuse Rules (STRICT)",
                "1. To check saved teachings, ALWAYS use manage_teachings(action='list').",
                "2. To inspect one saved teaching, use manage_teachings(action='details', asset_id='...') or manage_teachings(action='details', title='...').",
                "3. Do not assume a teaching applies only from its title.",
                "4. When a saved teaching looks relevant, recommend it first before relying on it.",
                "5. After the user confirms, read its details and use it as reference context for the current task only.",
            ]
        )

    lines.extend(["", "# Core Rules"])
    rule_index = 1

    if "browser_snapshot" in names:
        lines.append(f"{rule_index}. Explore first: you are initially blind, use browser_snapshot before acting.")
        rule_index += 1
    elif has_any(names, "browser_inspect_visual", "browser_ask_visual"):
        lines.append(
            f"{rule_index}. Inspect visible page state before risky actions using the available visual tools."
        )
        rule_index += 1

    if has_all(names, "browser_click", "browser_type", "browser_snapshot"):
        lines.extend(
            [
                f"{rule_index}. Certainty-first interaction policy:",
                "   - Use ref-based browser tools (browser_click/browser_type) only when the snapshot gives a unique stable ref, the action is not state-sensitive, and a mistaken click is low-risk.",
                "   - If any of those conditions is not true, prefer a safer inspection or navigation path first.",
            ]
        )
        rule_index += 1

    if has_any(names, "browser_inspect_visual", "browser_click_point", "browser_type_point"):
        lines.append(f"{rule_index}. Prefer visual tools for uncertain or complex browser actions:")
        if "browser_inspect_visual" in names:
            lines.append(
                "   - Use browser_inspect_visual when refs are missing, ambiguous, stale, repeated, position-dependent, or visually state-sensitive."
            )
            lines.append(
                "   - browser_inspect_visual requires targetName and includeState. Always pass includeState explicitly."
            )
        if has_any(names, "browser_click_point", "browser_type_point"):
            lines.append("   - Execute chosen visual targets with browser_click_point or browser_type_point.")
        rule_index += 1

    if "browser_ask_visual" in names:
        lines.extend(
            [
                f"{rule_index}. Visual question answering:",
                "   - Use browser_ask_visual to understand screenshot content, compare images, or answer visual questions without needing coordinates.",
                "   - Provide captureScope, imageRefs, or both, and default to answerMode=\"text\" unless structured JSON is required.",
            ]
        )
        rule_index += 1

    if has_any(names, *FAST_BROWSER_TOOLS):
        lines.extend(
            [
                f"{rule_index}. Browser-first policy:",
                "   - When a task involves opening or operating on webpages, default to the available browser_* tools.",
                "   - Only use local execution for webpage operations if the user explicitly asks for it or browser tools cannot accomplish the task.",
            ]
        )
        rule_index += 1

    if "browser_navigate" in names:
        lines.extend(
            [
                f"{rule_index}. Navigation preference (stability-first, not absolute):",
                "   - If a reliable link or URL is available, prefer browser_navigate over multi-step clicking.",
                "   - Use browser_click when direct navigation is not possible, not reliable, or the user explicitly wants clicking.",
            ]
        )
        rule_index += 1

        lines.extend(
            [
                f"{rule_index}. Search strategy (URL-first when appropriate):",
                "   - When you know a search engine or site query URL pattern, prefer direct URL construction through browser_navigate.",
                "   - Fall back to snapshot plus interaction when the URL pattern is unknown or unreliable.",
            ]
        )
        rule_index += 1

    if "manage_todos" in names:
        lines.append(
            f"{rule_index}. Planning: for complex or multi-step goals, use manage_todos before execution."
        )
        rule_index += 1

    if "browser_render_markdown" in names:
        lines.append(
            f"{rule_index}. Report rendering: when the user wants a report or summary without specifying a format, use browser_render_markdown by default."
        )
        rule_index += 1

    if has_any(names, "exec_command", "file_edit", "write_stdin"):
        lines.append(f"{rule_index}. File operation rules:")
        if "exec_command" in names:
            lines.append("   - Use exec_command for read/list/permissions and process startup.")
        if "file_edit" in names:
            lines.append("   - Use file_edit for all file modifications.")
            lines.append(
                "   - file_edit requires exact original_text and new_text values. Include enough surrounding context to make the replacement unique."
            )
        if "write_stdin" in names:
            lines.append(
                "   - Use write_stdin for interactive sessions, small polling windows, and stop signals such as SIGINT."
            )
        rule_index += 1

    lines.extend(
        [
            f"{rule_index}. Tool Limits:",
            f"   - Allowed: {format_tool_list(names)}.",
            "   - Not allowed: any tool not listed above.",
        ]
    )
    rule_index += 1

    lines.extend(
        [
            f"{rule_index}. Resilience:",
            "   - If a browser action fails with TIMEOUT, refresh your inspection context before retrying.",
            "   - Do not repeat the exact same failed action more than once.",
            "",
            "# Output",
            "Output ONLY valid tool calls or a final answer to the user.",
            "",
            "# Style",
            "Avoid decorative symbols unless the user explicitly requests them.",
            "Responses are rendered as Markdown; output accordingly.",
            "During execution, do not output partial answers; only provide the final response after tools complete.",
            "",
            "# Installed Skills (names only)",
            skills_block,
            "",
            "# Saved Teachings (lightweight catalog)",
            teachings_block,
        ]
    )

    return "\n".join(lines)


FAST_SYSTEM_PROMPT = build_fast_system_prompt()


class FastWorkflow(StreamingWorkflow):
    SYSTEM_PROMPT = FAST_SYSTEM_PROMPT
    ALLOWED_TOOL_NAMES = FAST_LOCAL_TOOLS
    ALLOW_BROWSER_TOOLS = True
    ALLOWED_BROWSER_TOOLS = FAST_BROWSER_TOOLS

    def get_system_prompt(self) -> str:
        return build_fast_system_prompt(self.get_available_tool_names())
