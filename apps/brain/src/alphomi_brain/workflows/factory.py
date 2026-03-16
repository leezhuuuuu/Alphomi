from __future__ import annotations

from ..core.context import AgentContext
from .advanced_mode import AdvancedWorkflow, ADVANCED_SYSTEM_PROMPT
from .base import BaseWorkflow
from .benchmark_mode import BenchmarkWorkflow, BENCHMARK_SYSTEM_PROMPT
from .fast_mode import FastWorkflow, build_fast_system_prompt
from .agent_node import AGENT_NODE_SYSTEM_PROMPT
from .research_mode import ResearchWorkflow


def create_workflow(mode: str | None, context: AgentContext) -> BaseWorkflow:
    if mode == "advanced":
        return AdvancedWorkflow(context)
    if mode == "benchmark":
        return BenchmarkWorkflow(context)
    if mode == "research":
        return ResearchWorkflow(context)
    return FastWorkflow(context)


def get_system_prompt_for_mode(mode: str | None) -> str:
    if mode == "advanced":
        return ADVANCED_SYSTEM_PROMPT
    if mode == "benchmark":
        return BENCHMARK_SYSTEM_PROMPT
    if mode == "agent_node":
        return AGENT_NODE_SYSTEM_PROMPT
    return build_fast_system_prompt()
