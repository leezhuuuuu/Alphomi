from __future__ import annotations

import asyncio
import json
import math
import os
import uuid
from typing import Any, Callable, Dict, List, Optional

MAX_CONTEXT_TOKENS = int(os.getenv("MAX_CONTEXT_TOKENS", "200000"))


def _parse_threshold_ratio(raw_value: str | None, fallback: float = 0.8) -> float:
    if raw_value is None or raw_value == "":
        return fallback

    try:
        parsed = float(raw_value)
    except (TypeError, ValueError):
        return fallback

    # Support both 0.8 and 80-style configuration values.
    if parsed > 1:
        parsed = parsed / 100.0

    if parsed <= 0:
        return fallback
    if parsed >= 1:
        return 1.0
    return parsed


CONTEXT_COMPRESSION_THRESHOLD_RATIO = _parse_threshold_ratio(
    os.getenv("CONTEXT_COMPRESSION_THRESHOLD_RATIO"),
    fallback=0.8,
)
CONTEXT_COMPRESSION_THRESHOLD = int(MAX_CONTEXT_TOKENS * CONTEXT_COMPRESSION_THRESHOLD_RATIO)


def _estimate_text_tokens(text: str) -> int:
    if not text:
        return 0
    ascii_chars = sum(1 for c in text if ord(c) < 128)
    non_ascii = len(text) - ascii_chars
    return non_ascii + max(1, math.ceil(ascii_chars / 4))


def _estimate_message_tokens(msg: Dict[str, Any]) -> int:
    tokens = 0
    content = msg.get("content")
    if content:
        tokens += _estimate_text_tokens(str(content))
    tool_calls = msg.get("tool_calls")
    if tool_calls:
        tokens += _estimate_text_tokens(json.dumps(tool_calls, ensure_ascii=False))
    return tokens


def estimate_context_tokens(system_prompt: str, chat_history: List[Dict[str, Any]]) -> int:
    total = _estimate_text_tokens(system_prompt)
    for msg in chat_history:
        total += _estimate_message_tokens(msg)
    return total


def build_context_usage_payload(system_prompt: str, chat_history: List[Dict[str, Any]]) -> Dict[str, Any]:
    used_tokens = estimate_context_tokens(system_prompt, chat_history)
    percent = min(used_tokens / MAX_CONTEXT_TOKENS, 1.0) if MAX_CONTEXT_TOKENS else 0.0
    status = "ok"
    if used_tokens >= CONTEXT_COMPRESSION_THRESHOLD:
        status = "warning"
    if MAX_CONTEXT_TOKENS and used_tokens >= MAX_CONTEXT_TOKENS:
        status = "critical"
    return {
        "usedTokens": used_tokens,
        "maxTokens": MAX_CONTEXT_TOKENS,
        "thresholdTokens": CONTEXT_COMPRESSION_THRESHOLD,
        "percent": percent,
        "status": status,
    }


class AgentContext:
    def __init__(self, session_id: Optional[str] = None):
        self.session_id = session_id
        self.chat_session_id: Optional[str] = None
        self.history: List[Dict[str, Any]] = []
        self._approval_futures: Dict[str, asyncio.Future] = {}
        self.system_context: Optional[str] = None
        self._history_change_callback: Optional[Callable[[List[Dict[str, Any]]], None]] = None

    async def ensure_system_context(self) -> str:
        if self.system_context:
            return self.system_context
        from ..utils.system_context import get_system_context_summary
        self.system_context = await get_system_context_summary()
        return self.system_context

    def set_session_id(self, session_id: Optional[str]) -> None:
        self.session_id = session_id

    def set_chat_session_id(self, chat_session_id: Optional[str]) -> None:
        self.chat_session_id = chat_session_id

    def set_history_change_callback(
        self, callback: Optional[Callable[[List[Dict[str, Any]]], None]]
    ) -> None:
        self._history_change_callback = callback

    def set_history(self, messages: List[Dict[str, Any]]) -> None:
        self.history = list(messages)
        self._notify_history_change()

    def _notify_history_change(self) -> None:
        if self._history_change_callback:
            self._history_change_callback(self.history)

    def add_message(self, message: Dict[str, Any]) -> None:
        self.history.append(message)
        self._notify_history_change()

    def add_user_message(self, content: str, client_message_id: str) -> None:
        self.history.append(
            {"role": "user", "content": content, "client_message_id": client_message_id}
        )
        self._notify_history_change()

    def add_assistant_message(self, content: str) -> None:
        self.history.append({"role": "assistant", "content": content})
        self._notify_history_change()

    def add_tool_calls(self, tool_calls: List[Dict[str, Any]]) -> None:
        self.history.append({"role": "assistant", "tool_calls": tool_calls})
        self._notify_history_change()

    def add_tool_result(self, tool_call_id: str, content: str) -> None:
        self.history.append(
            {"role": "tool", "tool_call_id": tool_call_id, "content": content}
        )
        self._notify_history_change()

    def create_approval(self) -> tuple[str, asyncio.Future]:
        approval_id = str(uuid.uuid4())
        future = asyncio.get_running_loop().create_future()
        self._approval_futures[approval_id] = future
        return approval_id, future

    async def wait_for_approval(self, approval_id: str, timeout: float = 300.0) -> str:
        future = self._approval_futures.get(approval_id)
        if not future:
            return "rejected"
        try:
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            return "rejected"
        finally:
            self._approval_futures.pop(approval_id, None)

    def resolve_approval(self, approval_id: str, decision: str) -> None:
        future = self._approval_futures.get(approval_id)
        if future and not future.done():
            future.set_result(decision)

    def retry_from(self, user_message_id: str) -> bool:
        target_index = None
        for i in range(len(self.history) - 1, -1, -1):
            msg = self.history[i]
            if msg.get("role") == "user" and msg.get("client_message_id") == user_message_id:
                target_index = i
                break
        if target_index is None:
            return False
        del self.history[target_index + 1 :]
        self._notify_history_change()
        return True

    def rewrite_from(self, user_message_id: str, new_content: str) -> bool:
        target_index = None
        for i in range(len(self.history) - 1, -1, -1):
            msg = self.history[i]
            if msg.get("role") == "user" and msg.get("client_message_id") == user_message_id:
                target_index = i
                break
        if target_index is None:
            return False
        del self.history[target_index:]
        self.history.append(
            {"role": "user", "content": new_content, "client_message_id": user_message_id}
        )
        self._notify_history_change()
        return True
