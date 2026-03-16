from __future__ import annotations

import os

from ..core.context import CONTEXT_COMPRESSION_THRESHOLD
from ..core.context import MAX_CONTEXT_TOKENS
from ..core.context import estimate_context_tokens
from .prompt_utils import format_tool_list, resolve_available_tool_names
from .streaming_workflow import StreamingWorkflow

BENCHMARK_LOCAL_TOOLS = {
    "manage_todos",
}

BENCHMARK_BROWSER_TOOLS = {
    "browser_navigate",
    "browser_navigate_back",
    "browser_click",
    "browser_hover",
    "browser_type",
    "browser_fill_form",
    "browser_select_option",
    "browser_drag",
    "browser_wait_for",
    "browser_take_screenshot",
    "browser_handle_dialog",
    "browser_press_key",
    "browser_tabs",
    "browser_snapshot",
    "browser_close",
}

BENCHMARK_DEFAULT_TOOL_NAMES = BENCHMARK_LOCAL_TOOLS | BENCHMARK_BROWSER_TOOLS


def build_benchmark_system_prompt(available_tool_names: set[str] | None = None) -> str:
    names = resolve_available_tool_names(BENCHMARK_DEFAULT_TOOL_NAMES, available_tool_names)
    if "browser_snapshot" in names:
        inspection_rule = (
            "2. Explore first. Start with browser_snapshot before risky interactions unless the page state is already obvious."
        )
    else:
        inspection_rule = (
            "2. Explore first. Start with the best available browser inspection step before risky interactions unless the page state is already obvious."
        )

    return f"""You are a browser benchmark agent running WebArena-Verified tasks.

# Mission
Complete the assigned web task using browser tools only, then return a single valid JSON object as the final answer.

# Hard Rules
1. Use browser tools only for task execution. Do not use local shell, file editing, skills, or sub-agents.
{inspection_rule}
3. Prefer direct navigation when a URL is known and reliable.
4. When refs are ambiguous, stale, duplicated, or state-sensitive, refresh the DOM snapshot or use nearby stable refs instead of switching to visual tools.
5. Behave like a user. Do not rely on hidden-page scripting tricks.
6. If the required information is already visible in the current snapshot, extract it directly before exploring further.
7. For ranked tables or ordered lists, top-1 means the first matching row/item currently shown.
8. For NAVIGATE tasks, do not stop at an approximate page. Keep going until the exact target page or exact target list is open.
9. Prefer visible links, submenu entries, and page-provided destinations over guessed admin URLs.
10. When editing prices or currency-like fields, preserve the page's decimal formatting exactly unless the task says otherwise.
11. Keep internal narration extremely short. Do not restate the page, quote snapshots, or summarize obvious observations at length.
12. Prefer DOM/snapshot/browser refs whenever possible. Benchmark mode should solve tasks without visual inspection or point-based interaction.
13. If a tool times out or fails, either try one concise fallback or terminate with valid JSON. Never end with prose.
14. Follow ranking and recency words literally. If the task says newest, most recent, latest, first, top, or top 10, do not switch to a different item just because it is easier to inspect or has non-empty data.
15. Zero, empty lists, and null authors can be correct outcomes. Do not replace the target item with a different one to avoid returning zero or empty results.
16. For extraction fields, copy text values exactly as they appear in page content. Do not expand abbreviations, infer missing text, or substitute a fuller variant.
17. If a field is missing in the source text and the task still requires the field, keep it null instead of inventing a value.
18. For RETRIEVE tasks, once the requested values are known, stop browsing and output the JSON immediately.
19. If you just typed into a local composer, dialog, inline editor, or form section, use the submit button from that same local scope. Do not jump to a page-level button with the same label.
20. If a tool reports the actual edited input target or local submit candidates, treat that as the preferred scope for the next submission action.
21. You are not finished until you emit one valid raw JSON object.

# Tool Policy
- Allowed planning tool: manage_todos.
- Allowed tools in this run: {format_tool_list(names)}.
- Not allowed: local execution tools, file modification tools, skill tools, sub-agent tools.

# Task Completion Output
When the task is complete or cannot be completed, your final answer MUST be a single JSON object with exactly these keys:
- task_type
- status
- retrieved_data
- error_details

# task_type
- RETRIEVE: when the main objective is extracting information.
- NAVIGATE: when the main objective is reaching or showing a specific page/location.
- MUTATE: when the main objective is creating, editing, deleting, or changing state/data.

# status
Use one of:
- SUCCESS
- ACTION_NOT_ALLOWED_ERROR
- PERMISSION_DENIED_ERROR
- NOT_FOUND_ERROR
- DATA_VALIDATION_ERROR
- UNKNOWN_ERROR

# retrieved_data
- For RETRIEVE tasks: always return a JSON array, even for a single item.
- For RETRIEVE tasks: return only the minimally requested raw values.
- Prefer plain strings or numbers over wrapper objects unless the task explicitly asks for structured records.
- For NAVIGATE or MUTATE tasks: return null.

# error_details
- Return null on SUCCESS.
- Otherwise provide a concise reason.

# Final Answer Format
- Output only raw JSON.
- No markdown fences.
- No commentary before or after the JSON.
- Before sending, self-check that the top-level keys are exactly: task_type, status, retrieved_data, error_details.
"""


BENCHMARK_SYSTEM_PROMPT = build_benchmark_system_prompt()


class BenchmarkWorkflow(StreamingWorkflow):
    SYSTEM_PROMPT = BENCHMARK_SYSTEM_PROMPT
    ALLOWED_TOOL_NAMES = BENCHMARK_LOCAL_TOOLS
    ALLOW_BROWSER_TOOLS = True
    ALLOWED_BROWSER_TOOLS = BENCHMARK_BROWSER_TOOLS

    _FULL_TOOL_RESULTS_TO_KEEP = 6
    _LONG_TOOL_OUTPUT_THRESHOLD = 1200
    _TRUNCATED_HEAD_CHARS = 280
    _TRUNCATED_TAIL_CHARS = 220
    _AGGRESSIVE_TOOL_OUTPUT_THRESHOLD = 480
    _AGGRESSIVE_TRUNCATED_HEAD_CHARS = 150
    _AGGRESSIVE_TRUNCATED_TAIL_CHARS = 100
    _DEFAULT_AUTO_COMPACT_LIMIT = min(
        CONTEXT_COMPRESSION_THRESHOLD,
        int(MAX_CONTEXT_TOKENS * 0.9) if MAX_CONTEXT_TOKENS > 0 else CONTEXT_COMPRESSION_THRESHOLD,
    )
    _AUTO_COMPACT_TOKEN_LIMIT = max(
        4000,
        int(os.getenv("BENCHMARK_AUTO_COMPACT_TOKEN_LIMIT", str(_DEFAULT_AUTO_COMPACT_LIMIT))),
    )
    _CONTEXT_RESERVE_TOKENS = max(
        1000,
        int(os.getenv("BENCHMARK_CONTEXT_RESERVE_TOKENS", "12000")),
    )
    _HISTORY_TOKEN_BUDGET = max(
        3000,
        _AUTO_COMPACT_TOKEN_LIMIT - _CONTEXT_RESERVE_TOKENS,
    )
    _MIN_MESSAGES_AFTER_PRUNE = 8
    _COMPACTION_SUMMARY_MAX_CHARS = 2400
    _SUMMARY_PREFIX = (
        "Context checkpoint: earlier turn details were compacted to keep the request inside the model context window. "
        "Use this summary plus current browser state to continue without repeating old exploration."
    )

    def get_system_prompt(self) -> str:
        return build_benchmark_system_prompt(self.get_available_tool_names())

    def _compact_tool_output(
        self,
        content: str,
        *,
        threshold: int,
        head_chars: int,
        tail_chars: int,
    ) -> str:
        if len(content) <= threshold:
            return content

        omitted = max(0, len(content) - head_chars - tail_chars)
        head = content[:head_chars].rstrip()
        tail = content[-tail_chars:].lstrip()
        return (
            f"{head}\n\n"
            f"[benchmark history truncated {omitted} chars from an older tool result to save context]\n\n"
            f"{tail}"
        )

    def _estimate_history_tokens(self, history: list[dict]) -> int:
        return estimate_context_tokens("", history)

    def _compact_tool_history(
        self,
        history: list[dict],
        *,
        keep_full_recent: int,
        threshold: int,
        head_chars: int,
        tail_chars: int,
    ) -> list[dict]:
        tool_result_total = sum(1 for message in history if message.get("role") == "tool")
        keep_full_from = max(0, tool_result_total - keep_full_recent)
        tool_result_index = 0
        transformed: list[dict] = []

        for message in history:
            item = dict(message)
            if item.get("role") == "tool":
                content = item.get("content")
                if (
                    tool_result_index < keep_full_from
                    and isinstance(content, str)
                    and len(content) > threshold
                ):
                    item["content"] = self._compact_tool_output(
                        content,
                        threshold=threshold,
                        head_chars=head_chars,
                        tail_chars=tail_chars,
                    )
                tool_result_index += 1
            transformed.append(item)

        return transformed

    def _build_compaction_summary(self, removed: list[dict]) -> str:
        if not removed:
            return ""

        user_snippets: list[str] = []
        assistant_snippets: list[str] = []
        tool_count = 0

        for message in removed:
            role = message.get("role")
            content = message.get("content")
            if role == "tool":
                tool_count += 1
                continue
            if not isinstance(content, str):
                continue
            text = " ".join(content.strip().split())
            if not text:
                continue
            if role == "user":
                user_snippets.append(text[:180])
            elif role == "assistant":
                assistant_snippets.append(text[:160])

        lines: list[str] = [self._SUMMARY_PREFIX]
        lines.append(
            f"- Compacted {len(removed)} older messages (tool outputs: {tool_count})."
        )
        if user_snippets:
            lines.append("- Earlier user intents:")
            for snippet in user_snippets[-3:]:
                lines.append(f"  - {snippet}")
        if assistant_snippets:
            lines.append("- Earlier assistant conclusions/actions:")
            for snippet in assistant_snippets[-2:]:
                lines.append(f"  - {snippet}")

        summary = "\n".join(lines).strip()
        if len(summary) > self._COMPACTION_SUMMARY_MAX_CHARS:
            summary = summary[: self._COMPACTION_SUMMARY_MAX_CHARS].rstrip()
        return summary

    def _prune_history_to_budget(self, history: list[dict], budget_tokens: int) -> list[dict]:
        if not history:
            return history

        working = [dict(message) for message in history]
        removed: list[dict] = []
        min_keep = min(self._MIN_MESSAGES_AFTER_PRUNE, len(working))

        while self._estimate_history_tokens(working) > budget_tokens and len(working) > min_keep:
            removed.append(working.pop(0))

        summary = self._build_compaction_summary(removed)
        summary_inserted = False
        if summary:
            working.insert(0, {"role": "user", "content": summary})
            summary_inserted = True

        # Hard fallback: if we are still over budget, continue dropping oldest items.
        while self._estimate_history_tokens(working) > budget_tokens and len(working) > 1:
            if summary_inserted and len(working) > 2:
                working.pop(1)
                continue
            working.pop(0)

        return working

    def transform_history_for_model(self, history: list[dict]) -> list[dict]:
        transformed = self._compact_tool_history(
            history,
            keep_full_recent=self._FULL_TOOL_RESULTS_TO_KEEP,
            threshold=self._LONG_TOOL_OUTPUT_THRESHOLD,
            head_chars=self._TRUNCATED_HEAD_CHARS,
            tail_chars=self._TRUNCATED_TAIL_CHARS,
        )

        if self._estimate_history_tokens(transformed) <= self._HISTORY_TOKEN_BUDGET:
            return transformed

        # Codex-like second stage: once we cross the compaction budget, compact
        # even recent long tool outputs instead of keeping a fixed recent set.
        transformed = self._compact_tool_history(
            transformed,
            keep_full_recent=0,
            threshold=self._AGGRESSIVE_TOOL_OUTPUT_THRESHOLD,
            head_chars=self._AGGRESSIVE_TRUNCATED_HEAD_CHARS,
            tail_chars=self._AGGRESSIVE_TRUNCATED_TAIL_CHARS,
        )

        if self._estimate_history_tokens(transformed) <= self._HISTORY_TOKEN_BUDGET:
            return transformed

        return self._prune_history_to_budget(
            transformed,
            budget_tokens=self._HISTORY_TOKEN_BUDGET,
        )
