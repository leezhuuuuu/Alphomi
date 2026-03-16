from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

import asyncio
import copy
import json
import uuid

from ..core.context import AgentContext, build_context_usage_payload
from ..core.chat_store import chat_store
from ..core.events import ContextUsageEvent
from ..core.guard import guard
from ..core.title_generator import generate_title_from_first_question
from ..utils.logger import save_session_log
from ..tools.dispatch_tool import (
    register_sub_agent_event_sink,
    unregister_sub_agent_event_sink,
)
from ..workflows.factory import create_workflow, get_system_prompt_for_mode

router = APIRouter()

WORK_EVENT_TYPES = {
    "think_chunk",
    "content_chunk",
    "tool_start",
    "tool_input",
    "tool_output",
    "done",
    "error",
    "stopped",
    "sub_agent_event",
}
UNSAVED_WORK_EVENT_TYPES = {"think_chunk", "content_chunk", "sub_agent_event"}


async def safe_send_json(websocket: WebSocket, payload: dict) -> bool:
    try:
        if websocket.client_state != WebSocketState.CONNECTED:
            return False
        await websocket.send_json(payload)
        return True
    except RuntimeError:
        return False


async def send_context_usage(websocket: WebSocket, context: AgentContext, mode: str | None) -> None:
    system_prompt = get_system_prompt_for_mode(mode)
    system_context = await context.ensure_system_context()
    full_system_prompt = f"{system_prompt}\n\n{system_context}"
    payload = build_context_usage_payload(full_system_prompt, context.history)
    await safe_send_json(websocket, ContextUsageEvent(**payload).to_dict())


async def process_workflow(
    websocket: WebSocket,
    context: AgentContext,
    user_input: str,
    mode: str | None,
    turn_id: str | None = None,
    event_recorder=None,
) -> None:
    workflow = create_workflow(mode, context)
    try:
        async for event in workflow.run(user_input):
            payload = event.to_dict()
            if event_recorder and turn_id:
                event_recorder(turn_id, payload)
            await safe_send_json(websocket, payload)
    except Exception as e:
        error_payload = {"type": "error", "error": str(e)}
        done_payload = {"type": "done"}
        if event_recorder and turn_id:
            event_recorder(turn_id, error_payload)
            event_recorder(turn_id, done_payload)
        await safe_send_json(websocket, error_payload)
        await safe_send_json(websocket, done_payload)


def _find_first_user_content(messages: list[dict]) -> str:
    for msg in messages:
        if msg.get("role") == "user":
            return str(msg.get("content", "")).strip()
    return ""


@router.websocket("/ws/chat")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()

    context = AgentContext()
    current_task: asyncio.Task | None = None
    current_mode: str | None = None
    current_turn_id: str | None = None
    sink = None

    def _persist_history(history: list[dict]) -> None:
        if not context.chat_session_id:
            return
        chat_store.set_messages(context.chat_session_id, history)

    context.set_history_change_callback(_persist_history)

    def _record_work_event(turn_id: str | None, payload: dict) -> None:
        if not turn_id or not context.chat_session_id:
            return
        event_type = payload.get("type")
        if not isinstance(event_type, str) or event_type not in WORK_EVENT_TYPES:
            return
        chat_store.append_work_event(
            context.chat_session_id,
            turn_id,
            event_type,
            payload,
            save=event_type not in UNSAVED_WORK_EVENT_TYPES,
        )

    async def _cancel_current_task() -> None:
        nonlocal current_task, current_turn_id
        if current_task and not current_task.done():
            current_task.cancel()
            try:
                await current_task
            except asyncio.CancelledError:
                pass
        current_task = None
        current_turn_id = None

    async def _start_workflow_task(user_input: str, turn_id: str) -> None:
        nonlocal current_task, current_turn_id

        async def _run() -> None:
            nonlocal current_turn_id
            current_turn_id = turn_id
            try:
                await process_workflow(
                    websocket,
                    context,
                    user_input,
                    current_mode,
                    turn_id=turn_id,
                    event_recorder=_record_work_event,
                )
            finally:
                if current_turn_id == turn_id:
                    current_turn_id = None

        current_task = asyncio.create_task(_run())

    async def _send_chat_sessions() -> None:
        await safe_send_json(
            websocket,
            {
                "type": "chat_sessions",
                "sessions": chat_store.list_sessions(),
                "activeChatSessionId": context.chat_session_id,
            },
        )

    async def _send_chat_history() -> None:
        current_session = (
            chat_store.get_session(context.chat_session_id)
            if context.chat_session_id
            else None
        )
        work_summaries = {}
        if current_session and isinstance(current_session.get("work_summaries"), dict):
            work_summaries = current_session.get("work_summaries") or {}
        work_events = {}
        if current_session and isinstance(current_session.get("work_events"), dict):
            work_events = current_session.get("work_events") or {}
        await safe_send_json(
            websocket,
            {
                "type": "chat_history",
                "chatSessionId": context.chat_session_id,
                "mode": current_mode,
                "messages": context.history,
                "workSummaries": work_summaries,
                "workEvents": work_events,
            },
        )

    async def _load_chat_session(chat_session_id: str | None) -> None:
        nonlocal current_mode
        session = chat_store.ensure_session(chat_session_id)
        context.set_chat_session_id(session["id"])
        context.history = copy.deepcopy(session.get("messages") or [])
        current_mode = (
            session.get("mode")
            if isinstance(session.get("mode"), str) and session.get("mode")
            else None
        )
        await _send_chat_sessions()
        await _send_chat_history()
        await send_context_usage(websocket, context, current_mode)

    async def _maybe_generate_title(first_question: str) -> None:
        sid = context.chat_session_id
        if not sid:
            return
        session = chat_store.get_session(sid)
        if not session:
            return
        if session.get("title_source") == "user":
            return
        title = await generate_title_from_first_question(first_question)
        if not title:
            return
        if chat_store.update_title(sid, title, source="ai"):
            await _send_chat_sessions()

    def _emit_sub_agent_event(payload: dict) -> None:
        if not context.session_id:
            return
        if payload.get("session_id") != context.session_id:
            return
        if current_turn_id and context.chat_session_id:
            chat_store.append_work_event(
                context.chat_session_id,
                current_turn_id,
                "sub_agent_event",
                {"type": "sub_agent_event", "data": payload},
                save=False,
            )
        asyncio.create_task(
            safe_send_json(websocket, {"type": "sub_agent_event", "data": payload})
        )

    sink = _emit_sub_agent_event
    register_sub_agent_event_sink(sink)

    try:
        while True:
            raw_data = await websocket.receive_text()
            data = json.loads(raw_data)

            if "sessionId" in data:
                context.set_session_id(data["sessionId"])
                await _load_chat_session(data.get("chatSessionId"))
                continue

            if data.get("type") == "set_security_mode":
                guard.set_mode(data.get("mode"))
                continue

            if data.get("type") == "list_chat_sessions":
                await _send_chat_sessions()
                continue

            if data.get("type") == "create_chat_session":
                await _cancel_current_task()
                created = chat_store.create_session()
                await _load_chat_session(created["id"])
                continue

            if data.get("type") == "switch_chat_session":
                target_id = data.get("chat_session_id")
                if not target_id:
                    continue
                await _cancel_current_task()
                await _load_chat_session(target_id)
                continue

            if data.get("type") == "rename_chat_session":
                target_id = data.get("chat_session_id") or context.chat_session_id
                title = str(data.get("title") or "").strip()
                if target_id and title:
                    if chat_store.update_title(target_id, title, source="user"):
                        await _send_chat_sessions()
                continue

            if data.get("type") == "delete_chat_session":
                target_id = data.get("chat_session_id")
                if not target_id:
                    continue
                await _cancel_current_task()
                deleted = chat_store.delete_session(target_id)
                if deleted:
                    next_session = chat_store.ensure_session()
                    await _load_chat_session(next_session["id"])
                else:
                    await _send_chat_sessions()
                continue

            if data.get("type") == "stop_generation":
                stopped_turn_id = current_turn_id
                if stopped_turn_id and context.chat_session_id:
                    chat_store.append_work_event(
                        context.chat_session_id,
                        stopped_turn_id,
                        "stopped",
                        {"type": "stopped"},
                    )
                await _cancel_current_task()
                if stopped_turn_id and context.chat_session_id:
                    chat_store.append_work_event(
                        context.chat_session_id,
                        stopped_turn_id,
                        "done",
                        {"type": "done"},
                    )
                await safe_send_json(websocket, {"type": "done"})
                continue

            if data.get("type") == "approval_response":
                approval_id = data.get("id")
                decision = data.get("decision")
                if approval_id and decision:
                    context.resolve_approval(approval_id, decision)
                continue

            if data.get("type") == "upsert_work_summary":
                target_id = data.get("chat_session_id") or context.chat_session_id
                turn_id = data.get("turn_id")
                elapsed_sec = data.get("elapsed_sec")
                label = str(data.get("label") or "Completed")
                thought = data.get("thought")
                if (
                    isinstance(target_id, str)
                    and target_id
                    and isinstance(turn_id, str)
                    and turn_id
                ):
                    chat_store.set_work_summary(
                        target_id, turn_id, elapsed_sec or 1, label, thought
                    )
                continue

            if data.get("type") == "retry_from":
                user_message_id = data.get("user_message_id")
                if not user_message_id:
                    continue
                target_chat_id = data.get("chat_session_id")
                if target_chat_id and target_chat_id != context.chat_session_id:
                    await _load_chat_session(target_chat_id)
                await _cancel_current_task()
                if not context.retry_from(user_message_id):
                    continue
                if context.chat_session_id:
                    chat_store.clear_work_for_turn(context.chat_session_id, user_message_id)
                await send_context_usage(websocket, context, current_mode)
                user_input = ""
                for msg in reversed(context.history):
                    if msg.get("role") == "user" and msg.get("client_message_id") == user_message_id:
                        user_input = msg.get("content", "")
                        break
                await _start_workflow_task(user_input, user_message_id)
                continue

            if data.get("type") == "rewrite_from":
                user_message_id = data.get("user_message_id")
                new_content = data.get("new_content")
                if not user_message_id or not new_content:
                    continue
                target_chat_id = data.get("chat_session_id")
                if target_chat_id and target_chat_id != context.chat_session_id:
                    await _load_chat_session(target_chat_id)
                if "mode" in data and isinstance(data.get("mode"), str):
                    current_mode = data.get("mode")
                await _cancel_current_task()
                if not context.rewrite_from(user_message_id, new_content):
                    continue
                if context.chat_session_id:
                    chat_store.clear_work_for_turn(context.chat_session_id, user_message_id)
                if context.chat_session_id:
                    chat_store.set_mode(context.chat_session_id, current_mode)
                    first_user = _find_first_user_content(context.history)
                    if first_user:
                        asyncio.create_task(_maybe_generate_title(first_user))
                    await _send_chat_sessions()
                await send_context_usage(websocket, context, current_mode)
                await _start_workflow_task(new_content, user_message_id)
                continue

            user_input = data.get("message")
            if user_input:
                target_chat_id = data.get("chat_session_id")
                if target_chat_id and target_chat_id != context.chat_session_id:
                    await _load_chat_session(target_chat_id)
                if not context.chat_session_id:
                    await _load_chat_session(None)
                await _cancel_current_task()

                client_message_id = data.get("client_message_id") or str(uuid.uuid4())
                if "mode" in data:
                    current_mode = data.get("mode")

                if context.chat_session_id:
                    chat_store.set_mode(context.chat_session_id, current_mode)
                    chat_store.clear_work_for_turn(context.chat_session_id, client_message_id)
                context.add_user_message(user_input, client_message_id)
                await _send_chat_sessions()

                user_message_count = sum(
                    1 for msg in context.history if msg.get("role") == "user"
                )
                if user_message_count == 1:
                    asyncio.create_task(_maybe_generate_title(user_input))
                await send_context_usage(websocket, context, current_mode)

                await _start_workflow_task(user_input, client_message_id)

    except WebSocketDisconnect:
        await _cancel_current_task()

    except Exception as e:
        print(f"WS error: {e}")

    finally:
        if sink:
            unregister_sub_agent_event_sink(sink)
        save_session_log(context.session_id, context.history)
