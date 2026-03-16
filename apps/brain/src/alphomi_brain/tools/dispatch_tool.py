import asyncio
import os
import uuid
from typing import Any, Dict, List, Optional

from ..core.context import AgentContext
from ..core.pras_client import PrasClient
from ..core.events import (
    ContentEvent,
    DoneEvent,
    ErrorEvent,
    ThinkEvent,
    ToolInputEvent,
    ToolOutputEvent,
    ToolStartEvent,
)
from ..core.tool_base import BaseTool, RiskLevel
from ..workflows.agent_node import AgentNodeWorkflow
from ..utils.config import load_config_from_yaml
from .todo_tool import _SESSION_TODOS, _SESSION_COMPLEX_TODOS

_SUB_AGENT_EVENT_SINKS: List[Any] = []
_USER_DATA_CACHE: Optional[Dict[str, Any]] = None


def _parse_bool(value: Any, fallback: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes", "y", "on")
    return fallback


def _normalize_scope(value: Any) -> str:
    if value == "active-only":
        return "active-only"
    return "visited-origins"


def _normalize_merge_policy(value: Any) -> str:
    if value == "overwrite":
        return "overwrite"
    if value == "replace_origin":
        return "replace_origin"
    return "merge"


def _get_user_data_config() -> Dict[str, Any]:
    global _USER_DATA_CACHE
    if _USER_DATA_CACHE is not None:
        return _USER_DATA_CACHE

    section = load_config_from_yaml("user_data") or {}
    _USER_DATA_CACHE = {
        "enabled": _parse_bool(section.get("enabled", False), False),
        "local_storage_scope": _normalize_scope(section.get("local_storage_scope")),
        "local_storage_merge": _normalize_merge_policy(section.get("local_storage_merge")),
    }
    return _USER_DATA_CACHE


def register_sub_agent_event_sink(sink) -> None:
    _SUB_AGENT_EVENT_SINKS.append(sink)


def unregister_sub_agent_event_sink(sink) -> None:
    if sink in _SUB_AGENT_EVENT_SINKS:
        _SUB_AGENT_EVENT_SINKS.remove(sink)


def _emit_sub_agent_event(payload: Dict[str, Any]) -> None:
    for sink in list(_SUB_AGENT_EVENT_SINKS):
        try:
            sink(payload)
        except Exception:
            pass


class DispatchSubAgentTool(BaseTool):
    name = "dispatch_sub_agent"
    description = (
        "Dispatch one or more sub-agents to execute tasks in parallel. "
        "Provide goals and required context; global progress is injected automatically."
    )

    @property
    def parameters(self):
        return {
            "assignments": {
                "type": "array",
                "description": "List of task assignments.",
                "items": {
                    "type": "object",
                    "properties": {
                        "task_index": {
                            "type": "integer",
                            "description": "1-based task index from the global board.",
                        },
                        "role": {
                            "type": "string",
                            "description": "Role persona for the sub-agent.",
                        },
                        "goal": {
                            "type": "string",
                            "description": "Clear, specific goal for the task.",
                        },
                        "background_info": {
                            "type": "string",
                            "description": "All required context or references.",
                        },
                        "output_requirement": {
                            "type": "string",
                            "description": "Required output format or constraints.",
                        },
                        "specific_skills": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Optional list of skills to load.",
                        },
                    },
                    "required": [
                        "role",
                        "goal",
                        "background_info",
                        "output_requirement",
                    ],
                },
            }
        }

    @property
    def required_params(self):
        return ["assignments"]

    async def execute(self, args: Dict[str, Any], context: Any = None) -> str:
        parent_session_id = "default"
        if context and hasattr(context, "session_id"):
            parent_session_id = context.session_id

        assignments = args.get("assignments")
        if not assignments:
            return "Error: 'assignments' is required."

        valid_entries: List[tuple[int, Dict[str, Any]]] = []
        invalid_entries: Dict[int, str] = {}

        for assignment_index, assignment in enumerate(assignments, start=1):
            error = self._validate_assignment(assignment, assignment_index)
            if error:
                invalid_entries[assignment_index] = error
                continue
            valid_entries.append((assignment_index, assignment))

        results_map: Dict[int, Any] = {}
        if valid_entries:
            tasks = [
                self._run_single_agent(parent_session_id, assignment, assignment_index)
                for assignment_index, assignment in valid_entries
            ]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            for (assignment_index, _), result in zip(valid_entries, results):
                results_map[assignment_index] = result

        lines = ["## Execution Report"]
        for idx, assignment in enumerate(assignments, start=1):
            role = assignment.get("role", "worker")
            task_index = assignment.get("task_index", idx)
            lines.append(f"\n### Task {task_index} ({role})")
            if idx in invalid_entries:
                lines.append(f"Error: {invalid_entries[idx]}")
                continue
            result = results_map.get(idx)
            if isinstance(result, Exception):
                lines.append(f"Error: {str(result)}")
            else:
                lines.append(result or "No result returned.")

        return "\n".join(lines)

    def _build_sub_agent_prompt(
        self,
        session_id: str,
        role: str,
        task_index: Optional[int],
        goal: str,
        background_info: str,
        output_requirement: str,
        specific_skills: Optional[List[str]] = None,
    ) -> tuple[str, str]:
        resolved_index = task_index if task_index is not None else 1
        board_snapshot, task_desc = self._build_global_snapshot(
            session_id, resolved_index
        )
        skills_line = ""
        if specific_skills:
            skills_line = f"\nSpecific Skills to load: {', '.join(specific_skills)}"

        system_prompt = (
            "Identity\n"
            f"You are a specialized worker agent. Your role is: {role}.\n\n"
            "Context & Mission\n"
            "You are part of a larger mission.\n"
            "Here is the Global Plan (Reference Only):\n"
            f"{board_snapshot}\n\n"
            "YOUR ASSIGNMENT:\n"
            f"You are solely responsible for Task #{resolved_index}: \"{task_desc}\".\n"
            "Do NOT attempt to solve other tasks in the global plan.\n\n"
            "Capabilities\n"
            "1. Browser tools: navigate, click, type, snapshot.\n"
            "2. Local planning: you may use manage_todos for a local plan.\n"
            "3. Skills: you can use manage_skills to learn new capabilities."
            f"{skills_line}\n\n"
            "Operational Rules\n"
            "1. Explore first: snapshot before interactions.\n"
            "2. Self-correction: recover from failures when possible.\n"
            "3. Final output must follow this requirement:\n"
            f"{output_requirement}\n"
        )

        user_input = (
            f"Goal: {goal}\n\n"
            "Essential Background Info:\n"
            f"{background_info}\n\n"
            "Please start execution immediately."
        )

        return system_prompt, user_input

    def _validate_assignment(self, assignment: Dict[str, Any], assignment_index: int) -> Optional[str]:
        required_fields = ["role", "goal", "background_info", "output_requirement"]
        missing = [field for field in required_fields if not assignment.get(field)]
        if missing:
            missing_str = ", ".join(missing)
            return f"Assignment {assignment_index} missing required fields: {missing_str}."
        return None

    def _build_global_snapshot(
        self, session_id: str, task_index: int
    ) -> tuple[str, str]:
        complex_list = _SESSION_COMPLEX_TODOS.get(session_id, [])
        if complex_list:
            snapshot = self._render_complex_markdown(complex_list)
            desc = self._task_desc_from_complex(complex_list, task_index)
            return snapshot, desc

        simple_list = _SESSION_TODOS.get(session_id, [])
        snapshot = self._render_simple_markdown(simple_list)
        desc = self._task_desc_from_simple(simple_list, task_index)
        return snapshot, desc

    def _task_desc_from_complex(
        self, todo_list: List[Dict[str, Any]], task_index: int
    ) -> str:
        real_idx = task_index - 1
        if 0 <= real_idx < len(todo_list):
            return str(todo_list[real_idx].get("desc", ""))
        return "Unknown task"

    def _task_desc_from_simple(
        self, todo_list: List[Dict[str, Any]], task_index: int
    ) -> str:
        real_idx = task_index - 1
        if 0 <= real_idx < len(todo_list):
            return str(todo_list[real_idx].get("text", ""))
        return "Unknown task"

    def _render_complex_markdown(self, todo_list: List[Dict[str, Any]]) -> str:
        if not todo_list:
            return "No active plan."

        lines = ["# Mission Control Board"]
        ready_indices = set()

        first_pending_idx = None
        for i, item in enumerate(todo_list):
            if item.get("status") == "pending":
                first_pending_idx = i
                break

        if first_pending_idx is not None:
            first_group = todo_list[first_pending_idx].get("group")
            if first_group:
                i = first_pending_idx
                while i < len(todo_list):
                    item = todo_list[i]
                    if item.get("status") != "pending" or item.get("group") != first_group:
                        break
                    ready_indices.add(i)
                    i += 1
            else:
                ready_indices.add(first_pending_idx)

        status_symbols = {
            "pending": " ",
            "done": "x",
            "failed": "!",
            "skipped": "-",
        }

        for i, item in enumerate(todo_list):
            idx = i + 1
            status = item.get("status", "pending")
            mark = status_symbols.get(status, " ")
            desc = item.get("desc", "")
            group = item.get("group")
            group_str = f" (Group: {group})" if group else ""
            line = f"{idx}. [{mark}] {desc}{group_str}"

            if status == "failed":
                line += " <--- FAILED"
            if i in ready_indices:
                line += " <--- READY"

            lines.append(line)

            result = item.get("result")
            if result:
                lines.append(f"   - Result: {result}")

        return "\n".join(lines)

    async def _clone_user_data(
        self,
        parent_session_id: str,
        sub_session_id: str,
    ) -> None:
        config = _get_user_data_config()
        if not config.get("enabled"):
            return

        try:
            parent_client = PrasClient(parent_session_id)
            snapshot = await parent_client.get_storage_state(
                scope=config.get("local_storage_scope", "visited-origins")
            )
            if not snapshot or snapshot.get("error"):
                return

            sub_client = PrasClient(sub_session_id)
            await sub_client.apply_storage_state(
                cookies=snapshot.get("cookies", []),
                local_storage=snapshot.get("localStorage", {}),
                merge_policy=config.get("local_storage_merge", "merge"),
            )
        except Exception:
            return

    def _render_simple_markdown(self, todo_list: List[Dict[str, Any]]) -> str:
        if not todo_list:
            return "No active plan."

        lines = ["# Current Task List"]
        next_found = False
        status_symbols = {
            "pending": " ",
            "done": "x",
            "failed": "-",
            "skipped": "?",
        }

        for i, item in enumerate(todo_list):
            idx = i + 1
            mark = status_symbols.get(item.get("status"), " ")
            text = item.get("text", "")
            result_str = f" (Result: {item.get('result')})" if item.get("result") else ""
            line = f"{idx}. [{mark}] {text}{result_str}"
            if item.get("status") == "pending" and not next_found:
                line += " <--- CURRENT STEP"
                next_found = True
            lines.append(line)

        if not next_found:
            lines.append("\n[All tasks completed]")

        return "\n".join(lines)

    async def _run_single_agent(
        self, parent_session_id: str, assignment: Dict[str, Any], assignment_index: int
    ) -> str:
        role = assignment.get("role", "worker")
        goal = assignment.get("goal", "")
        task_index = assignment.get("task_index")
        background_info = assignment.get("background_info", "")
        output_requirement = assignment.get("output_requirement", "")
        specific_skills = assignment.get("specific_skills")

        system_prompt, user_input = self._build_sub_agent_prompt(
            session_id=parent_session_id,
            role=role,
            task_index=task_index,
            goal=goal,
            background_info=background_info,
            output_requirement=output_requirement,
            specific_skills=specific_skills,
        )

        sub_session_id: str | None = None
        try:
            headless = os.getenv("SUB_AGENT_HEADLESS", "true").lower() != "false"
            sub_session_id = await PrasClient.create_session(headless=headless)
        except Exception as e:
            _emit_sub_agent_event({
                "type": "error",
                "session_id": parent_session_id,
                "assignment": {
                    "assignment_index": assignment_index,
                    "task_index": task_index,
                    "role": role,
                    "goal": goal,
                },
                "error": str(e),
            })
            return f"Error: failed to create sub-agent browser session: {e}"

        await self._clone_user_data(parent_session_id, sub_session_id)

        sub_context = AgentContext(session_id=sub_session_id)
        combined_input = (
            "System Briefing (do not ignore):\n"
            f"{system_prompt}\n\n"
            "User Task:\n"
            f"{user_input}"
        )
        sub_context.add_user_message(combined_input, str(uuid.uuid4()))

        workflow = AgentNodeWorkflow(sub_context)

        content_parts: List[str] = []
        errors: List[str] = []

        summary = {
            "assignment_index": assignment_index,
            "task_index": task_index,
            "role": role,
            "goal": goal,
        }

        _emit_sub_agent_event({
            "type": "sub_agent_start",
            "session_id": parent_session_id,
            "assignment": summary,
        })

        try:
            async for event in workflow.run(user_input):
                if isinstance(event, ContentEvent):
                    content_parts.append(event.content)
                    _emit_sub_agent_event({
                        "type": "content_chunk",
                        "session_id": parent_session_id,
                        "assignment": summary,
                        "content": event.content,
                    })
                elif isinstance(event, ThinkEvent):
                    _emit_sub_agent_event({
                        "type": "think_chunk",
                        "session_id": parent_session_id,
                        "assignment": summary,
                        "content": event.content,
                    })
                elif isinstance(event, ToolStartEvent):
                    _emit_sub_agent_event({
                        "type": "tool_start",
                        "session_id": parent_session_id,
                        "assignment": summary,
                        "tool_call_id": event.id,
                        "tool_name": event.name,
                    })
                elif isinstance(event, ToolInputEvent):
                    _emit_sub_agent_event({
                        "type": "tool_input",
                        "session_id": parent_session_id,
                        "assignment": summary,
                        "tool_call_id": event.id,
                        "args": event.args,
                    })
                elif isinstance(event, ToolOutputEvent):
                    _emit_sub_agent_event({
                        "type": "tool_output",
                        "session_id": parent_session_id,
                        "assignment": summary,
                        "tool_call_id": event.id,
                        "result": event.result,
                    })
                elif isinstance(event, ErrorEvent):
                    errors.append(event.error)
                    _emit_sub_agent_event({
                        "type": "error",
                        "session_id": parent_session_id,
                        "assignment": summary,
                        "error": event.error,
                    })
                elif isinstance(event, DoneEvent):
                    _emit_sub_agent_event({
                        "type": "done",
                        "session_id": parent_session_id,
                        "assignment": summary,
                    })
                    break
        finally:
            if sub_session_id:
                await PrasClient.close_session(sub_session_id)

        content = "".join(content_parts).strip()
        if content:
            return content
        if errors:
            return f"Error: {errors[-1]}"
        return "No content returned."

    def calculate_risk(self, args: Dict[str, Any]) -> RiskLevel:
        return RiskLevel.SAFE
