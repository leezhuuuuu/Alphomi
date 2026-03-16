from __future__ import annotations

import asyncio
import json
import os
import re
import time
from typing import AsyncGenerator, Optional, Set

from ..core.context import build_context_usage_payload
from ..core.events import (
    AgentEvent,
    ApprovalRequestEvent,
    ContentEvent,
    ContextUsageEvent,
    DoneEvent,
    ErrorEvent,
    ThinkEvent,
    ToolInputEvent,
    ToolOutputEvent,
    ToolStartEvent,
)
from ..core.guard import guard
from ..core.llm_client import CustomLLMClient
from ..core.pras_client import PrasClient
from ..core.tool_base import registry
from ..utils.tool_settings import is_tool_enabled
from .base import BaseWorkflow

TYPING_BASE = int(os.getenv("TYPING_BASE", "1"))
TYPING_BATCH_MAX = int(os.getenv("TYPING_BATCH_MAX", "10"))
TYPING_BACKLOG_DIV = int(os.getenv("TYPING_BACKLOG_DIV", "50"))
TYPING_ELAPSED_THRESHOLD = float(os.getenv("TYPING_ELAPSED_THRESHOLD", "0.2"))
TYPING_BOOST_MAX = int(os.getenv("TYPING_BOOST_MAX", "20"))
TYPING_SLEEP_SECONDS = float(os.getenv("TYPING_SLEEP_SECONDS", "0.05"))

client = CustomLLMClient()
THINK_BLOCK_RE = re.compile(r"<think>.*?</think>", re.IGNORECASE | re.DOTALL)


def _strip_think_tags(text: str) -> str:
    if not text:
        return ""
    cleaned = THINK_BLOCK_RE.sub("", text)
    cleaned = cleaned.replace("<think>", "").replace("</think>", "")
    return cleaned.strip()


class StreamingWorkflow(BaseWorkflow):
    SYSTEM_PROMPT: str = ""
    ALLOWED_TOOL_NAMES: Set[str] = set()
    ALLOW_BROWSER_TOOLS: bool = False
    ALLOWED_BROWSER_TOOLS: Set[str] = set()

    def transform_history_for_model(self, history: list[dict]) -> list[dict]:
        return [dict(message) for message in history]

    def build_context_usage_event_payload(self, full_system_prompt: str) -> dict:
        request_history = self.transform_history_for_model(self.context.history)
        return build_context_usage_payload(full_system_prompt, request_history)

    def _is_tool_allowed(self, name: str) -> bool:
        base_allowed = False
        if name in self.ALLOWED_TOOL_NAMES:
            base_allowed = True
        elif self.ALLOW_BROWSER_TOOLS and name.startswith("browser_"):
            if not self.ALLOWED_BROWSER_TOOLS:
                base_allowed = True
            else:
                base_allowed = name in self.ALLOWED_BROWSER_TOOLS

        if not base_allowed:
            return False

        return is_tool_enabled(name)

    def _get_tools_schema(self) -> list[dict]:
        schemas = []
        for tool in registry.get_all_tools():
            if self._is_tool_allowed(tool.name):
                schemas.append(tool.to_openai_schema())
        return schemas

    def get_available_tool_names(self) -> Set[str]:
        return {tool.name for tool in registry.get_all_tools() if self._is_tool_allowed(tool.name)}

    def get_system_prompt(self) -> str:
        return self.SYSTEM_PROMPT

    async def run(self, user_input: str) -> AsyncGenerator[AgentEvent, None]:
        event_queue: asyncio.Queue[Optional[AgentEvent]] = asyncio.Queue()

        async def emit(event: AgentEvent) -> None:
            await event_queue.put(event)

        async def _run_agent() -> None:
            tag_open = "<think>"
            tag_close = "</think>"
            think_buffer = ""
            in_think = False
            typing_queue: asyncio.Queue[tuple[str, str]] = asyncio.Queue()
            wake_event = asyncio.Event()
            typing_active = True
            flush_requested = False
            flush_waiter: asyncio.Future | None = None
            typing_task: asyncio.Task | None = None

            def _partial_suffix_len(text: str, tag: str) -> int:
                max_len = min(len(tag) - 1, len(text))
                for size in range(max_len, 0, -1):
                    if text.endswith(tag[:size]):
                        return size
                return 0

            def _split_think_chunks(text: str) -> list[tuple[bool, str]]:
                nonlocal think_buffer, in_think
                data = think_buffer + text
                think_buffer = ""
                parts: list[tuple[bool, str]] = []
                while data:
                    tag = tag_close if in_think else tag_open
                    idx = data.find(tag)
                    if idx == -1:
                        suffix_len = _partial_suffix_len(data, tag)
                        if suffix_len:
                            body = data[:-suffix_len]
                            if body:
                                parts.append((in_think, body))
                            think_buffer = data[-suffix_len:]
                        else:
                            parts.append((in_think, data))
                            think_buffer = ""
                        break
                    if idx > 0:
                        parts.append((in_think, data[:idx]))
                    data = data[idx + len(tag) :]
                    in_think = not in_think
                return parts

            def _enqueue_text(is_think: bool, text: str) -> None:
                if not text:
                    return
                kind = "think" if is_think else "content"
                for ch in text:
                    typing_queue.put_nowait((kind, ch))
                wake_event.set()

            async def _flush_think_buffer() -> None:
                nonlocal think_buffer
                if think_buffer:
                    _enqueue_text(in_think, think_buffer)
                    think_buffer = ""

            async def _flush_queue_once(max_chars: int) -> None:
                groups: list[tuple[str, list[str]]] = []
                count = 0
                while count < max_chars and not typing_queue.empty():
                    kind, ch = typing_queue.get_nowait()
                    if not groups or groups[-1][0] != kind:
                        groups.append((kind, [ch]))
                    else:
                        groups[-1][1].append(ch)
                    count += 1
                for kind, chars in groups:
                    content = "".join(chars)
                    if kind == "think":
                        await emit(ThinkEvent(content=content))
                    else:
                        await emit(ContentEvent(content=content))

            async def _request_flush() -> None:
                nonlocal flush_requested, flush_waiter
                if not typing_task or typing_task.done():
                    return
                if flush_waiter and not flush_waiter.done():
                    await flush_waiter
                    return
                flush_waiter = asyncio.get_running_loop().create_future()
                flush_requested = True
                wake_event.set()
                await flush_waiter

            async def typing_loop() -> None:
                nonlocal typing_active, flush_requested, flush_waiter
                last_flush = time.monotonic()
                while typing_active or not typing_queue.empty() or flush_requested:
                    if flush_requested:
                        while not typing_queue.empty():
                            await _flush_queue_once(2048)
                        flush_requested = False
                        if flush_waiter and not flush_waiter.done():
                            flush_waiter.set_result(True)
                        continue

                    if typing_queue.empty():
                        wake_event.clear()
                        try:
                            await asyncio.wait_for(wake_event.wait(), timeout=0.2)
                        except asyncio.TimeoutError:
                            pass
                        continue

                    now = time.monotonic()
                    elapsed = max(now - last_flush, 0.0)
                    last_flush = now
                    backlog = typing_queue.qsize()
                    base = TYPING_BASE
                    batch = min(TYPING_BATCH_MAX, base + backlog // max(TYPING_BACKLOG_DIV, 1))
                    if elapsed > TYPING_ELAPSED_THRESHOLD:
                        batch = min(TYPING_BOOST_MAX, batch + 2)

                    await _flush_queue_once(batch)
                    await asyncio.sleep(max(TYPING_SLEEP_SECONDS, 0.0))

            typing_task = asyncio.create_task(typing_loop())

            async def _stop_typing() -> None:
                nonlocal typing_active
                if typing_task and not typing_task.done():
                    await _request_flush()
                typing_active = False
                wake_event.set()
                if typing_task and not typing_task.done():
                    await typing_task

            try:
                while True:
                    system_context = await self.context.ensure_system_context()
                    system_prompt = self.get_system_prompt()
                    full_system_prompt = f"{system_prompt}\n\n{system_context}"
                    request_history = self.transform_history_for_model(self.context.history)
                    request_messages = [{"role": "system", "content": full_system_prompt}]
                    request_messages += request_history

                    tool_calls_buffer = []
                    full_text_response = ""
                    has_tool_call = False

                    current_tools_schema = self._get_tools_schema()
                    stream_error = False

                    async for event in client.stream_chat_completion(
                        request_messages, tools=current_tools_schema
                    ):
                        if "type" not in event:
                            await emit(
                                ErrorEvent(error="LLM stream returned invalid event")
                            )
                            stream_error = True
                            break

                        if event["type"] == "content":
                            content = event["content"]
                            if content:
                                full_text_response += content
                                for is_think, piece in _split_think_chunks(content):
                                    if not piece:
                                        continue
                                    _enqueue_text(is_think, piece)

                        elif event["type"] == "tool_start":
                            has_tool_call = True
                            await _request_flush()
                            await emit(
                                ToolStartEvent(id=event["id"], name=event["name"])
                            )

                        elif event["type"] == "tool_end":
                            call_id = event["id"]
                            name = event["name"]
                            args_str = event["args"]

                            safe_args_str = (
                                args_str if args_str and args_str.strip() else "{}"
                            )
                            history_safe_args = safe_args_str

                            try:
                                args = json.loads(safe_args_str)
                                await _request_flush()
                                await emit(
                                    ToolInputEvent(id=call_id, args=args)
                                )

                                history_safe_args = safe_args_str

                                if not self._is_tool_allowed(name):
                                    err_msg = f"Error: Tool '{name}' is not available in this mode."
                                    tool_calls_buffer.append(
                                        {
                                            "tool_call": {
                                                "id": call_id,
                                                "type": "function",
                                                "function": {
                                                    "name": name,
                                                    "arguments": history_safe_args,
                                                },
                                            },
                                            "result": err_msg,
                                        }
                                    )
                                    await emit(
                                        ToolOutputEvent(id=call_id, result=err_msg)
                                    )
                                    continue

                                if not guard.check_permission(name, args):
                                    approval_id, _ = self.context.create_approval()
                                    risk_label = guard.get_risk_level(name, args)

                                    await emit(
                                        ApprovalRequestEvent(
                                            id=approval_id,
                                            toolCallId=call_id,
                                            toolName=name,
                                            args=args,
                                            riskLevel=risk_label,
                                        )
                                    )

                                    user_decision = await self.context.wait_for_approval(
                                        approval_id
                                    )

                                    if user_decision != "approved":
                                        err_msg = "User rejected this action."
                                        tool_calls_buffer.append(
                                            {
                                                "tool_call": {
                                                    "id": call_id,
                                                    "type": "function",
                                                    "function": {
                                                        "name": name,
                                                        "arguments": history_safe_args,
                                                    },
                                                },
                                                "result": err_msg,
                                            }
                                        )
                                        await emit(
                                            ToolOutputEvent(
                                                id=call_id, result=err_msg
                                            )
                                        )
                                        continue

                                tool = registry.get_tool(name)
                                result = ""
                                if tool:
                                    ctx = (
                                        PrasClient(self.context.session_id)
                                        if self.context.session_id
                                        else None
                                    )
                                    try:
                                        result = await tool.execute(args, context=ctx)
                                    except Exception as e:
                                        result = f"Execution Error: {str(e)}"
                                else:
                                    result = f"Error: Tool '{name}' not found."

                                tool_calls_buffer.append(
                                    {
                                        "tool_call": {
                                            "id": call_id,
                                            "type": "function",
                                            "function": {
                                                "name": name,
                                                "arguments": history_safe_args,
                                            },
                                        },
                                        "result": str(result),
                                    }
                                )

                                await _request_flush()
                                await emit(
                                    ToolOutputEvent(id=call_id, result=str(result))
                                )

                            except json.JSONDecodeError:
                                err_msg = (
                                    "Error: The tool arguments generated were not valid JSON. "
                                    "Please try again with a simpler request."
                                )

                                history_safe_args = "{}"

                                tool_calls_buffer.append(
                                    {
                                        "tool_call": {
                                            "id": call_id,
                                            "type": "function",
                                            "function": {
                                                "name": name,
                                                "arguments": history_safe_args,
                                            },
                                        },
                                        "result": err_msg,
                                    }
                                )
                                await _request_flush()
                                await emit(
                                    ToolOutputEvent(id=call_id, result=err_msg)
                                )
                                continue

                            except Exception as e:
                                err_msg = f"Error: {str(e)}"
                                tool_calls_buffer.append(
                                    {
                                        "tool_call": {
                                            "id": call_id,
                                            "type": "function",
                                            "function": {
                                                "name": name,
                                                "arguments": history_safe_args,
                                            },
                                        },
                                        "result": err_msg,
                                    }
                                )
                                await _request_flush()
                                await emit(
                                    ToolOutputEvent(id=call_id, result=err_msg)
                                )

                        elif event["type"] == "error":
                            await _request_flush()
                            await emit(
                                ErrorEvent(
                                    error=event.get(
                                        "error", "LLM stream error"
                                    )
                                )
                            )
                            stream_error = True
                            break

                    if stream_error:
                        await _flush_think_buffer()
                        await _request_flush()
                        break

                    if has_tool_call:
                        self.context.add_tool_calls(
                            [t["tool_call"] for t in tool_calls_buffer]
                        )
                        for item in tool_calls_buffer:
                            self.context.add_tool_result(
                                item["tool_call"]["id"], item["result"]
                            )
                        payload = self.build_context_usage_event_payload(full_system_prompt)
                        await emit(ContextUsageEvent(**payload))
                        continue

                    if full_text_response:
                        clean_response = _strip_think_tags(full_text_response)
                        if clean_response:
                            self.context.add_assistant_message(clean_response)
                        payload = self.build_context_usage_event_payload(full_system_prompt)
                        await emit(ContextUsageEvent(**payload))

                    await _flush_think_buffer()
                    await _request_flush()
                    await _stop_typing()
                    await emit(DoneEvent())
                    break

            except asyncio.CancelledError:
                await _stop_typing()
                await emit(DoneEvent())
                raise

            except Exception as e:
                await _stop_typing()
                await emit(ErrorEvent(error=str(e)))
                await emit(DoneEvent())

            finally:
                await _stop_typing()
                await event_queue.put(None)

        task = asyncio.create_task(_run_agent())
        try:
            while True:
                event = await event_queue.get()
                if event is None:
                    break
                yield event
                if isinstance(event, DoneEvent):
                    break
        finally:
            if not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
