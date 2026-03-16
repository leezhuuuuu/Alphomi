from __future__ import annotations

import copy
import datetime as dt
import json
import os
import re
import threading
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional


STORE_VERSION = 1
DEFAULT_TITLE = "新对话"
THINK_BLOCK_RE = re.compile(r"<think>.*?</think>", re.IGNORECASE | re.DOTALL)


def _now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _clean_preview_text(text: str) -> str:
    raw = str(text or "")
    cleaned = THINK_BLOCK_RE.sub("", raw)
    cleaned = cleaned.replace("<think>", "").replace("</think>", "")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def _clean_title_text(text: str) -> str:
    cleaned = _clean_preview_text(text)
    return cleaned[:60].strip()


def _collect_user_ids(messages: List[Dict[str, Any]]) -> set[str]:
    user_ids: set[str] = set()
    for msg in messages:
        if msg.get("role") != "user":
            continue
        val = msg.get("client_message_id")
        if isinstance(val, str) and val:
            user_ids.add(val)
    return user_ids


def _normalize_work_summaries(raw: Any) -> Dict[str, Dict[str, Any]]:
    if not isinstance(raw, dict):
        return {}
    normalized: Dict[str, Dict[str, Any]] = {}
    for turn_id, item in raw.items():
        if not isinstance(turn_id, str) or not turn_id:
            continue
        if not isinstance(item, dict):
            continue
        elapsed = item.get("elapsedSec")
        try:
            elapsed_num = max(1, int(elapsed))
        except Exception:
            elapsed_num = 1
        label = str(item.get("label") or "Completed").strip() or "Completed"
        thought = _clean_preview_text(item.get("thought") or "")
        updated_at = str(item.get("updatedAt") or _now_iso())
        normalized[turn_id] = {
            "elapsedSec": elapsed_num,
            "label": label,
            "thought": thought[:8000],
            "updatedAt": updated_at,
        }
    return normalized


def _normalize_work_events(raw: Any) -> Dict[str, List[Dict[str, Any]]]:
    if not isinstance(raw, dict):
        return {}
    normalized: Dict[str, List[Dict[str, Any]]] = {}
    for turn_id, events in raw.items():
        if not isinstance(turn_id, str) or not turn_id:
            continue
        if not isinstance(events, list):
            continue
        normalized_events: List[Dict[str, Any]] = []
        for idx, event in enumerate(events):
            if not isinstance(event, dict):
                continue
            event_type = str(event.get("type") or "").strip()
            if not event_type:
                continue
            seq_raw = event.get("seq")
            try:
                seq = int(seq_raw)
            except Exception:
                seq = idx + 1
            if seq < 1:
                seq = idx + 1
            payload = event.get("payload")
            if isinstance(payload, (dict, list, str, int, float, bool)) or payload is None:
                safe_payload = copy.deepcopy(payload)
            else:
                safe_payload = str(payload)
            event_id = str(event.get("eventId") or event.get("event_id") or str(uuid.uuid4()))
            created_at = str(event.get("createdAt") or event.get("created_at") or _now_iso())
            normalized_events.append(
                {
                    "eventId": event_id,
                    "seq": seq,
                    "type": event_type,
                    "payload": safe_payload,
                    "createdAt": created_at,
                }
            )
        normalized_events.sort(key=lambda item: int(item.get("seq") or 0))
        if normalized_events:
            normalized[turn_id] = normalized_events
    return normalized


def _max_work_event_seq(work_events: Dict[str, List[Dict[str, Any]]]) -> int:
    max_seq = 0
    for events in work_events.values():
        if not isinstance(events, list):
            continue
        for item in events:
            if not isinstance(item, dict):
                continue
            try:
                seq = int(item.get("seq") or 0)
            except Exception:
                seq = 0
            if seq > max_seq:
                max_seq = seq
    return max_seq


def _safe_preview(messages: List[Dict[str, Any]], limit: int = 80) -> str:
    for msg in reversed(messages):
        if msg.get("role") == "user":
            text = _clean_preview_text(msg.get("content", ""))
            if text:
                return text[:limit]
        if msg.get("role") == "assistant" and msg.get("content"):
            text = _clean_preview_text(msg.get("content", ""))
            if text:
                return text[:limit]
    return ""


class ChatStore:
    def __init__(self, store_path: Optional[str] = None):
        raw_path = store_path or os.getenv("CHAT_STORE_PATH") or "logs/chat_sessions.json"
        self.path = Path(raw_path)
        self.lock = threading.Lock()
        self._data: Dict[str, Any] = {
            "version": STORE_VERSION,
            "active_session_id": None,
            "sessions": [],
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
            sessions = parsed.get("sessions")
            if not isinstance(sessions, list):
                sessions = []
            normalized: List[Dict[str, Any]] = []
            for item in sessions:
                if not isinstance(item, dict):
                    continue
                sid = str(item.get("id") or "").strip()
                if not sid:
                    continue
                messages = item.get("messages")
                if not isinstance(messages, list):
                    messages = []
                work_events = _normalize_work_events(item.get("work_events"))
                seq_raw = item.get("work_event_seq")
                try:
                    work_event_seq = max(int(seq_raw), _max_work_event_seq(work_events))
                except Exception:
                    work_event_seq = _max_work_event_seq(work_events)
                normalized.append(
                    {
                        "id": sid,
                        "title": _clean_title_text(item.get("title") or DEFAULT_TITLE) or DEFAULT_TITLE,
                        "title_source": str(item.get("title_source") or "fallback"),
                        "mode": item.get("mode") if isinstance(item.get("mode"), str) else None,
                        "created_at": str(item.get("created_at") or _now_iso()),
                        "updated_at": str(item.get("updated_at") or _now_iso()),
                        "messages": messages,
                        "work_summaries": _normalize_work_summaries(item.get("work_summaries")),
                        "work_events": work_events,
                        "work_event_seq": work_event_seq,
                    }
                )
            self._data = {
                "version": STORE_VERSION,
                "active_session_id": parsed.get("active_session_id"),
                "sessions": normalized,
            }

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(self._data, ensure_ascii=False, indent=2)
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp.write_text(payload, encoding="utf-8")
        tmp.replace(self.path)

    def _find_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        for session in self._data["sessions"]:
            if session.get("id") == session_id:
                return session
        return None

    def create_session(self, title: Optional[str] = None, mode: Optional[str] = None) -> Dict[str, Any]:
        with self.lock:
            now = _now_iso()
            sid = str(uuid.uuid4())
            session = {
                "id": sid,
                "title": _clean_title_text(title or DEFAULT_TITLE) or DEFAULT_TITLE,
                "title_source": "fallback",
                "mode": mode,
                "created_at": now,
                "updated_at": now,
                "messages": [],
                "work_summaries": {},
                "work_events": {},
                "work_event_seq": 0,
            }
            self._data["sessions"].append(session)
            self._data["active_session_id"] = sid
            self._save()
            return copy.deepcopy(session)

    def ensure_session(self, session_id: Optional[str] = None) -> Dict[str, Any]:
        with self.lock:
            if session_id:
                existing = self._find_session(session_id)
                if existing:
                    self._data["active_session_id"] = existing["id"]
                    self._save()
                    return copy.deepcopy(existing)

            active = self._find_session(str(self._data.get("active_session_id") or ""))
            if active:
                return copy.deepcopy(active)

            if self._data["sessions"]:
                latest = sorted(
                    self._data["sessions"],
                    key=lambda item: str(item.get("updated_at") or ""),
                    reverse=True,
                )[0]
                self._data["active_session_id"] = latest["id"]
                self._save()
                return copy.deepcopy(latest)

            now = _now_iso()
            sid = str(uuid.uuid4())
            created = {
                "id": sid,
                "title": DEFAULT_TITLE,
                "title_source": "fallback",
                "mode": None,
                "created_at": now,
                "updated_at": now,
                "messages": [],
                "work_summaries": {},
                "work_events": {},
                "work_event_seq": 0,
            }
            self._data["sessions"].append(created)
            self._data["active_session_id"] = sid
            self._save()
            return copy.deepcopy(created)

    def list_sessions(self) -> List[Dict[str, Any]]:
        with self.lock:
            items = sorted(
                self._data["sessions"],
                key=lambda item: str(item.get("updated_at") or ""),
                reverse=True,
            )
            result = []
            for session in items:
                messages = session.get("messages") or []
                result.append(
                    {
                        "id": session["id"],
                        "title": _clean_title_text(session.get("title") or DEFAULT_TITLE) or DEFAULT_TITLE,
                        "titleSource": session.get("title_source") or "fallback",
                        "mode": session.get("mode"),
                        "createdAt": session.get("created_at"),
                        "updatedAt": session.get("updated_at"),
                        "messageCount": len(messages),
                        "lastMessagePreview": _safe_preview(messages),
                    }
                )
            return result

    def get_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        with self.lock:
            found = self._find_session(session_id)
            if not found:
                return None
            return copy.deepcopy(found)

    def set_active(self, session_id: str) -> Optional[Dict[str, Any]]:
        with self.lock:
            found = self._find_session(session_id)
            if not found:
                return None
            self._data["active_session_id"] = session_id
            self._save()
            return copy.deepcopy(found)

    def get_active_id(self) -> Optional[str]:
        with self.lock:
            val = self._data.get("active_session_id")
            return str(val) if isinstance(val, str) and val else None

    def set_messages(self, session_id: str, messages: List[Dict[str, Any]]) -> bool:
        with self.lock:
            found = self._find_session(session_id)
            if not found:
                return False
            found["messages"] = copy.deepcopy(messages)
            self._prune_work_data(found)
            found["updated_at"] = _now_iso()
            self._save()
            return True

    def _prune_work_data(self, session: Dict[str, Any]) -> None:
        self._prune_work_summaries(session)
        self._prune_work_events(session)

    def _prune_work_summaries(self, session: Dict[str, Any]) -> None:
        work_summaries = _normalize_work_summaries(session.get("work_summaries"))
        if not work_summaries:
            session["work_summaries"] = {}
            return
        valid_turn_ids = _collect_user_ids(session.get("messages") or [])
        if not valid_turn_ids:
            session["work_summaries"] = {}
            return
        session["work_summaries"] = {
            turn_id: summary
            for turn_id, summary in work_summaries.items()
            if turn_id in valid_turn_ids
        }

    def _prune_work_events(self, session: Dict[str, Any]) -> None:
        work_events = _normalize_work_events(session.get("work_events"))
        if not work_events:
            session["work_events"] = {}
            session["work_event_seq"] = 0
            return
        valid_turn_ids = _collect_user_ids(session.get("messages") or [])
        if not valid_turn_ids:
            session["work_events"] = {}
            session["work_event_seq"] = 0
            return
        filtered = {
            turn_id: events
            for turn_id, events in work_events.items()
            if turn_id in valid_turn_ids and isinstance(events, list) and events
        }
        session["work_events"] = filtered
        session["work_event_seq"] = _max_work_event_seq(filtered)

    def set_mode(self, session_id: str, mode: Optional[str]) -> bool:
        with self.lock:
            found = self._find_session(session_id)
            if not found:
                return False
            found["mode"] = mode
            found["updated_at"] = _now_iso()
            self._save()
            return True

    def update_title(self, session_id: str, title: str, source: str = "user") -> bool:
        clean = _clean_title_text(title or "")
        if not clean:
            return False
        with self.lock:
            found = self._find_session(session_id)
            if not found:
                return False
            found["title"] = clean
            found["title_source"] = source
            found["updated_at"] = _now_iso()
            self._save()
            return True

    def set_work_summary(
        self,
        session_id: str,
        turn_id: str,
        elapsed_sec: int,
        label: str = "Completed",
        thought: Optional[str] = None,
    ) -> bool:
        clean_turn_id = str(turn_id or "").strip()
        if not clean_turn_id:
            return False
        try:
            elapsed = max(1, int(elapsed_sec))
        except Exception:
            elapsed = 1
        clean_label = str(label or "Completed").strip() or "Completed"
        clean_thought = _clean_preview_text(thought or "")[:8000]

        with self.lock:
            found = self._find_session(session_id)
            if not found:
                return False
            valid_turn_ids = _collect_user_ids(found.get("messages") or [])
            if valid_turn_ids and clean_turn_id not in valid_turn_ids:
                return False
            current = _normalize_work_summaries(found.get("work_summaries"))
            current[clean_turn_id] = {
                "elapsedSec": elapsed,
                "label": clean_label,
                "thought": clean_thought,
                "updatedAt": _now_iso(),
            }
            found["work_summaries"] = current
            found["updated_at"] = _now_iso()
            self._save()
            return True

    def clear_work_for_turn(
        self,
        session_id: str,
        turn_id: str,
        clear_summary: bool = True,
        clear_events: bool = True,
    ) -> bool:
        clean_turn_id = str(turn_id or "").strip()
        if not clean_turn_id:
            return False
        with self.lock:
            found = self._find_session(session_id)
            if not found:
                return False
            changed = False
            if clear_summary:
                current_summaries = _normalize_work_summaries(found.get("work_summaries"))
                if clean_turn_id in current_summaries:
                    current_summaries.pop(clean_turn_id, None)
                    found["work_summaries"] = current_summaries
                    changed = True
            if clear_events:
                current_events = _normalize_work_events(found.get("work_events"))
                if clean_turn_id in current_events:
                    current_events.pop(clean_turn_id, None)
                    found["work_events"] = current_events
                    found["work_event_seq"] = _max_work_event_seq(current_events)
                    changed = True
            if changed:
                found["updated_at"] = _now_iso()
                self._save()
            return True

    def append_work_event(
        self,
        session_id: str,
        turn_id: str,
        event_type: str,
        payload: Any,
        created_at: Optional[str] = None,
        save: bool = True,
    ) -> bool:
        clean_turn_id = str(turn_id or "").strip()
        clean_type = str(event_type or "").strip()
        if not clean_turn_id or not clean_type:
            return False
        if isinstance(payload, (dict, list, str, int, float, bool)) or payload is None:
            safe_payload = copy.deepcopy(payload)
        else:
            safe_payload = str(payload)

        with self.lock:
            found = self._find_session(session_id)
            if not found:
                return False
            valid_turn_ids = _collect_user_ids(found.get("messages") or [])
            if valid_turn_ids and clean_turn_id not in valid_turn_ids:
                return False
            current_events = _normalize_work_events(found.get("work_events"))
            seq_seed = found.get("work_event_seq")
            try:
                next_seq = max(int(seq_seed), _max_work_event_seq(current_events)) + 1
            except Exception:
                next_seq = _max_work_event_seq(current_events) + 1
            event = {
                "eventId": str(uuid.uuid4()),
                "seq": next_seq,
                "type": clean_type,
                "payload": safe_payload,
                "createdAt": str(created_at or _now_iso()),
            }
            turn_events = current_events.get(clean_turn_id) or []
            turn_events.append(event)
            current_events[clean_turn_id] = turn_events
            found["work_events"] = current_events
            found["work_event_seq"] = next_seq
            found["updated_at"] = _now_iso()
            if save:
                self._save()
            return True

    def delete_session(self, session_id: str) -> bool:
        with self.lock:
            before = len(self._data["sessions"])
            self._data["sessions"] = [
                item for item in self._data["sessions"] if item.get("id") != session_id
            ]
            deleted = len(self._data["sessions"]) != before
            if not deleted:
                return False

            active_id = self._data.get("active_session_id")
            if active_id == session_id:
                if self._data["sessions"]:
                    newest = sorted(
                        self._data["sessions"],
                        key=lambda item: str(item.get("updated_at") or ""),
                        reverse=True,
                    )[0]
                    self._data["active_session_id"] = newest["id"]
                else:
                    self._data["active_session_id"] = None
            self._save()
            return True


chat_store = ChatStore()
