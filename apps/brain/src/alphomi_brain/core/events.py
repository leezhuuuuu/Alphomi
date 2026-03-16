from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Dict


@dataclass
class AgentEvent:
    type: str

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class ContentEvent(AgentEvent):
    content: str
    type: str = field(init=False, default="content_chunk")


@dataclass
class ThinkEvent(AgentEvent):
    content: str
    type: str = field(init=False, default="think_chunk")


@dataclass
class ToolStartEvent(AgentEvent):
    id: str
    name: str
    type: str = field(init=False, default="tool_start")


@dataclass
class ToolInputEvent(AgentEvent):
    id: str
    args: Dict[str, Any]
    type: str = field(init=False, default="tool_input")


@dataclass
class ToolOutputEvent(AgentEvent):
    id: str
    result: str
    type: str = field(init=False, default="tool_output")


@dataclass
class ApprovalRequestEvent(AgentEvent):
    id: str
    toolCallId: str
    toolName: str
    args: Dict[str, Any]
    riskLevel: str
    type: str = field(init=False, default="approval_request")


@dataclass
class ErrorEvent(AgentEvent):
    error: str
    type: str = field(init=False, default="error")


@dataclass
class DoneEvent(AgentEvent):
    type: str = field(init=False, default="done")


@dataclass
class ContextUsageEvent(AgentEvent):
    usedTokens: int
    maxTokens: int
    thresholdTokens: int
    percent: float
    status: str
    type: str = field(init=False, default="context_usage")
