from __future__ import annotations

import copy
import datetime as dt
import json
import os
import threading
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional


STORE_VERSION = 1
DEFAULT_STORE_PATH = "logs/teaching_cases.json"
DEFAULT_ARTIFACT_DIR = "logs/teaching_artifacts"
DEFAULT_ASSET_DIR = "logs/teaching_assets"
DEFAULT_ASSET_TITLE = "未命名流程"


def _now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _clean_text(value: Any, fallback: str = "", max_len: Optional[int] = None) -> str:
    text = str(value or fallback).strip()
    if max_len is not None and len(text) > max_len:
        return text[:max_len]
    return text


def _safe_copy(value: Any) -> Any:
    if isinstance(value, (dict, list, str, int, float, bool)) or value is None:
        return copy.deepcopy(value)
    return str(value)


def _ensure_list(value: Any) -> List[Any]:
    return value if isinstance(value, list) else []


def _coerce_iso(value: Any) -> str:
    text = _clean_text(value)
    return text or _now_iso()


class TeachingStore:
    def __init__(
        self,
        store_path: Optional[str] = None,
        artifact_root: Optional[str] = None,
        asset_root: Optional[str] = None,
    ):
        raw_path = (
            store_path
            or os.getenv("TEACHING_STORE_PATH")
            or DEFAULT_STORE_PATH
        )
        raw_artifacts = artifact_root or os.getenv("TEACHING_ARTIFACT_ROOT") or DEFAULT_ARTIFACT_DIR
        raw_assets = asset_root or os.getenv("TEACHING_ASSET_ROOT") or DEFAULT_ASSET_DIR
        self.path = Path(raw_path)
        self.artifact_root = Path(raw_artifacts)
        self.asset_root = Path(raw_assets)
        self.lock = threading.Lock()
        self._data: Dict[str, Any] = {
            "version": STORE_VERSION,
            "sessions": {},
            "drafts": {},
            "assets": {},
        }
        self._load()

    def _load(self) -> None:
        with self.lock:
            if not self.path.exists():
                return
            try:
                parsed = json.loads(self.path.read_text(encoding="utf-8"))
            except Exception:
                return
            if not isinstance(parsed, dict):
                return
            sessions = parsed.get("sessions") if isinstance(parsed.get("sessions"), dict) else {}
            drafts = parsed.get("drafts") if isinstance(parsed.get("drafts"), dict) else {}
            assets = parsed.get("assets") if isinstance(parsed.get("assets"), dict) else {}
            self._data = {
                "version": STORE_VERSION,
                "sessions": {
                    sid: self._normalize_session(item)
                    for sid, item in sessions.items()
                    if isinstance(sid, str) and sid and isinstance(item, dict)
                },
                "drafts": {
                    did: self._normalize_draft(item)
                    for did, item in drafts.items()
                    if isinstance(did, str) and did and isinstance(item, dict)
                },
                "assets": {
                    aid: self._normalize_asset(item)
                    for aid, item in assets.items()
                    if isinstance(aid, str) and aid and isinstance(item, dict)
                },
            }

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(self._data, ensure_ascii=False, indent=2)
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp.write_text(payload, encoding="utf-8")
        tmp.replace(self.path)

    def _normalize_timeline_item(self, raw: Any) -> Optional[Dict[str, Any]]:
        if not isinstance(raw, dict):
            return None
        kind = _clean_text(raw.get("kind"))
        if kind not in {"action", "note", "system"}:
            return None
        item_id = _clean_text(raw.get("id")) or str(uuid.uuid4())
        created_at = _coerce_iso(raw.get("createdAt") or raw.get("created_at"))
        item: Dict[str, Any] = {
            "id": item_id,
            "kind": kind,
            "createdAt": created_at,
            "created_at": created_at,
        }
        if kind == "action":
            action_type = _clean_text(raw.get("actionType") or raw.get("action_type"), "action", 64)
            summary = _clean_text(raw.get("summary") or raw.get("description"), max_len=400) or action_type
            artifact_ids = [
                _clean_text(value)
                for value in _ensure_list(raw.get("artifactIds") or raw.get("artifact_ids"))
                if _clean_text(value)
            ]
            single_artifact_id = _clean_text(raw.get("artifactId") or raw.get("artifact_id"))
            if single_artifact_id and single_artifact_id not in artifact_ids:
                artifact_ids.append(single_artifact_id)
            page_url = _clean_text(
                raw.get("pageUrl") or raw.get("page_url") or raw.get("url"),
                max_len=1000,
            )
            page_title = _clean_text(
                raw.get("pageTitle") or raw.get("page_title") or raw.get("title"),
                max_len=300,
            )
            change_summary = _clean_text(
                raw.get("changeSummary")
                or raw.get("change_summary")
                or raw.get("pageChangeSummary"),
                max_len=500,
            )
            item.update(
                {
                    "actionType": action_type,
                    "action_type": action_type,
                    "summary": summary,
                    "pageUrl": page_url,
                    "pageTitle": page_title,
                    "changeSummary": change_summary,
                    "change_summary": change_summary,
                    "artifactIds": artifact_ids,
                }
            )
            detail = raw.get("detail")
            if detail not in (None, "", {}):
                item["detail"] = _safe_copy(detail)
            change_artifact_path = _clean_text(
                raw.get("changeArtifactPath") or raw.get("change_artifact_path"),
                max_len=4000,
            )
            if not change_artifact_path and isinstance(detail, dict):
                change_artifact_path = _clean_text(
                    detail.get("artifactPath") or detail.get("changeArtifactPath"),
                    max_len=4000,
                )
            if change_artifact_path:
                item["changeArtifactPath"] = change_artifact_path
        elif kind == "note":
            text = _clean_text(raw.get("text") or raw.get("summary"), max_len=2000)
            if not text:
                return None
            item.update({"text": text, "summary": text})
        else:
            summary = _clean_text(raw.get("summary"), max_len=400)
            if not summary:
                return None
            item.update({"summary": summary})
            detail = raw.get("detail")
            if detail not in (None, "", {}):
                item["detail"] = _safe_copy(detail)
        return item

    def _normalize_artifact(self, raw: Any) -> Optional[Dict[str, Any]]:
        if not isinstance(raw, dict):
            return None
        artifact_id = _clean_text(raw.get("id")) or str(uuid.uuid4())
        path = _clean_text(raw.get("path") or raw.get("artifact_path"), max_len=4000)
        if not path:
            return None
        return {
            "id": artifact_id,
            "relatedItemId": _clean_text(
                raw.get("relatedItemId") or raw.get("related_item_id") or raw.get("itemId"),
                max_len=200,
            ),
            "related_item_id": _clean_text(
                raw.get("relatedItemId") or raw.get("related_item_id") or raw.get("itemId"),
                max_len=200,
            ),
            "kind": _clean_text(raw.get("kind"), "snapshot_delta", 80),
            "path": path,
            "summary": _clean_text(raw.get("summary"), max_len=1000),
            "sizeBytes": int(raw.get("sizeBytes") or raw.get("size_bytes") or 0),
            "size_bytes": int(raw.get("sizeBytes") or raw.get("size_bytes") or 0),
            "createdAt": _coerce_iso(raw.get("createdAt") or raw.get("created_at")),
            "created_at": _coerce_iso(raw.get("createdAt") or raw.get("created_at")),
        }

    def _build_artifacts_from_items(self, items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        artifacts: List[Dict[str, Any]] = []
        for item in items:
            if item.get("kind") != "action":
                continue
            path = _clean_text(item.get("changeArtifactPath"), max_len=4000)
            if not path:
                continue
            artifact_id = f"{item['id']}-artifact"
            summary = _clean_text(item.get("changeSummary"), max_len=1000)
            artifact = self._normalize_artifact(
                {
                    "id": artifact_id,
                    "relatedItemId": item["id"],
                    "kind": "snapshot_delta",
                    "path": path,
                    "summary": summary,
                    "sizeBytes": os.path.getsize(path) if os.path.exists(path) else 0,
                    "createdAt": item.get("createdAt"),
                }
            )
            if artifact:
                artifacts.append(artifact)
                current_ids = item.get("artifactIds") or []
                if artifact_id not in current_ids:
                    item["artifactIds"] = [*current_ids, artifact_id]
        return artifacts

    def _normalize_evidence_ref(self, raw: Any) -> Optional[Dict[str, Any]]:
        if not isinstance(raw, dict):
            return None
        ref_type = _clean_text(raw.get("type"))
        if ref_type not in {"timeline_item", "timeline_range", "artifact"}:
            return None
        ref = {"type": ref_type}
        if ref_type == "timeline_item":
            item_id = _clean_text(raw.get("itemId") or raw.get("item_id"), max_len=200)
            if not item_id:
                return None
            ref["itemId"] = item_id
            ref["item_id"] = item_id
        elif ref_type == "timeline_range":
            start_item_id = _clean_text(raw.get("startItemId") or raw.get("start_item_id"), max_len=200)
            if not start_item_id:
                return None
            ref["startItemId"] = start_item_id
            ref["start_item_id"] = start_item_id
            end_item_id = _clean_text(raw.get("endItemId") or raw.get("end_item_id"), max_len=200)
            if end_item_id:
                ref["endItemId"] = end_item_id
                ref["end_item_id"] = end_item_id
        else:
            artifact_id = _clean_text(raw.get("artifactId") or raw.get("artifact_id"), max_len=200)
            if not artifact_id:
                return None
            ref["artifactId"] = artifact_id
            ref["artifact_id"] = artifact_id
        return ref

    def _normalize_card(self, raw: Any) -> Optional[Dict[str, Any]]:
        if not isinstance(raw, dict):
            return None
        title = _clean_text(raw.get("title"), max_len=120)
        goal = _clean_text(raw.get("goal"), max_len=500)
        if not title or not goal:
            return None
        key_actions = [
            _clean_text(value, max_len=240)
            for value in _ensure_list(raw.get("keyActions") or raw.get("key_actions"))
            if _clean_text(value, max_len=240)
        ]
        evidence_refs = [
            ref
            for ref in (
                self._normalize_evidence_ref(value)
                for value in _ensure_list(raw.get("evidenceRefs") or raw.get("evidence_refs"))
            )
            if ref
        ]
        return {
            "id": _clean_text(raw.get("id")) or str(uuid.uuid4()),
            "title": title,
            "goal": goal,
            "keyActions": key_actions[:8],
            "key_actions": key_actions[:8],
            "evidenceRefs": evidence_refs,
            "evidence_refs": evidence_refs,
        }

    def _normalize_draft(self, raw: Any) -> Dict[str, Any]:
        cards = [
            card
            for card in (
                self._normalize_card(item) for item in _ensure_list(raw.get("cards"))
            )
            if card
        ]
        return {
            "id": _clean_text(raw.get("id")) or str(uuid.uuid4()),
            "teachingSessionId": _clean_text(raw.get("teachingSessionId")),
            "teaching_session_id": _clean_text(raw.get("teaching_session_id") or raw.get("teachingSessionId")),
            "version": max(1, int(raw.get("version") or 1)),
            "title": _clean_text(raw.get("title"), "未命名流程", 160) or "未命名流程",
            "status": _clean_text(raw.get("status"), "draft", 32) or "draft",
            "cards": cards,
            "notes": [
                _clean_text(item, max_len=500)
                for item in _ensure_list(raw.get("notes"))
                if _clean_text(item, max_len=500)
            ],
            "warnings": [
                _clean_text(item, max_len=500)
                for item in _ensure_list(raw.get("warnings"))
                if _clean_text(item, max_len=500)
            ],
            "createdAt": _coerce_iso(raw.get("createdAt")),
            "created_at": _coerce_iso(raw.get("created_at") or raw.get("createdAt")),
            "updatedAt": _coerce_iso(raw.get("updatedAt")),
            "updated_at": _coerce_iso(raw.get("updated_at") or raw.get("updatedAt")),
        }

    def _normalize_asset(self, raw: Any) -> Dict[str, Any]:
        return {
            "id": _clean_text(raw.get("id")) or str(uuid.uuid4()),
            "teachingSessionId": _clean_text(raw.get("teachingSessionId")),
            "teaching_session_id": _clean_text(raw.get("teaching_session_id") or raw.get("teachingSessionId")),
            "sourceDraftId": _clean_text(raw.get("sourceDraftId")),
            "source_draft_id": _clean_text(raw.get("source_draft_id") or raw.get("sourceDraftId")),
            "title": _clean_text(raw.get("title"), "未命名流程", 160) or "未命名流程",
            "status": _clean_text(raw.get("status"), "saved", 32) or "saved",
            "visibility": _clean_text(raw.get("visibility"), "private", 32) or "private",
            "cards": [
                card
                for card in (
                    self._normalize_card(item) for item in _ensure_list(raw.get("cards"))
                )
                if card
            ],
            "createdAt": _coerce_iso(raw.get("createdAt")),
            "created_at": _coerce_iso(raw.get("created_at") or raw.get("createdAt")),
        }

    def _normalize_session(self, raw: Any) -> Dict[str, Any]:
        raw_items = raw.get("items")
        if not isinstance(raw_items, list):
            raw_items = raw.get("timeline")
        items = [
            item
            for item in (
                self._normalize_timeline_item(value)
                for value in _ensure_list(raw_items)
            )
            if item
        ]
        derived_artifacts = self._build_artifacts_from_items(items)
        explicit_artifacts = [
            artifact
            for artifact in (
                self._normalize_artifact(value)
                for value in _ensure_list(raw.get("artifacts"))
            )
            if artifact
        ]
        artifacts_by_id = {
            artifact["id"]: artifact
            for artifact in [*explicit_artifacts, *derived_artifacts]
        }
        tab_context = raw.get("tabContext")
        if not isinstance(tab_context, dict):
            tab_context = raw.get("tab_context") if isinstance(raw.get("tab_context"), dict) else {}
        if not tab_context:
            tab_context = {
                "tabId": raw.get("lockedTabId"),
                "domain": raw.get("lockedTabDomain"),
                "title": raw.get("lockedTabTitle"),
                "url": raw.get("lockedTabUrl"),
            }
        return {
            "id": _clean_text(raw.get("id")) or str(uuid.uuid4()),
            "status": _clean_text(raw.get("status"), "review", 32) or "review",
            "scope": _clean_text(raw.get("scope"), "browser-only", 64) or "browser-only",
            "driver_session_id": _clean_text(raw.get("driver_session_id") or raw.get("driverSessionId")),
            "chat_session_id": _clean_text(raw.get("chat_session_id") or raw.get("chatSessionId")),
            "tabContext": {
                "tabId": int(tab_context.get("tabId") or 0),
                "domain": _clean_text(tab_context.get("domain"), max_len=300),
                "title": _clean_text(tab_context.get("title"), max_len=300),
                "url": _clean_text(tab_context.get("url"), max_len=1000),
            },
            "tab_context": {
                "tabId": int(tab_context.get("tabId") or 0),
                "title": _clean_text(tab_context.get("title"), max_len=300),
                "url": _clean_text(tab_context.get("url"), max_len=1000),
            },
            "createdAt": _coerce_iso(raw.get("createdAt")),
            "created_at": _coerce_iso(raw.get("created_at") or raw.get("createdAt")),
            "endedAt": _coerce_iso(raw.get("endedAt")) if raw.get("endedAt") else "",
            "ended_at": _clean_text(raw.get("ended_at") or raw.get("endedAt")),
            "items": items,
            "timeline": copy.deepcopy(items),
            "artifacts": list(artifacts_by_id.values()),
            "currentDraftId": _clean_text(raw.get("currentDraftId"), max_len=200),
            "current_draft_id": _clean_text(raw.get("current_draft_id") or raw.get("currentDraftId"), max_len=200),
            "draftIds": [
                _clean_text(value)
                for value in _ensure_list(raw.get("draftIds"))
                if _clean_text(value)
            ],
            "assetIds": [
                _clean_text(value)
                for value in _ensure_list(raw.get("assetIds"))
                if _clean_text(value)
            ],
            "conversation": [
                {
                    "id": _clean_text(item.get("id")) or str(uuid.uuid4()),
                    "role": _clean_text(item.get("role"), "assistant", 32),
                    "content": _clean_text(item.get("content"), max_len=4000),
                    "createdAt": _coerce_iso(item.get("createdAt")),
                }
                for item in _ensure_list(raw.get("conversation"))
                if isinstance(item, dict) and _clean_text(item.get("content"))
            ],
            "updatedAt": _coerce_iso(raw.get("updatedAt")),
            "updated_at": _coerce_iso(raw.get("updated_at") or raw.get("updatedAt")),
            "last_agent_message": _clean_text(raw.get("last_agent_message")),
        }

    def get_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        with self.lock:
            raw = self._data["sessions"].get(session_id)
            return copy.deepcopy(raw) if raw else None

    def ensure_session(
        self,
        session_id: Optional[str] = None,
        *,
        source_chat_session_id: Optional[str] = None,
        source_browser_session_id: Optional[str] = None,
        title: Optional[str] = None,
        tab_id: Optional[int] = None,
        domain: Optional[str] = None,
        page_title: Optional[str] = None,
        url: Optional[str] = None,
        status: str = "recording",
        scope: str = "browser-only",
        **extra: Any,
    ) -> Dict[str, Any]:
        if session_id:
            existing = self.get_session(session_id)
            if existing:
                if any(value is not None for value in (source_chat_session_id, source_browser_session_id, title, tab_id, domain, page_title, url)) or extra:
                    patch: Dict[str, Any] = {
                        "id": session_id,
                        "status": status or existing.get("status") or "recording",
                        "scope": scope or existing.get("scope") or "browser-only",
                    }
                    if source_chat_session_id is not None:
                        patch["chatSessionId"] = source_chat_session_id
                    if source_browser_session_id is not None:
                        patch["driverSessionId"] = source_browser_session_id
                    patch["tabContext"] = {
                        **(existing.get("tabContext") or {}),
                        **{
                            "tabId": tab_id if tab_id is not None else (existing.get("tabContext") or {}).get("tabId", 0),
                            "domain": domain if domain is not None else (existing.get("tabContext") or {}).get("domain", ""),
                            "title": page_title if page_title is not None else title if title is not None else (existing.get("tabContext") or {}).get("title", ""),
                            "url": url if url is not None else (existing.get("tabContext") or {}).get("url", ""),
                        },
                    }
                    patch.update(extra)
                    merged = {**existing, **patch}
                    return self.upsert_session(merged)
                return existing

        payload: Dict[str, Any] = {
            "id": session_id or str(uuid.uuid4()),
            "status": status or "recording",
            "scope": scope or "browser-only",
            "driverSessionId": _clean_text(source_browser_session_id),
            "chatSessionId": _clean_text(source_chat_session_id),
            "tabContext": {
                "tabId": int(tab_id or 0),
                "domain": _clean_text(domain, max_len=300),
                "title": _clean_text(page_title or title, max_len=300),
                "url": _clean_text(url, max_len=1000),
            },
            "createdAt": _now_iso(),
            "updatedAt": _now_iso(),
            "items": [],
            "artifacts": [],
            "draftIds": [],
            "assetIds": [],
            "currentDraftId": "",
            "conversation": [],
        }
        payload.update(extra)
        return self.upsert_session(payload)

    def update_session(self, session_id: str, patch: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        existing = self.get_session(session_id)
        if not existing:
            return None
        merged = copy.deepcopy(existing)
        merged.update({k: v for k, v in patch.items() if v is not None})
        if isinstance(patch.get("tabContext"), dict):
            merged["tabContext"] = {**(existing.get("tabContext") or {}), **patch["tabContext"]}
        return self.upsert_session(merged)

    def upsert_session(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        with self.lock:
            normalized = self._normalize_session(payload)
            existing = self._data["sessions"].get(normalized["id"])
            if existing:
                normalized["currentDraftId"] = (
                    normalized.get("currentDraftId") or existing.get("currentDraftId") or ""
                )
                normalized["draftIds"] = (
                    normalized.get("draftIds") or existing.get("draftIds") or []
                )
                normalized["assetIds"] = (
                    normalized.get("assetIds") or existing.get("assetIds") or []
                )
                normalized["items"] = normalized.get("items") or existing.get("items") or []
                normalized["timeline"] = normalized.get("timeline") or existing.get("timeline") or []
                normalized["artifacts"] = normalized.get("artifacts") or existing.get("artifacts") or []
                normalized["conversation"] = existing.get("conversation") or []
                normalized["createdAt"] = existing.get("createdAt") or normalized["createdAt"]
            normalized["updatedAt"] = _now_iso()
            self._data["sessions"][normalized["id"]] = normalized
            self._save()
            return copy.deepcopy(normalized)

    def append_conversation_message(
        self, session_id: str, role: str, content: str
    ) -> Optional[Dict[str, Any]]:
        with self.lock:
            session = self._data["sessions"].get(session_id)
            if not session:
                return None
            message = {
                "id": str(uuid.uuid4()),
                "role": _clean_text(role, "assistant", 32),
                "content": _clean_text(content, max_len=4000),
                "createdAt": _now_iso(),
            }
            if not message["content"]:
                return None
            session.setdefault("conversation", []).append(message)
            session["updatedAt"] = _now_iso()
            self._save()
            return copy.deepcopy(message)

    def append_agent_message(
        self, session_id: str, role: str, content: str
    ) -> Optional[Dict[str, Any]]:
        return self.append_conversation_message(session_id, role, content)

    def get_agent_history(self, session_id: str) -> List[Dict[str, Any]]:
        session = self.get_session(session_id) or {}
        history = session.get("conversation")
        return copy.deepcopy(history) if isinstance(history, list) else []

    def append_timeline_item(self, teaching_session_id: str, raw_item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        with self.lock:
            session = self._data["sessions"].get(teaching_session_id)
            if not session:
                return None
            item = self._normalize_timeline_item(raw_item)
            if not item:
                return None
            session.setdefault("items", []).append(item)
            session["timeline"] = copy.deepcopy(session["items"])
            session["updatedAt"] = _now_iso()
            session["updated_at"] = session["updatedAt"]
            self._save()
            return copy.deepcopy(item)

    def update_action_change(
        self,
        teaching_session_id: str,
        item_id: str,
        *,
        change_summary: str,
        artifact: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        with self.lock:
            session = self._data["sessions"].get(teaching_session_id)
            if not session:
                return None
            for item in session.get("items") or []:
                if item.get("id") != item_id or item.get("kind") != "action":
                    continue
                item["changeSummary"] = _clean_text(change_summary, max_len=500)
                item["change_summary"] = item["changeSummary"]
                if artifact:
                    normalized = self._normalize_artifact(artifact)
                    if normalized:
                        session.setdefault("artifacts", []).append(normalized)
                        current_ids = item.get("artifactIds") or []
                        if normalized["id"] not in current_ids:
                            item["artifactIds"] = [*current_ids, normalized["id"]]
                session["timeline"] = copy.deepcopy(session.get("items") or [])
                session["updatedAt"] = _now_iso()
                session["updated_at"] = session["updatedAt"]
                self._save()
                return copy.deepcopy(item)
            return None

    def add_artifact(self, teaching_session_id: str, raw_artifact: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        with self.lock:
            session = self._data["sessions"].get(teaching_session_id)
            if not session:
                return None
            artifact = self._normalize_artifact(raw_artifact)
            if not artifact:
                return None
            session.setdefault("artifacts", []).append(artifact)
            related_item_id = artifact.get("relatedItemId")
            if related_item_id:
                for item in session.get("items") or []:
                    if item.get("id") != related_item_id or item.get("kind") != "action":
                        continue
                    current_ids = item.get("artifactIds") or []
                    if artifact["id"] not in current_ids:
                        item["artifactIds"] = [*current_ids, artifact["id"]]
                    break
            session["updatedAt"] = _now_iso()
            session["updated_at"] = session["updatedAt"]
            self._save()
            return copy.deepcopy(artifact)

    def write_artifact(
        self,
        teaching_session_id: str,
        *,
        related_item_id: str,
        summary: str,
        content: str,
        kind: str = "snapshot_delta",
    ) -> Dict[str, Any]:
        artifact_id = str(uuid.uuid4())
        path = self.artifact_root / teaching_session_id / f"{artifact_id}.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        artifact = self.add_artifact(
            teaching_session_id,
            {
                "id": artifact_id,
                "relatedItemId": related_item_id,
                "kind": kind,
                "path": str(path),
                "summary": summary,
                "sizeBytes": path.stat().st_size if path.exists() else len(content.encode("utf-8")),
                "createdAt": _now_iso(),
            },
        )
        return artifact or {
            "id": artifact_id,
            "relatedItemId": related_item_id,
            "kind": kind,
            "path": str(path),
            "summary": summary,
            "sizeBytes": path.stat().st_size if path.exists() else len(content.encode("utf-8")),
            "createdAt": _now_iso(),
        }

    def mark_stopped(self, teaching_session_id: str) -> Optional[Dict[str, Any]]:
        return self.update_session(
            teaching_session_id,
            {
                "status": "stopped",
                "endedAt": _now_iso(),
            },
        )

    def get_draft(self, draft_id: str) -> Optional[Dict[str, Any]]:
        with self.lock:
            raw = self._data["drafts"].get(draft_id)
            return copy.deepcopy(raw) if raw else None

    def get_current_draft(self, teaching_session_id: str) -> Optional[Dict[str, Any]]:
        return self.get_current_draft_for_session(teaching_session_id)

    def _build_asset_summary(
        self,
        asset: Dict[str, Any],
        session: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        tab_context = session.get("tabContext") if isinstance(session, dict) else {}
        if not isinstance(tab_context, dict):
            tab_context = {}
        return {
            "assetId": asset.get("id"),
            "title": asset.get("title") or DEFAULT_ASSET_TITLE,
            "createdAt": asset.get("createdAt") or asset.get("created_at") or _now_iso(),
            "status": asset.get("status") or "saved",
            "visibility": asset.get("visibility") or "private",
            "cardCount": len(asset.get("cards") or []),
            "teachingSessionId": asset.get("teachingSessionId") or asset.get("teaching_session_id") or "",
            "sourceDraftId": asset.get("sourceDraftId") or asset.get("source_draft_id") or "",
            "sourceTitle": _clean_text(tab_context.get("title"), max_len=300),
            "sourceUrl": _clean_text(tab_context.get("url"), max_len=1000),
            "sourceDomain": _clean_text(tab_context.get("domain"), max_len=300),
        }

    def list_assets(self, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        with self.lock:
            assets = [copy.deepcopy(asset) for asset in self._data["assets"].values()]
            sessions = {
                session_id: copy.deepcopy(session)
                for session_id, session in self._data["sessions"].items()
            }

        def sort_key(asset: Dict[str, Any]) -> str:
            return _clean_text(asset.get("createdAt") or asset.get("created_at"))

        assets.sort(key=sort_key, reverse=True)
        if limit is not None and limit > 0:
            assets = assets[:limit]
        return [
            self._build_asset_summary(
                asset,
                sessions.get(
                    _clean_text(asset.get("teachingSessionId") or asset.get("teaching_session_id"))
                ),
            )
            for asset in assets
        ]

    def get_saved_asset(self, asset_id: str) -> Optional[Dict[str, Any]]:
        with self.lock:
            asset = copy.deepcopy(self._data["assets"].get(asset_id))
            if not asset:
                return None
            teaching_session_id = _clean_text(
                asset.get("teachingSessionId") or asset.get("teaching_session_id")
            )
            session = copy.deepcopy(self._data["sessions"].get(teaching_session_id)) if teaching_session_id else None

        detail = self._build_asset_summary(asset, session)
        detail.update(
            {
                "cards": copy.deepcopy(asset.get("cards") or []),
                "teachingSessionId": teaching_session_id,
                "sourceDraftId": _clean_text(
                    asset.get("sourceDraftId") or asset.get("source_draft_id")
                ),
            }
        )
        return detail

    def set_current_draft(self, teaching_session_id: str, draft: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        title = _clean_text(draft.get("title"), "未命名流程", 160) or "未命名流程"
        mode = _clean_text(draft.get("mode"), "create", 32) or "create"
        notes = [
            _clean_text(item, max_len=500)
            for item in _ensure_list(draft.get("notes"))
            if _clean_text(item, max_len=500)
        ]
        warnings = [
            _clean_text(item, max_len=500)
            for item in _ensure_list(draft.get("warnings"))
            if _clean_text(item, max_len=500)
        ]
        cards = [
            card
            for card in (self._normalize_card(item) for item in _ensure_list(draft.get("cards")))
            if card
        ]
        with self.lock:
            session = self._data["sessions"].get(teaching_session_id)
            if not session:
                return None
            current_id = _clean_text(session.get("currentDraftId"))
            existing = self._data["drafts"].get(current_id) if current_id else None
            draft_id = current_id or str(uuid.uuid4())
            version = int(existing.get("version") or 0) + 1 if existing else 1
            if mode == "replace" and existing:
                draft_id = existing["id"]
                version = int(existing.get("version") or 0) + 1
            normalized = self._normalize_draft(
                {
                    "id": draft_id,
                    "teachingSessionId": teaching_session_id,
                    "version": version,
                    "title": title,
                    "status": "draft",
                    "cards": cards,
                    "notes": notes,
                    "warnings": warnings,
                    "createdAt": existing.get("createdAt") if existing else _now_iso(),
                    "updatedAt": _now_iso(),
                }
            )
            self._data["drafts"][draft_id] = normalized
            session["currentDraftId"] = draft_id
            session["current_draft_id"] = draft_id
            draft_ids = list(session.get("draftIds") or [])
            if draft_id not in draft_ids:
                draft_ids.append(draft_id)
            session["draftIds"] = draft_ids
            session["status"] = "review"
            session["updatedAt"] = _now_iso()
            session["updated_at"] = session["updatedAt"]
            self._save()
            return copy.deepcopy(normalized)

    def update_current_draft(self, teaching_session_id: str, draft: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        return self.set_current_draft(teaching_session_id, {**draft, "mode": "replace"})

    def get_current_draft_for_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        with self.lock:
            session = self._data["sessions"].get(session_id)
            if not session:
                return None
            current_id = _clean_text(session.get("currentDraftId"))
            if current_id and current_id in self._data["drafts"]:
                return copy.deepcopy(self._data["drafts"][current_id])
            draft_ids = _ensure_list(session.get("draftIds"))
            if draft_ids:
                latest_id = draft_ids[-1]
                if latest_id in self._data["drafts"]:
                    return copy.deepcopy(self._data["drafts"][latest_id])
            return None

    def create_or_replace_draft(
        self,
        *,
        teaching_session_id: str,
        draft_id: Optional[str],
        mode: str,
        title: str,
        cards: List[Dict[str, Any]],
        notes: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        with self.lock:
            session = self._data["sessions"].get(teaching_session_id)
            if not session:
                raise KeyError(f"Teaching session not found: {teaching_session_id}")

            existing = self._data["drafts"].get(draft_id) if draft_id else None
            next_id = existing.get("id") if existing else str(uuid.uuid4())
            version = int(existing.get("version") or 1) + 1 if existing else 1
            normalized_cards = [
                card
                for card in (self._normalize_card(item) for item in cards)
                if card
            ]
            draft = self._normalize_draft(
                {
                    "id": next_id,
                    "teachingSessionId": teaching_session_id,
                    "version": version,
                    "title": title,
                    "status": "draft",
                    "cards": normalized_cards,
                    "notes": notes or [],
                    "createdAt": existing.get("createdAt") if existing else _now_iso(),
                    "updatedAt": _now_iso(),
                }
            )
            self._data["drafts"][next_id] = draft
            session["currentDraftId"] = next_id
            session["current_draft_id"] = next_id
            draft_ids = list(session.get("draftIds") or [])
            if next_id not in draft_ids:
                draft_ids.append(next_id)
            session["draftIds"] = draft_ids
            session["status"] = "review" if mode in {"create", "replace"} else session.get("status", "review")
            session["updatedAt"] = _now_iso()
            session["updated_at"] = session["updatedAt"]
            self._save()
            return copy.deepcopy(draft)

    def set_draft(
        self,
        teaching_session_id: str,
        *,
        title: str,
        cards: List[Dict[str, Any]],
        mode: str = "create",
        notes: Optional[List[str]] = None,
    ) -> Optional[Dict[str, Any]]:
        current_draft = self.get_current_draft_for_session(teaching_session_id)
        return self.create_or_replace_draft(
            teaching_session_id=teaching_session_id,
            draft_id=current_draft.get("id") if current_draft and mode == "replace" else None,
            mode=mode,
            title=title,
            cards=cards,
            notes=notes or [],
        )

    def save_asset(
        self,
        *,
        teaching_session_id: str,
        draft_id: str,
        title: str,
        cards: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        with self.lock:
            session = self._data["sessions"].get(teaching_session_id)
            draft = self._data["drafts"].get(draft_id)
            if not session:
                raise KeyError(f"Teaching session not found: {teaching_session_id}")
            if not draft:
                raise KeyError(f"Draft not found: {draft_id}")
            asset = self._normalize_asset(
                {
                    "id": str(uuid.uuid4()),
                    "teachingSessionId": teaching_session_id,
                    "sourceDraftId": draft_id,
                    "title": title,
                    "status": "saved",
                    "visibility": "private",
                    "cards": cards if cards is not None else draft.get("cards") or [],
                    "createdAt": _now_iso(),
                }
            )
            self._data["assets"][asset["id"]] = asset
            asset_ids = list(session.get("assetIds") or [])
            asset_ids.append(asset["id"])
            session["assetIds"] = asset_ids
            session["status"] = "saved"
            session["updatedAt"] = _now_iso()
            session["updated_at"] = session["updatedAt"]
            self._save()
            return copy.deepcopy(asset)

    def set_asset(self, teaching_session_id: str, raw_asset: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        draft_id = _clean_text(raw_asset.get("sourceDraftId") or raw_asset.get("source_draft_id"))
        title = _clean_text(raw_asset.get("title"), "未命名流程", 160) or "未命名流程"
        cards = raw_asset.get("cards") if isinstance(raw_asset.get("cards"), list) else None
        if not draft_id:
            current_draft = self.get_current_draft_for_session(teaching_session_id)
            draft_id = current_draft.get("id") if current_draft else ""
        if not draft_id:
            return None
        return self.save_asset(
            teaching_session_id=teaching_session_id,
            draft_id=draft_id,
            title=title,
            cards=cards,
        )

    def _build_draft_summary(self, draft: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if not draft:
            return None
        return {
            "draftId": draft["id"],
            "version": draft["version"],
            "title": draft["title"],
            "cardCount": len(draft.get("cards") or []),
            "cards": [
                {
                    "cardId": card["id"],
                    "title": card["title"],
                    "goal": card["goal"],
                }
                for card in draft.get("cards") or []
            ],
        }

    def build_case_overview(self, teaching_session_id: str) -> Optional[Dict[str, Any]]:
        session = self.get_session(teaching_session_id)
        if not session:
            return None
        current_draft = self.get_current_draft_for_session(teaching_session_id)
        items = session.get("items") or []
        action_items = [item for item in items if item.get("kind") == "action"]
        note_items = [item for item in items if item.get("kind") == "note"]
        artifact_manifest = [
            {
                "artifactId": artifact["id"],
                "relatedItemId": artifact.get("relatedItemId"),
                "kind": artifact.get("kind"),
                "path": artifact.get("path"),
                "summary": artifact.get("summary"),
                "sizeBytes": artifact.get("sizeBytes", 0),
            }
            for artifact in session.get("artifacts") or []
        ]
        timeline_digest = [
            {
                "itemId": item["id"],
                "kind": item["kind"],
                "summary": item.get("summary") or item.get("text") or "",
                "createdAt": item.get("createdAt"),
                "artifactIds": item.get("artifactIds") or [],
            }
            for item in items
        ]
        return {
            "teachingSessionId": session["id"],
            "status": session.get("status", "review"),
            "scope": session.get("scope", "browser-only"),
            "tabContext": _safe_copy(session.get("tabContext") or {}),
            "timelineStats": {
                "totalItems": len(items),
                "actionItems": len(action_items),
                "noteItems": len(note_items),
                "artifactCount": len(artifact_manifest),
            },
            "timelineDigest": timeline_digest,
            "artifactManifest": artifact_manifest,
            "currentDraftSummary": self._build_draft_summary(current_draft),
        }

    def build_overview(self, teaching_session_id: str) -> Optional[Dict[str, Any]]:
        return self.build_case_overview(teaching_session_id)

    def get_overview(self, teaching_session_id: str) -> Optional[Dict[str, Any]]:
        return self.build_overview(teaching_session_id)

    def read_timeline(
        self,
        teaching_session_id: str,
        *,
        mode: str = "range",
        start_item_id: Optional[str] = None,
        end_item_id: Optional[str] = None,
        item_ids: Optional[List[str]] = None,
        max_items: Optional[int] = None,
    ) -> Optional[Dict[str, Any]]:
        session = self.get_session(teaching_session_id)
        if not session:
            return None
        items = session.get("items") or []
        selected: List[Dict[str, Any]]
        if mode == "items" and item_ids:
            item_id_set = {value for value in item_ids if value}
            selected = [item for item in items if item["id"] in item_id_set]
        else:
            if start_item_id:
                try:
                    start_idx = next(idx for idx, item in enumerate(items) if item["id"] == start_item_id)
                except StopIteration:
                    start_idx = 0
            else:
                start_idx = 0
            if end_item_id:
                try:
                    end_idx = next(idx for idx, item in enumerate(items) if item["id"] == end_item_id)
                except StopIteration:
                    end_idx = len(items) - 1
            else:
                end_idx = len(items) - 1
            selected = items[start_idx : end_idx + 1] if items else []
        if max_items is not None and max_items > 0:
            selected = selected[:max_items]
        payload_items = []
        for item in selected:
            payload = {
                "itemId": item["id"],
                "kind": item["kind"],
                "createdAt": item.get("createdAt"),
                "summary": item.get("summary") or item.get("text") or "",
            }
            if item.get("kind") == "action":
                payload["changeSummary"] = item.get("changeSummary", "")
                payload["artifactIds"] = item.get("artifactIds") or []
            payload_items.append(payload)
        return {"teachingSessionId": teaching_session_id, "items": payload_items}

    def read_artifact(self, artifact_id: str, mode: str = "summary") -> Optional[Dict[str, Any]]:
        session_artifact = None
        with self.lock:
            for session in self._data["sessions"].values():
                for artifact in session.get("artifacts") or []:
                    if artifact.get("id") == artifact_id:
                        session_artifact = copy.deepcopy(artifact)
                        break
                if session_artifact:
                    break
        if not session_artifact:
            return None
        path = session_artifact.get("path") or ""
        content = ""
        if path and os.path.exists(path):
            try:
                content = Path(path).read_text(encoding="utf-8")
            except Exception:
                content = ""
        summary_lines = [line for line in content.splitlines() if line.strip()][:24]
        summary = session_artifact.get("summary") or "\n".join(summary_lines)[:1500]
        return {
            "artifactId": session_artifact["id"],
            "mode": mode,
            "summary": summary,
            "content": content if mode == "full" else None,
        }

    def get_artifact(self, teaching_session_id: str, artifact_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
        if artifact_id is None:
            for other_session in self._data["sessions"].values():
                for artifact in other_session.get("artifacts") or []:
                    if artifact.get("id") == teaching_session_id:
                        return copy.deepcopy(artifact)
            return self.read_artifact(teaching_session_id, "summary")
        session = self.get_session(teaching_session_id)
        if session:
            for artifact in session.get("artifacts") or []:
                if artifact.get("id") == artifact_id:
                    return copy.deepcopy(artifact)
        for other_session in self._data["sessions"].values():
            for artifact in other_session.get("artifacts") or []:
                if artifact.get("id") == artifact_id:
                    return copy.deepcopy(artifact)
        return None

    def read_artifact_content(self, artifact_id: str) -> str:
        artifact = self.read_artifact(artifact_id, "full")
        if not artifact:
            return ""
        return _clean_text(artifact.get("content"))

    def locate_card_evidence(self, teaching_session_id: str, draft_id: str, card_id: str) -> Optional[Dict[str, Any]]:
        session = self.get_session(teaching_session_id)
        draft = self.get_draft(draft_id)
        if not session or not draft:
            return None
        target = next((card for card in draft.get("cards") or [] if card["id"] == card_id), None)
        if not target:
            return None
        anchors: List[Dict[str, Any]] = []
        artifact_ids: List[str] = []
        for ref in target.get("evidenceRefs") or []:
            if ref.get("type") == "timeline_item" and ref.get("itemId"):
                anchors.append({"startItemId": ref["itemId"]})
            elif ref.get("type") == "timeline_range" and ref.get("startItemId"):
                anchors.append(
                    {
                        "startItemId": ref["startItemId"],
                        "endItemId": ref.get("endItemId"),
                    }
                )
            elif ref.get("type") == "artifact" and ref.get("artifactId"):
                artifact_ids.append(ref["artifactId"])
        return {
            "cardId": card_id,
            "timelineAnchors": anchors,
            "artifactIds": artifact_ids,
        }


teaching_store = TeachingStore()
