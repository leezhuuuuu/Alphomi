from __future__ import annotations

from abc import ABC, abstractmethod
from typing import AsyncGenerator

from ..core.context import AgentContext
from ..core.events import AgentEvent


class BaseWorkflow(ABC):
    def __init__(self, context: AgentContext):
        self.context = context

    @abstractmethod
    async def run(self, user_input: str) -> AsyncGenerator[AgentEvent, None]:
        raise NotImplementedError
