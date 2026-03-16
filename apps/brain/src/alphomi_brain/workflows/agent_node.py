from __future__ import annotations

from .prompt_utils import format_tool_list, has_any, has_all, resolve_available_tool_names
from .streaming_workflow import StreamingWorkflow


AGENT_NODE_LOCAL_TOOLS = {
    "manage_todos",
    "manage_skills",
}

AGENT_NODE_BROWSER_TOOLS = {
    "browser_navigate",
    "browser_click",
    "browser_type",
    "browser_snapshot",
    "browser_tabs",
    "browser_inspect_visual",
    "browser_ask_visual",
    "browser_click_point",
    "browser_type_point",
}

AGENT_NODE_DEFAULT_TOOL_NAMES = AGENT_NODE_LOCAL_TOOLS | AGENT_NODE_BROWSER_TOOLS


def build_agent_node_system_prompt(available_tool_names: set[str] | None = None) -> str:
    names = resolve_available_tool_names(AGENT_NODE_DEFAULT_TOOL_NAMES, available_tool_names)

    lines: list[str] = ["You are a specialized worker sub-agent.", "", "# Core Capabilities"]
    capability_index = 1

    if has_any(names, *AGENT_NODE_BROWSER_TOOLS):
        lines.append(f"{capability_index}. Browser Control: use the available browser tools to complete the assigned task.")
        capability_index += 1
    if "manage_todos" in names:
        lines.append(f"{capability_index}. Local Planning: use manage_todos for a small local plan if needed.")
        capability_index += 1
    if "manage_skills" in names:
        lines.append(f"{capability_index}. Skill Extension: use manage_skills if you need more capability.")

    lines.extend(["", "# Core Rules"])
    rule_index = 1

    if "browser_snapshot" in names:
        lines.append(f"{rule_index}. Explore first: use browser_snapshot before interacting with pages.")
        rule_index += 1
    elif has_any(names, "browser_inspect_visual", "browser_ask_visual"):
        lines.append(f"{rule_index}. Inspect visible state before risky actions using the available visual tools.")
        rule_index += 1

    if has_all(names, "browser_click", "browser_type", "browser_snapshot"):
        lines.extend(
            [
                f"{rule_index}. Certainty-first interaction policy:",
                "   - Use ref-based browser tools only when the snapshot gives a unique stable ref, the action is not state-sensitive, and a mistaken click is low-risk.",
                "   - If that certainty is missing, prefer a safer inspection step first.",
            ]
        )
        rule_index += 1

    if has_any(names, "browser_inspect_visual", "browser_click_point", "browser_type_point"):
        lines.append(f"{rule_index}. Prefer visual tools for uncertain or visually state-sensitive actions.")
        if "browser_inspect_visual" in names:
            lines.append(
                "   - Use browser_inspect_visual when refs are missing, stale, ambiguous, repeated, position-dependent, or state-sensitive."
            )
        if has_any(names, "browser_click_point", "browser_type_point"):
            lines.append("   - Execute the chosen target with browser_click_point or browser_type_point.")
        rule_index += 1

    if "browser_ask_visual" in names:
        lines.extend(
            [
                f"{rule_index}. Use browser_ask_visual for screenshot understanding, visual comparison, or visual Q&A when coordinates are not needed.",
                "   - Provide captureScope, imageRefs, or both, and use answerMode=\"text\" unless structured JSON is required.",
            ]
        )
        rule_index += 1

    if has_any(names, *AGENT_NODE_BROWSER_TOOLS):
        lines.append(f"{rule_index}. Browser-first policy: default to the available browser_* tools for webpage tasks.")
        rule_index += 1

    if "browser_navigate" in names:
        lines.extend(
            [
                f"{rule_index}. Prefer browser_navigate when you already know a reliable destination URL; use clicking only when direct navigation is not appropriate.",
                f"{rule_index + 1}. When a search URL pattern is known, prefer direct query construction before slower manual search flows.",
            ]
        )
        rule_index += 2

    lines.extend(
        [
            f"{rule_index}. Focus strictly on the assigned task. Do not solve unrelated work.",
            f"{rule_index + 1}. Tool Limits:",
            f"   - Allowed: {format_tool_list(names)}.",
            "   - Not allowed: any tool not listed above.",
            "",
            "# Output",
            "Output ONLY valid tool calls or a final answer to the user.",
        ]
    )

    return "\n".join(lines)


AGENT_NODE_SYSTEM_PROMPT = build_agent_node_system_prompt()


class AgentNodeWorkflow(StreamingWorkflow):
    SYSTEM_PROMPT = AGENT_NODE_SYSTEM_PROMPT
    ALLOWED_TOOL_NAMES = AGENT_NODE_LOCAL_TOOLS
    ALLOW_BROWSER_TOOLS = True
    ALLOWED_BROWSER_TOOLS = AGENT_NODE_BROWSER_TOOLS

    def get_system_prompt(self) -> str:
        return build_agent_node_system_prompt(self.get_available_tool_names())
