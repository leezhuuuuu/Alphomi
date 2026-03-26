from __future__ import annotations

from .prompt_utils import (
    format_tool_list,
    get_saved_teaching_catalog_lines,
    resolve_available_tool_names,
)
from .streaming_workflow import StreamingWorkflow


ADVANCED_LOCAL_TOOLS = {
    "manage_complex_todos",
    "manage_skills",
    "manage_teachings",
    "dispatch_sub_agent",
    "browser_render_markdown",
}


def build_advanced_system_prompt(available_tool_names: set[str] | None = None) -> str:
    names = resolve_available_tool_names(ADVANCED_LOCAL_TOOLS, available_tool_names)
    saved_teachings = get_saved_teaching_catalog_lines()
    teachings_block = "\n".join(saved_teachings) if saved_teachings else "none"

    lines = ["You are an advanced commander agent focused on planning and coordination.", "", "# Core Capabilities"]
    capability_index = 1

    if "manage_complex_todos" in names:
        lines.append(f"{capability_index}. Advanced Planning: use manage_complex_todos to build grouped, parallel plans.")
        capability_index += 1
    if "dispatch_sub_agent" in names:
        lines.append(f"{capability_index}. Delegation: use dispatch_sub_agent to execute READY tasks in parallel.")
        capability_index += 1
    if "manage_skills" in names:
        lines.append(f"{capability_index}. Skill Extension: use manage_skills when extra capability is needed.")
        capability_index += 1
    if "manage_teachings" in names:
        lines.append(f"{capability_index}. Teaching Reuse: use manage_teachings when saved teachings may help the current task.")
        capability_index += 1
    if "browser_render_markdown" in names:
        lines.append(f"{capability_index}. Reporting: use browser_render_markdown to present polished Markdown reports.")

    lines.extend(["", "# Core Rules"])
    rule_index = 1

    lines.append(
        f"{rule_index}. Stay in commander mode. Do not use browser or local execution tools except those explicitly allowed below."
    )
    rule_index += 1

    if "browser_render_markdown" in names:
        lines.append(
            f"{rule_index}. When the user wants a report or summary without specifying a format, use browser_render_markdown by default."
        )
        rule_index += 1

    if "manage_complex_todos" in names:
        lines.append(f"{rule_index}. For multi-step goals, always plan first with manage_complex_todos.")
        rule_index += 1

    if "dispatch_sub_agent" in names:
        lines.append(
            f"{rule_index}. Use dispatch_sub_agent to delegate READY tasks, collect results, and update the plan."
        )
        rule_index += 1

    if "manage_teachings" in names:
        lines.extend(
            [
                f"{rule_index}. Teaching reuse rules:",
                "   - Use manage_teachings(action='list') to inspect saved teachings.",
                "   - Use manage_teachings(action='details', ...) only for a specific teaching that is likely relevant.",
                "   - Recommend a relevant teaching first, then read its details after the user confirms.",
            ]
        )
        rule_index += 1

    lines.extend(
        [
            f"{rule_index}. Tool Limits:",
            f"   - Allowed: {format_tool_list(names)}.",
            "   - Not allowed: any tool not listed above.",
            "",
            "# Saved Teachings (lightweight catalog)",
            teachings_block,
            "",
            "# Output",
            "Output ONLY valid tool calls or a final answer to the user.",
        ]
    )

    return "\n".join(lines)


ADVANCED_SYSTEM_PROMPT = build_advanced_system_prompt()


class AdvancedWorkflow(StreamingWorkflow):
    SYSTEM_PROMPT = ADVANCED_SYSTEM_PROMPT
    ALLOWED_TOOL_NAMES = ADVANCED_LOCAL_TOOLS
    ALLOW_BROWSER_TOOLS = False

    def get_system_prompt(self) -> str:
        return build_advanced_system_prompt(self.get_available_tool_names())
