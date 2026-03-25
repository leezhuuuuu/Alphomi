from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any, Dict, List

from ..core.tool_base import BaseTool, RiskLevel
from ..core.teaching_store import teaching_store


def _clean_str(value: Any) -> str:
    return str(value or "").strip()


def _normalize_cards(cards: Any) -> List[Dict[str, Any]]:
    if not isinstance(cards, list):
        return []

    normalized: List[Dict[str, Any]] = []
    for idx, card in enumerate(cards, start=1):
        if not isinstance(card, dict):
            continue
        title = _clean_str(card.get("title")) or f"阶段 {idx}"
        goal = _clean_str(card.get("goal"))
        key_actions = card.get("keyActions")
        if not isinstance(key_actions, list):
            key_actions = card.get("key_actions")
        normalized_actions = [
            _clean_str(item) for item in (key_actions or []) if _clean_str(item)
        ]
        evidence_refs = card.get("evidenceRefs")
        if not isinstance(evidence_refs, list):
            evidence_refs = card.get("evidence_refs")
        normalized_refs: List[Dict[str, Any]] = []
        for ref in evidence_refs or []:
            if not isinstance(ref, dict):
                continue
            normalized_ref = {
                "type": _clean_str(ref.get("type")),
                "itemId": ref.get("itemId"),
                "startItemId": ref.get("startItemId"),
                "endItemId": ref.get("endItemId"),
                "artifactId": ref.get("artifactId"),
            }
            normalized_ref = {k: v for k, v in normalized_ref.items() if v not in (None, "")}
            if normalized_ref.get("type"):
                normalized_refs.append(normalized_ref)

        normalized.append(
            {
                "id": _clean_str(card.get("id")) or str(uuid.uuid4()),
                "title": title,
                "goal": goal,
                "keyActions": normalized_actions,
                "evidenceRefs": normalized_refs,
            }
        )
    return normalized


def _draft_markdown(title: str, cards: List[Dict[str, Any]], notes: List[str], warnings: List[str]) -> str:
    lines = [f"# {title}", ""]
    if notes:
        lines.extend(["## Notes", *[f"- {note}" for note in notes], ""])
    if warnings:
        lines.extend(["## Warnings", *[f"- {warning}" for warning in warnings], ""])
    for idx, card in enumerate(cards, start=1):
        lines.append(f"## Phase {idx}: {card.get('title') or f'阶段 {idx}'}")
        goal = _clean_str(card.get("goal"))
        if goal:
            lines.append(f"- Goal: {goal}")
        actions = card.get("keyActions") or []
        if actions:
            lines.append("- Key Actions:")
            for action in actions:
                lines.append(f"  - {action}")
        lines.append("")
    return "\n".join(lines).strip() + "\n"


class GetTeachingCaseOverviewTool(BaseTool):
    name = "get_teaching_case_overview"
    description = "Read a lightweight overview of a teaching session before doing deeper investigation."

    @property
    def parameters(self):
        return {
            "teaching_session_id": {
                "type": "string",
                "description": "Teaching session id.",
            }
        }

    @property
    def required_params(self):
        return ["teaching_session_id"]

    async def execute(self, args: Dict[str, Any], context=None) -> str:
        session_id = _clean_str(args.get("teaching_session_id"))
        overview = teaching_store.build_overview(session_id)
        return json.dumps(overview, ensure_ascii=False, indent=2)

    def calculate_risk(self, args: Dict[str, Any]) -> RiskLevel:
        return RiskLevel.SAFE


class ReadTeachingTimelineTool(BaseTool):
    name = "read_teaching_timeline"
    description = "Read a slice of the teaching timeline for investigation."

    @property
    def parameters(self):
        return {
            "teaching_session_id": {"type": "string", "description": "Teaching session id."},
            "mode": {
                "type": "string",
                "enum": ["range", "items"],
                "description": "How to select timeline items.",
            },
            "start_item_id": {"type": "string", "description": "Start item id for range mode."},
            "end_item_id": {"type": "string", "description": "End item id for range mode."},
            "item_ids": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Explicit item ids for items mode.",
            },
            "max_items": {"type": "integer", "description": "Maximum items to return."},
        }

    @property
    def required_params(self):
        return ["teaching_session_id"]

    async def execute(self, args: Dict[str, Any], context=None) -> str:
        session_id = _clean_str(args.get("teaching_session_id"))
        mode = _clean_str(args.get("mode")) or "range"
        max_items = args.get("max_items")
        try:
            max_items_num = int(max_items) if max_items is not None else 80
        except Exception:
            max_items_num = 80

        session = teaching_store.get_session(session_id) or {}
        timeline = session.get("timeline") if isinstance(session.get("timeline"), list) else []

        selected: List[Dict[str, Any]] = []
        if mode == "items":
            wanted = {
                _clean_str(item_id)
                for item_id in (args.get("item_ids") or [])
                if _clean_str(item_id)
            }
            for item in timeline:
                if not isinstance(item, dict):
                    continue
                if _clean_str(item.get("id")) in wanted:
                    selected.append(item)
        else:
            start_item_id = _clean_str(args.get("start_item_id"))
            end_item_id = _clean_str(args.get("end_item_id"))
            collecting = not start_item_id
            for item in timeline:
                if not isinstance(item, dict):
                    continue
                item_id = _clean_str(item.get("id"))
                if item_id == start_item_id:
                    collecting = True
                if collecting:
                    selected.append(item)
                if end_item_id and item_id == end_item_id:
                    break

        selected = selected[:max(0, max_items_num)]
        payload = {
            "teachingSessionId": session_id,
            "mode": mode,
            "items": selected,
        }
        return json.dumps(payload, ensure_ascii=False, indent=2)

    def calculate_risk(self, args: Dict[str, Any]) -> RiskLevel:
        return RiskLevel.SAFE


class ReadTeachingArtifactTool(BaseTool):
    name = "read_teaching_artifact"
    description = "Read a heavy teaching artifact file by id."

    @property
    def parameters(self):
        return {
            "artifact_id": {"type": "string", "description": "Artifact id."},
            "mode": {
                "type": "string",
                "enum": ["summary", "full"],
                "description": "Read summary or full content.",
            },
        }

    @property
    def required_params(self):
        return ["artifact_id"]

    async def execute(self, args: Dict[str, Any], context=None) -> str:
        artifact_id = _clean_str(args.get("artifact_id"))
        mode = _clean_str(args.get("mode")) or "summary"
        artifact = teaching_store.get_artifact(artifact_id)
        if not artifact:
            return json.dumps(
                {"artifactId": artifact_id, "mode": mode, "error": "Artifact not found"},
                ensure_ascii=False,
                indent=2,
            )

        payload: Dict[str, Any] = {
            "artifactId": artifact_id,
            "mode": mode,
            "summary": artifact.get("summary") or "",
            "path": artifact.get("path") or "",
        }
        if mode == "full":
            payload["content"] = teaching_store.read_artifact_content(artifact_id)
        return json.dumps(payload, ensure_ascii=False, indent=2)

    def calculate_risk(self, args: Dict[str, Any]) -> RiskLevel:
        return RiskLevel.SAFE


class GenerateProcessCardsTool(BaseTool):
    name = "generate_process_cards"
    description = "Persist the current teaching investigation as a structured process draft."

    @property
    def parameters(self):
        return {
            "teaching_session_id": {"type": "string", "description": "Teaching session id."},
            "draft_id": {"type": "string", "description": "Draft id to replace or extend."},
            "mode": {
                "type": "string",
                "enum": ["create", "replace"],
                "description": "Create a new draft or replace the current one.",
            },
            "title_suggestion": {"type": "string", "description": "Suggested draft title."},
            "cards": {
                "type": "array",
                "description": "Structured cards for the process draft.",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
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
                                    "type": {"type": "string"},
                                    "itemId": {"type": "string"},
                                    "startItemId": {"type": "string"},
                                    "endItemId": {"type": "string"},
                                    "artifactId": {"type": "string"},
                                },
                            },
                        },
                    },
                    "required": ["title", "goal", "keyActions", "evidenceRefs"],
                },
            },
            "notes": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Optional notes about the draft.",
            },
            "warnings": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Optional warnings about uncertainty.",
            },
        }

    @property
    def required_params(self):
        return ["teaching_session_id", "mode", "title_suggestion", "cards"]

    async def execute(self, args: Dict[str, Any], context=None) -> str:
        session_id = _clean_str(args.get("teaching_session_id"))
        mode = _clean_str(args.get("mode")) or "replace"
        title = _clean_str(args.get("title_suggestion")) or "教学流程"
        cards = _normalize_cards(args.get("cards"))
        notes = [_clean_str(note) for note in (args.get("notes") or []) if _clean_str(note)]
        warnings = [_clean_str(item) for item in (args.get("warnings") or []) if _clean_str(item)]

        session = teaching_store.get_session(session_id)
        if not session:
            return json.dumps(
                {"error": "Teaching session not found", "teachingSessionId": session_id},
                ensure_ascii=False,
                indent=2,
            )

        if mode == "create":
            draft = teaching_store.set_current_draft(
                session_id,
                {
                    "title": title,
                    "status": "draft",
                    "cards": cards,
                    "notes": notes,
                    "warnings": warnings,
                },
            )
        else:
            current_draft = teaching_store.get_current_draft(session_id)
            if current_draft and _clean_str(args.get("draft_id")) in {"", _clean_str(current_draft.get("id"))}:
                draft = teaching_store.update_current_draft(
                    session_id,
                    {
                        "title": title,
                        "status": "draft",
                        "cards": cards,
                        "notes": notes,
                        "warnings": warnings,
                    },
                )
            else:
                draft = teaching_store.set_current_draft(
                    session_id,
                    {
                        "title": title,
                        "status": "draft",
                        "cards": cards,
                        "notes": notes,
                        "warnings": warnings,
                    },
                )

        if not draft:
            return json.dumps(
                {"error": "Failed to persist draft", "teachingSessionId": session_id},
                ensure_ascii=False,
                indent=2,
            )

        markdown = _draft_markdown(title, cards, notes, warnings)
        draft_dir = teaching_store.artifact_root / session_id
        draft_dir.mkdir(parents=True, exist_ok=True)
        draft_path = draft_dir / f"draft-{draft.get('id')}.md"
        draft_path.write_text(markdown, encoding="utf-8")

        return json.dumps(
            {
                "draftId": draft.get("id"),
                "version": draft.get("version"),
                "title": draft.get("title"),
                "cardCount": len(cards),
                "markdownPath": str(draft_path),
            },
            ensure_ascii=False,
            indent=2,
        )

    def calculate_risk(self, args: Dict[str, Any]) -> RiskLevel:
        return RiskLevel.SAFE


class LocateCardEvidenceTool(BaseTool):
    name = "locate_card_evidence"
    description = "Return timeline and artifact anchors for a draft card."

    @property
    def parameters(self):
        return {
            "teaching_session_id": {"type": "string", "description": "Teaching session id."},
            "draft_id": {"type": "string", "description": "Draft id."},
            "card_id": {"type": "string", "description": "Card id."},
        }

    @property
    def required_params(self):
        return ["teaching_session_id", "draft_id", "card_id"]

    async def execute(self, args: Dict[str, Any], context=None) -> str:
        session_id = _clean_str(args.get("teaching_session_id"))
        draft_id = _clean_str(args.get("draft_id"))
        card_id = _clean_str(args.get("card_id"))
        payload = teaching_store.locate_card_evidence(session_id, draft_id, card_id) or {}
        payload["draftId"] = draft_id
        return json.dumps(payload, ensure_ascii=False, indent=2)

    def calculate_risk(self, args: Dict[str, Any]) -> RiskLevel:
        return RiskLevel.SAFE


class SaveProcessAssetTool(BaseTool):
    name = "save_process_asset"
    description = "Save the current draft as a private reusable process asset."

    @property
    def parameters(self):
        return {
            "teaching_session_id": {"type": "string", "description": "Teaching session id."},
            "draft_id": {"type": "string", "description": "Draft id to save."},
            "title": {"type": "string", "description": "Final asset title."},
        }

    @property
    def required_params(self):
        return ["teaching_session_id", "draft_id", "title"]

    async def execute(self, args: Dict[str, Any], context=None) -> str:
        session_id = _clean_str(args.get("teaching_session_id"))
        draft_id = _clean_str(args.get("draft_id"))
        title = _clean_str(args.get("title")) or "教学流程"

        session = teaching_store.get_session(session_id)
        if not session:
            return json.dumps(
                {"error": "Teaching session not found", "teachingSessionId": session_id},
                ensure_ascii=False,
                indent=2,
            )

        current_draft = teaching_store.get_current_draft(session_id)
        if not current_draft:
            return json.dumps(
                {"error": "Draft not found", "teachingSessionId": session_id},
                ensure_ascii=False,
                indent=2,
            )
        if draft_id and _clean_str(current_draft.get("id")) != draft_id:
            return json.dumps(
                {"error": "Draft id mismatch", "teachingSessionId": session_id, "draftId": draft_id},
                ensure_ascii=False,
                indent=2,
            )

        asset = teaching_store.set_asset(
            session_id,
            {
                "source_draft_id": current_draft.get("id"),
                "title": title,
                "visibility": "private",
                "cards": current_draft.get("cards") or [],
            },
        )
        if not asset:
            return json.dumps(
                {"error": "Failed to save asset", "teachingSessionId": session_id},
                ensure_ascii=False,
                indent=2,
            )

        asset_dir = teaching_store.asset_root
        asset_dir.mkdir(parents=True, exist_ok=True)
        asset_path = asset_dir / f"{asset.get('id')}.md"
        markdown = _draft_markdown(title, asset.get("cards") or [], current_draft.get("notes") or [], current_draft.get("warnings") or [])
        asset_path.write_text(markdown, encoding="utf-8")

        payload = {
            "assetId": asset.get("id"),
            "title": asset.get("title"),
            "status": "saved",
            "draftId": current_draft.get("id"),
            "assetPath": str(asset_path),
        }
        return json.dumps(payload, ensure_ascii=False, indent=2)

    def calculate_risk(self, args: Dict[str, Any]) -> RiskLevel:
        return RiskLevel.SAFE
