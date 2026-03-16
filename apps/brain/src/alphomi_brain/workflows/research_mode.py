from __future__ import annotations

from typing import AsyncGenerator

from ..core.events import DoneEvent, ErrorEvent
from .base import BaseWorkflow


class ResearchWorkflow(BaseWorkflow):
    async def run(self, user_input: str) -> AsyncGenerator[ErrorEvent | DoneEvent, None]:
        yield ErrorEvent(error="Research mode is not implemented yet.")
        yield DoneEvent()
