from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional

import httpx

from .discovery import discover_driver_url
from .llm_client import CustomLLMClient
from .teaching_store import DEFAULT_ASSET_TITLE, teaching_store


TeachingEventSink = Callable[[Dict[str, Any]], Awaitable[None]]

INLINE_SNAPSHOT_THRESHOLD = int(os.getenv("TEACHING_INLINE_SNAPSHOT_THRESHOLD", "1200"))
MAX_AGENT_TOOL_ROUNDS = int(os.getenv("TEACHING_AGENT_MAX_TOOL_ROUNDS", "6"))


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def _truncate(value: Any, limit: int = 180) -> str:
    text = _clean_text(value)
    if len(text) <= limit:
        return text
    return f"{text[: max(0, limit - 1)].rstrip()}..."


def _dedupe_keep_order(items: List[str], limit: int = 5) -> List[str]:
    seen = set()
    result: List[str] = []
    for item in items:
        clean = _clean_text(item)
        if not clean or clean in seen:
            continue
        seen.add(clean)
        result.append(clean)
        if len(result) >= limit:
            break
    return result


def _looks_like_transition(note: str) -> bool:
    lowered = _clean_text(note).lower()
    if not lowered:
        return False
    markers = ("接下来", "然后", "这里是", "开始", "下一步", "now", "next")
    return any(marker in lowered for marker in markers)


def _strip_think_blocks(content: Any) -> str:
    text = str(content or "")
    cleaned = re.sub(r"<think>.*?</think>\s*", "", text, flags=re.IGNORECASE | re.DOTALL)
    return _clean_text(cleaned)


class TeachingInvestigatorAgent:
    def __init__(self) -> None:
        self.llm_client = CustomLLMClient()

    async def enrich_action_item(
        self,
        teaching_session_id: str,
        action_item: Dict[str, Any],
    ) -> Dict[str, Any]:
        driver_session_id = _clean_text(
            (teaching_store.get_session(teaching_session_id) or {}).get("driver_session_id")
        )
        if not driver_session_id:
            return action_item

        snapshot_payload = await self._capture_snapshot(driver_session_id)
        if not snapshot_payload:
            return action_item

        snapshot_text = _clean_text(snapshot_payload.get("snapshot"))
        change_summary = self._summarize_snapshot(snapshot_text)
        artifact = None
        if len(snapshot_text) > INLINE_SNAPSHOT_THRESHOLD:
            summary = change_summary or "页面快照变化已存档"
            artifact = teaching_store.write_artifact(
                teaching_session_id,
                related_item_id=action_item["id"],
                summary=summary,
                content=snapshot_text,
            )
        updated = teaching_store.update_action_change(
            teaching_session_id,
            action_item["id"],
            change_summary=change_summary,
            artifact=artifact,
        )
        return updated or action_item

    async def generate_initial_draft(
        self, teaching_session_id: str, emit: TeachingEventSink
    ) -> Dict[str, Any]:
        await self._begin_processing(teaching_session_id, "initial_draft", emit)

        result = await self._run_agent_task(
            teaching_session_id,
            task_type="initial_draft",
            user_request="请根据当前教学数据生成第一版流程草稿。",
            emit=emit,
        )

        return result

    async def revise_draft(
        self,
        teaching_session_id: str,
        user_request: str,
        emit: TeachingEventSink,
    ) -> Dict[str, Any]:
        await self._begin_processing(teaching_session_id, "revise_draft", emit)
        return await self._run_agent_task(
            teaching_session_id,
            task_type="revise_draft",
            user_request=user_request,
            emit=emit,
        )

    async def explain_draft(
        self,
        teaching_session_id: str,
        user_request: str,
        emit: TeachingEventSink,
    ) -> Dict[str, Any]:
        return await self._run_agent_task(
            teaching_session_id,
            task_type="explain_draft",
            user_request=user_request,
            emit=emit,
        )

    async def save_asset(
        self,
        teaching_session_id: str,
        *,
        title: str,
        emit: TeachingEventSink,
    ) -> Dict[str, Any]:
        current_draft = teaching_store.get_current_draft(teaching_session_id)
        if not current_draft:
            message = "当前还没有可保存的流程草稿。"
            await emit({"type": "teaching_agent_message", "content": message})
            return {"ok": False, "message": message}
        clean_title = _clean_text(title) or current_draft.get("title") or DEFAULT_ASSET_TITLE
        asset = teaching_store.save_asset(
            teaching_session_id=teaching_session_id,
            draft_id=current_draft["id"],
            title=clean_title,
        )
        if not asset:
            message = "流程保存失败，请稍后重试。"
            await emit({"type": "teaching_agent_message", "content": message})
            return {"ok": False, "message": message}
        await emit(
            {
                "type": "teaching_asset_saved",
                "asset": {
                    "assetId": asset["id"],
                    "title": asset["title"],
                    "status": asset.get("status", "saved"),
                },
            }
        )
        return {"ok": True, "asset": asset}

    async def locate_card_evidence(
        self,
        teaching_session_id: str,
        *,
        draft_id: str,
        card_id: str,
        emit: TeachingEventSink,
    ) -> Dict[str, Any]:
        located = teaching_store.locate_card_evidence(teaching_session_id, draft_id, card_id)
        await emit({"type": "teaching_card_evidence", "payload": located})
        return located

    def build_auto_title(self, teaching_session_id: str) -> str:
        session = teaching_store.get_session(teaching_session_id) or {}
        draft = teaching_store.get_current_draft(teaching_session_id) or {}
        if _clean_text(draft.get("title")):
            return _clean_text(draft.get("title"))
        tab = session.get("tab_context") or {}
        return _truncate(tab.get("title") or tab.get("url") or DEFAULT_ASSET_TITLE, 48)

    async def _run_agent_task(
        self,
        teaching_session_id: str,
        *,
        task_type: str,
        user_request: str,
        emit: TeachingEventSink,
    ) -> Dict[str, Any]:
        teaching_store.append_agent_message(teaching_session_id, "user", user_request)
        tools = self._tool_schemas()
        history = teaching_store.get_agent_history(teaching_session_id)
        local_messages: List[Dict[str, Any]] = [
            {"role": "system", "content": self._system_prompt()},
            *[
                {"role": item.get("role") or "assistant", "content": item.get("content") or ""}
                for item in history
            ],
            {
                "role": "user",
                "content": self._task_prompt(
                    teaching_session_id=teaching_session_id,
                    task_type=task_type,
                    user_request=user_request,
                ),
            },
        ]

        outcome = await self._run_llm_tool_loop(
            teaching_session_id=teaching_session_id,
            task_type=task_type,
            local_messages=local_messages,
            tools=tools,
            emit=emit,
        )

        if outcome.get("draft") or outcome.get("asset") or outcome.get("message"):
            return outcome

        if task_type == "initial_draft":
            fallback_draft = self._heuristic_generate_cards(teaching_session_id)
            if fallback_draft:
                draft = self._tool_generate_process_cards(
                    teaching_session_id,
                    {
                        "mode": "create",
                        "titleSuggestion": fallback_draft["titleSuggestion"],
                        "cards": fallback_draft["cards"],
                    },
                )
                if draft:
                    await emit(
                        {
                            "type": "teaching_draft_updated",
                            "draft": self._serialize_draft(draft),
                        }
                    )
                    await emit(self._processing_step_payload("segment", "识别阶段边界", "done"))
                    await emit(self._processing_step_payload("goal", "提炼每阶段目标", "done"))
                    await emit(self._processing_step_payload("cards", "生成流程卡片", "done"))
                    return {"draft": draft}

        fallback_message = "我已经整理出初步材料，但当前还无法稳定生成流程卡片。你可以继续补充说明，我会接着整理。"
        teaching_store.append_agent_message(teaching_session_id, "assistant", fallback_message)
        await emit({"type": "teaching_agent_message", "content": fallback_message})
        return {"message": fallback_message}

    async def _run_llm_tool_loop(
        self,
        *,
        teaching_session_id: str,
        task_type: str,
        local_messages: List[Dict[str, Any]],
        tools: List[Dict[str, Any]],
        emit: TeachingEventSink,
    ) -> Dict[str, Any]:
        outcome: Dict[str, Any] = {}
        for _ in range(MAX_AGENT_TOOL_ROUNDS):
            response = await self.llm_client.chat_completion(local_messages, tools)
            choices = response.get("choices") or []
            if not choices:
                return outcome

            message = choices[0].get("message") or {}
            tool_calls = message.get("tool_calls") or []
            content = _strip_think_blocks(message.get("content"))

            if tool_calls:
                local_messages.append(
                    {
                        "role": "assistant",
                        "content": message.get("content"),
                        "tool_calls": tool_calls,
                    }
                )
                for tool_call in tool_calls:
                    fn = tool_call.get("function") or {}
                    name = _clean_text(fn.get("name"))
                    args_text = fn.get("arguments")
                    try:
                        args = json.loads(args_text) if isinstance(args_text, str) and args_text.strip() else {}
                    except Exception:
                        args = {}
                    tool_result = await self._execute_tool(
                        teaching_session_id=teaching_session_id,
                        task_type=task_type,
                        name=name,
                        args=args,
                        emit=emit,
                    )
                    if name == "generate_process_cards" and tool_result.get("draftId"):
                        current_draft = teaching_store.get_current_draft(teaching_session_id)
                        if current_draft:
                            outcome["draft"] = current_draft
                    if name == "save_process_asset" and tool_result.get("assetId"):
                        outcome["asset"] = tool_result
                    local_messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tool_call.get("id") or str(uuid.uuid4()),
                            "content": json.dumps(tool_result, ensure_ascii=False),
                        }
                    )
                continue

            if content:
                teaching_store.append_agent_message(teaching_session_id, "assistant", content)
                await emit({"type": "teaching_agent_message", "content": content})
                outcome["message"] = content
                return outcome
            break
        return outcome

    async def _execute_tool(
        self,
        *,
        teaching_session_id: str,
        task_type: str,
        name: str,
        args: Dict[str, Any],
        emit: TeachingEventSink,
    ) -> Dict[str, Any]:
        if name == "get_teaching_case_overview":
            await emit(
                self._processing_log_payload(
                    "segment",
                    "正在读取教学总览",
                    "先查看轻量总览，再决定是否继续读取更重的证据。",
                )
            )
            return teaching_store.get_overview(teaching_session_id) or {}
        if name == "read_teaching_timeline":
            result = teaching_store.read_timeline(
                teaching_session_id,
                mode=_clean_text(args.get("mode")) or "range",
                start_item_id=_clean_text(args.get("startItemId")) or None,
                end_item_id=_clean_text(args.get("endItemId")) or None,
                item_ids=args.get("itemIds") if isinstance(args.get("itemIds"), list) else None,
                max_items=int(args.get("maxItems") or 0) or None,
            )
            item_count = len((result or {}).get("items") or [])
            await emit(
                self._processing_log_payload(
                    "segment",
                    "正在核对教学记录片段",
                    f"本次读取了 {item_count} 条记录，用于确认阶段边界和目标。",
                )
            )
            return result or {}
        if name == "read_teaching_artifact":
            artifact_id = _clean_text(args.get("artifactId"))
            mode = _clean_text(args.get("mode")) or "summary"
            artifact = teaching_store.get_artifact(teaching_session_id, artifact_id)
            if not artifact:
                return {"artifactId": artifact_id, "mode": mode, "summary": ""}
            content = ""
            if mode == "full" and _clean_text(artifact.get("path")):
                try:
                    content = Path(str(artifact.get("path"))).read_text(encoding="utf-8")
                except Exception:
                    content = ""
            await emit(
                self._processing_log_payload(
                    "goal",
                    "正在读取页面变化文件",
                    _truncate(artifact.get("summary") or "正在补充页面变化证据。", 120),
                )
            )
            return {
                "artifactId": artifact.get("id"),
                "mode": "full" if content else "summary",
                "summary": artifact.get("summary"),
                **({"content": content} if content else {}),
            }
        if name == "generate_process_cards":
            if task_type in {"initial_draft", "revise_draft"}:
                await emit(self._processing_step_payload("segment", "识别阶段边界", "done"))
                await emit(self._processing_step_payload("goal", "提炼每阶段目标", "done"))
                await emit(self._processing_step_payload("cards", "生成流程卡片", "running"))
                await emit(
                    self._processing_log_payload(
                        "cards",
                        "正在生成流程卡片",
                        "正在把调查结果整理成可审阅的阶段卡片。",
                    )
                )
            draft = self._tool_generate_process_cards(teaching_session_id, args)
            if draft:
                if task_type in {"initial_draft", "revise_draft"}:
                    await emit(
                        self._processing_finding_payload(
                            "cards",
                            f"已生成 {len(draft.get('cards') or [])} 个阶段卡片",
                            "第一版流程草稿已经准备好，正在切换到审阅视图。",
                        )
                    )
                    await emit(self._processing_step_payload("cards", "生成流程卡片", "done"))
                await emit({"type": "teaching_draft_updated", "draft": self._serialize_draft(draft)})
                return {
                    "draftId": draft.get("id"),
                    "version": draft.get("version"),
                    "title": draft.get("title"),
                    "cardCount": len(draft.get("cards") or []),
                }
            return {"draftId": "", "version": 0, "title": "", "cardCount": 0}
        if name == "locate_card_evidence":
            draft_id = _clean_text(args.get("draftId"))
            card_id = _clean_text(args.get("cardId"))
            return teaching_store.locate_card_evidence(teaching_session_id, draft_id, card_id)
        if name == "save_process_asset":
            draft_id = _clean_text(args.get("draftId"))
            title = _clean_text(args.get("title")) or DEFAULT_ASSET_TITLE
            asset = teaching_store.save_asset(
                teaching_session_id=teaching_session_id,
                draft_id=draft_id,
                title=title,
            )
            if asset:
                await emit(
                    {
                        "type": "teaching_asset_saved",
                        "asset": {
                            "assetId": asset["id"],
                            "title": asset["title"],
                            "status": asset.get("status", "saved"),
                        },
                    }
                )
            return {
                "assetId": asset.get("id") if asset else "",
                "title": asset.get("title") if asset else title,
                "status": asset.get("status", "saved") if asset else "error",
            }
        return {"error": f"Unsupported tool: {name}"}

    def _tool_generate_process_cards(
        self, teaching_session_id: str, args: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        raw_cards = args.get("cards") if isinstance(args.get("cards"), list) else []
        session = teaching_store.get_session(teaching_session_id) or {}
        timeline_items = session.get("timeline") or []
        timeline_ids = {
            _clean_text(item.get("id"))
            for item in timeline_items
            if _clean_text(item.get("id"))
        }
        artifact_ids = {
            _clean_text(artifact.get("id"))
            for artifact in (session.get("artifacts") or [])
            if _clean_text(artifact.get("id"))
        }
        normalized_cards = []
        for card in raw_cards:
            if not isinstance(card, dict):
                continue
            title = _clean_text(card.get("title"))
            goal = _clean_text(card.get("goal"))
            key_actions = _dedupe_keep_order(
                card.get("keyActions") if isinstance(card.get("keyActions"), list) else [],
                limit=6,
            )
            evidence_refs = []
            for ref in card.get("evidenceRefs") or []:
                if not isinstance(ref, dict):
                    continue
                evidence_type = _clean_text(ref.get("type"))
                if evidence_type not in {"timeline_item", "timeline_range", "artifact"}:
                    continue
                item_id = _clean_text(ref.get("itemId"))
                start_item_id = _clean_text(ref.get("startItemId"))
                end_item_id = _clean_text(ref.get("endItemId"))
                artifact_id = _clean_text(ref.get("artifactId"))
                if evidence_type == "timeline_item" and item_id not in timeline_ids:
                    continue
                if evidence_type == "timeline_range" and start_item_id not in timeline_ids:
                    continue
                if evidence_type == "timeline_range" and end_item_id and end_item_id not in timeline_ids:
                    end_item_id = ""
                if evidence_type == "artifact" and artifact_id not in artifact_ids:
                    continue
                evidence_refs.append(
                    {
                        "type": evidence_type,
                        "item_id": item_id,
                        "start_item_id": start_item_id,
                        "end_item_id": end_item_id,
                        "artifact_id": artifact_id,
                    }
                )
            if not title or not goal or not key_actions:
                continue
            if not evidence_refs:
                evidence_refs = self._infer_evidence_refs(
                    timeline_items=timeline_items,
                    key_actions=key_actions,
                )
            normalized_cards.append(
                {
                    "title": title,
                    "goal": goal,
                    "keyActions": key_actions,
                    "evidenceRefs": evidence_refs,
                }
            )
        if not normalized_cards:
            return None
        mode = "replace" if _clean_text(args.get("mode")) == "replace" else "create"
        title = _clean_text(args.get("titleSuggestion")) or DEFAULT_ASSET_TITLE
        return teaching_store.set_draft(
            teaching_session_id,
            title=title,
            cards=normalized_cards,
            mode=mode,
        )

    def _infer_evidence_refs(
        self,
        *,
        timeline_items: List[Dict[str, Any]],
        key_actions: List[str],
    ) -> List[Dict[str, str]]:
        matched_item_ids: List[str] = []
        normalized_key_actions = [_clean_text(action).lower() for action in key_actions if _clean_text(action)]
        for item in timeline_items:
            if item.get("kind") != "action":
                continue
            item_id = _clean_text(item.get("id"))
            summary = _clean_text(item.get("summary")).lower()
            if not item_id or not summary:
                continue
            if any(
                key_action and (key_action in summary or summary in key_action)
                for key_action in normalized_key_actions
            ):
                if item_id not in matched_item_ids:
                    matched_item_ids.append(item_id)

        if len(matched_item_ids) == 1:
            return [{"type": "timeline_item", "item_id": matched_item_ids[0]}]
        if len(matched_item_ids) > 1:
            return [
                {
                    "type": "timeline_range",
                    "start_item_id": matched_item_ids[0],
                    "end_item_id": matched_item_ids[-1],
                }
            ]

        if timeline_items:
            return [
                {
                    "type": "timeline_range",
                    "start_item_id": _clean_text(timeline_items[0].get("id")),
                    "end_item_id": _clean_text(timeline_items[-1].get("id")),
                }
            ]
        return []

    async def _capture_snapshot(self, driver_session_id: str) -> Dict[str, Any]:
        driver_url = await discover_driver_url()
        request_url = f"{driver_url}/sessions/{driver_session_id}/tools/browser_snapshot"
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                response = await client.post(
                    request_url,
                    json={"full": False, "forceFullSnapshot": False},
                )
            data = response.json()
            if response.status_code != 200 or not data.get("success"):
                return {}
            payload = data.get("data")
            return payload if isinstance(payload, dict) else {}
        except Exception:
            return {}

    def _summarize_snapshot(self, snapshot: str) -> str:
        if not snapshot:
            return "页面变化摘要不可用"
        if "# Snapshot Unchanged" in snapshot:
            return "页面快照未发生明显变化"
        if "# Snapshot Delta" in snapshot:
            match = re.search(r"changes=\+(\d+)\s+\-(\d+)", snapshot)
            if match:
                return f"页面快照发生变化（+{match.group(1)} / -{match.group(2)}）"
            return "页面快照发生变化"
        return "已捕获当前页面快照"

    def _heuristic_generate_cards(self, teaching_session_id: str) -> Optional[Dict[str, Any]]:
        session = teaching_store.get_session(teaching_session_id) or {}
        timeline = session.get("timeline") or []
        if not timeline:
            return None

        groups: List[List[Dict[str, Any]]] = []
        current: List[Dict[str, Any]] = []
        last_action_type = ""

        for item in timeline:
            if not current:
                current = [item]
                last_action_type = _clean_text(item.get("actionType") or item.get("action_type"))
                continue

            should_split = False
            if item.get("kind") == "action":
                action_type = _clean_text(item.get("actionType") or item.get("action_type"))
                if action_type == "navigate" and any(entry.get("kind") == "action" for entry in current):
                    should_split = True
                elif action_type in {"submit", "result"} and last_action_type in {"input", "select", "submit"}:
                    should_split = True
                last_action_type = action_type
            elif item.get("kind") == "note" and _looks_like_transition(item.get("text")) and len(current) >= 3:
                should_split = True

            if should_split:
                groups.append(current)
                current = [item]
            else:
                current.append(item)

        if current:
            groups.append(current)

        cards: List[Dict[str, Any]] = []
        for idx, group in enumerate(groups, start=1):
            first_action = next((item for item in group if item.get("kind") == "action"), None)
            notes = [
                _clean_text(item.get("text"))
                for item in group
                if item.get("kind") == "note" and _clean_text(item.get("text"))
            ]
            key_actions = _dedupe_keep_order(
                [
                    _clean_text(item.get("summary"))
                    for item in group
                    if item.get("kind") == "action"
                ],
                limit=5,
            )
            if not first_action or not key_actions:
                continue
            action_type = _clean_text(first_action.get("actionType") or first_action.get("action_type"))
            default_goal = {
                "navigate": "进入目标页面并确认当前环境",
                "click": "执行关键页面操作",
                "input": "填写当前阶段所需信息",
                "select": "选择当前阶段所需选项",
                "submit": "提交当前阶段的数据或操作",
                "result": "查看并确认当前阶段结果",
            }.get(action_type, "完成这一阶段的关键操作")
            title = _truncate(first_action.get("summary") or f"阶段 {idx}", 40)
            cards.append(
                {
                    "title": title,
                    "goal": notes[0] if notes else default_goal,
                    "keyActions": key_actions,
                    "evidenceRefs": [
                        {
                            "type": "timeline_range",
                            "startItemId": group[0].get("id"),
                            "endItemId": group[-1].get("id"),
                        }
                    ],
                }
            )

        if not cards:
            return None
        tab = session.get("tab_context") or {}
        title_suggestion = _truncate(tab.get("title") or tab.get("url") or DEFAULT_ASSET_TITLE, 48)
        return {"titleSuggestion": title_suggestion, "cards": cards}

    def _serialize_draft(self, draft: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "draftId": draft.get("id"),
            "version": draft.get("version"),
            "title": draft.get("title"),
            "cards": [
                {
                    "cardId": card.get("id"),
                    "title": card.get("title"),
                    "goal": card.get("goal"),
                    "keyActions": card.get("keyActions") or card.get("key_actions") or [],
                    "evidenceRefs": card.get("evidenceRefs") or card.get("evidence_refs") or [],
                }
                for card in draft.get("cards") or []
            ],
        }

    def _processing_step_payload(self, step_id: str, label: str, status: str) -> Dict[str, Any]:
        return {
            "type": "teaching_processing_step",
            "step": {"id": step_id, "label": label, "status": status},
        }

    def _processing_started_payload(
        self,
        teaching_session_id: str,
        task_type: str,
    ) -> Dict[str, Any]:
        overview = teaching_store.get_overview(teaching_session_id) or {}
        stats = overview.get("timelineStats") or {}
        return {
            "type": "teaching_processing_started",
            "taskType": task_type,
            "stats": {
                "totalItems": int(stats.get("totalItems") or 0),
                "actionItems": int(stats.get("actionItems") or 0),
                "noteItems": int(stats.get("noteItems") or 0),
                "artifactCount": int(stats.get("artifactCount") or 0),
            },
            "createdAt": _now_iso(),
        }

    def _processing_log_payload(
        self,
        step_id: str,
        label: str,
        detail: str,
    ) -> Dict[str, Any]:
        return {
            "type": "teaching_processing_log",
            "stepId": step_id,
            "label": label,
            "detail": detail,
            "createdAt": _now_iso(),
        }

    def _processing_finding_payload(
        self,
        step_id: str,
        title: str,
        summary: str,
    ) -> Dict[str, Any]:
        return {
            "type": "teaching_processing_finding",
            "stepId": step_id,
            "title": title,
            "summary": summary,
            "createdAt": _now_iso(),
        }

    async def _begin_processing(
        self,
        teaching_session_id: str,
        task_type: str,
        emit: TeachingEventSink,
    ) -> None:
        await emit(self._processing_started_payload(teaching_session_id, task_type))
        await emit(self._processing_step_payload("digest", "整理教学记录", "running"))
        await emit(self._processing_step_payload("segment", "识别阶段边界", "pending"))
        await emit(self._processing_step_payload("goal", "提炼每阶段目标", "pending"))
        await emit(self._processing_step_payload("cards", "生成流程卡片", "pending"))
        await emit(
            self._processing_log_payload(
                "digest",
                "正在整理教学记录",
                "正在压缩低价值操作，保留关键动作、备注和页面变化摘要。",
            )
        )
        if task_type == "revise_draft":
            await emit(
                self._processing_log_payload(
                    "digest",
                    "正在应用最新修订要求",
                    "将结合用户最新要求重新核对现有草稿和教学证据。",
                )
            )
        await emit(self._processing_step_payload("digest", "整理教学记录", "done"))
        await emit(self._processing_step_payload("segment", "识别阶段边界", "running"))
        await emit(
            self._processing_log_payload(
                "segment",
                "正在识别阶段边界",
                "分析哪些操作和备注应该归属于同一个教学阶段。",
            )
        )

    def _tool_schemas(self) -> List[Dict[str, Any]]:
        return [
            {
                "type": "function",
                "function": {
                    "name": "get_teaching_case_overview",
                    "description": "Read a low-token overview of the current teaching case before deciding what to inspect next.",
                    "parameters": {"type": "object", "properties": {}},
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "read_teaching_timeline",
                    "description": "Read a focused section of teaching timeline items when overview is not enough.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "mode": {"type": "string", "enum": ["range", "items"]},
                            "startItemId": {"type": "string"},
                            "endItemId": {"type": "string"},
                            "itemIds": {"type": "array", "items": {"type": "string"}},
                            "maxItems": {"type": "integer"},
                        },
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "read_teaching_artifact",
                    "description": "Read a teaching artifact summary by default, or full content only when necessary.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "artifactId": {"type": "string"},
                            "mode": {"type": "string", "enum": ["summary", "full"]},
                        },
                        "required": ["artifactId"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "generate_process_cards",
                    "description": "Create or replace the current teaching process draft used by the UI review screen.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "mode": {"type": "string", "enum": ["create", "replace"]},
                            "titleSuggestion": {"type": "string"},
                            "cards": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "title": {"type": "string"},
                                        "goal": {"type": "string"},
                                        "keyActions": {
                                            "type": "array",
                                            "items": {"type": "string"},
                                        },
                                        "evidenceRefs": {
                                            "type": "array",
                                            "items": {
                                                "type": "object",
                                                "properties": {
                                                    "type": {
                                                        "type": "string",
                                                        "enum": [
                                                            "timeline_item",
                                                            "timeline_range",
                                                            "artifact",
                                                        ],
                                                    },
                                                    "itemId": {"type": "string"},
                                                    "startItemId": {"type": "string"},
                                                    "endItemId": {"type": "string"},
                                                    "artifactId": {"type": "string"},
                                                },
                                            },
                                        },
                                    },
                                    "required": ["title", "goal", "keyActions"],
                                },
                            },
                        },
                        "required": ["mode", "titleSuggestion", "cards"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "locate_card_evidence",
                    "description": "Locate timeline anchors and artifacts for a specific review card.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "draftId": {"type": "string"},
                            "cardId": {"type": "string"},
                        },
                        "required": ["draftId", "cardId"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "save_process_asset",
                    "description": "Save the current accepted draft as a reusable private process asset.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "draftId": {"type": "string"},
                            "title": {"type": "string"},
                        },
                        "required": ["draftId", "title"],
                    },
                },
            },
        ]

    def _system_prompt(self) -> str:
        return """You are the Alphomi Teaching Investigator Agent.

You handle one teaching case at a time.
You are not a general chat assistant. You investigate teaching evidence, maintain one living process draft, and help the user refine it until it is ready to save.

Your responsibilities:
1. Investigate teaching evidence.
2. Infer stage boundaries, goals, and key actions.
3. Ask the user directly only when critical ambiguity remains.
4. Use tools to create or replace the process draft shown in the UI.
5. Explain your reasoning with evidence when the user asks.
6. Help save the final private process asset.

Rules:
- Always inspect lightweight overview before reading more evidence.
- Do not read all artifacts by default.
- User notes are higher-confidence than unsupported guesses.
- Never rewrite raw teaching records.
- Final UI cards must be generated through generate_process_cards.
- If evidence is sufficient, act without asking.
- If critical ambiguity remains after targeted investigation, ask one concise question in plain language.
- When revising, operate on the current draft rather than restarting from scratch unless necessary.
"""

    def _task_prompt(
        self,
        *,
        teaching_session_id: str,
        task_type: str,
        user_request: str,
    ) -> str:
        return f"""Current teaching session: {teaching_session_id}
Task type: {task_type}

User request:
{user_request}

Important behavior rules:
- If you can confidently produce or revise the process draft, call generate_process_cards.
- If the user is asking for explanation, explain with evidence instead of modifying the draft.
- If the user is asking to save and the draft is ready, call save_process_asset.
- If you need more evidence, use overview first, then timeline, then artifact.
- If a critical ambiguity remains, ask the user directly in one concise question.
"""


teaching_agent = TeachingInvestigatorAgent()
