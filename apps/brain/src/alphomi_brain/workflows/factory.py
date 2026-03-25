from __future__ import annotations

from ..core.context import AgentContext
from .advanced_mode import AdvancedWorkflow, build_advanced_system_prompt
from .base import BaseWorkflow
from .benchmark_mode import BenchmarkWorkflow, build_benchmark_system_prompt
from .fast_mode import FastWorkflow, build_fast_system_prompt
from .agent_node import build_agent_node_system_prompt
from .research_mode import ResearchWorkflow
from .teaching_mode import TeachingInvestigatorWorkflow, build_teaching_system_prompt


def create_workflow(mode: str | None, context: AgentContext) -> BaseWorkflow:
    if mode == "teaching":
        return TeachingInvestigatorWorkflow(context)
    if mode == "advanced":
        return AdvancedWorkflow(context)
    if mode == "benchmark":
        return BenchmarkWorkflow(context)
    if mode == "research":
        return ResearchWorkflow(context)
    return FastWorkflow(context)


def get_system_prompt_for_mode(mode: str | None) -> str:
    if mode == "teaching":
        return build_teaching_system_prompt()
    if mode == "advanced":
        return build_advanced_system_prompt()
    if mode == "benchmark":
        return build_benchmark_system_prompt()
    if mode == "agent_node":
        return build_agent_node_system_prompt()
    return build_fast_system_prompt()
