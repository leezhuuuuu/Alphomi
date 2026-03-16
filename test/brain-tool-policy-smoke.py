from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT_DIR / "apps/brain/src"))


def write_tool_settings(path: Path, tools: dict[str, bool]) -> None:
    payload = {
        "version": 1,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "tools": tools,
    }
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="alphomi-brain-tool-settings-") as temp_dir:
        settings_path = Path(temp_dir) / "tool-settings.json"
        write_tool_settings(
            settings_path,
            {
                "browser_snapshot": False,
                "manage_skills": False,
                "dispatch_sub_agent": False,
            },
        )
        os.environ["ALPHOMI_TOOL_SETTINGS_PATH"] = str(settings_path)

        from alphomi_brain.core.context import AgentContext
        from alphomi_brain.workflows.agent_node import build_agent_node_system_prompt
        from alphomi_brain.workflows.advanced_mode import build_advanced_system_prompt
        from alphomi_brain.workflows.factory import get_system_prompt_for_mode
        from alphomi_brain.workflows.fast_mode import FastWorkflow, build_fast_system_prompt

        fast_prompt = build_fast_system_prompt()
        assert "manage_skills(action='list')" not in fast_prompt
        assert "browser_snapshot before acting" not in fast_prompt
        assert "browser_snapshot" not in fast_prompt.split("Allowed: ", 1)[1].split(".", 1)[0]

        agent_prompt = build_agent_node_system_prompt()
        assert "browser_snapshot before interacting" not in agent_prompt

        advanced_prompt = build_advanced_system_prompt()
        assert "dispatch_sub_agent" not in advanced_prompt

        factory_prompt = get_system_prompt_for_mode("fast")
        assert "manage_skills(action='list')" not in factory_prompt

        workflow = FastWorkflow(AgentContext())
        assert workflow._is_tool_allowed("browser_click") is True
        assert workflow._is_tool_allowed("browser_snapshot") is False
        assert workflow._is_tool_allowed("manage_skills") is False

        time.sleep(0.02)
        write_tool_settings(
            settings_path,
            {
                "browser_snapshot": True,
                "manage_skills": True,
                "dispatch_sub_agent": True,
            },
        )

        fast_prompt_enabled = build_fast_system_prompt()
        assert "manage_skills(action='list')" in fast_prompt_enabled
        assert "browser_snapshot before acting" in fast_prompt_enabled
        assert workflow._is_tool_allowed("browser_snapshot") is True
        assert workflow._is_tool_allowed("manage_skills") is True

    print("[smoke] brain tool policy smoke passed")


if __name__ == "__main__":
    main()
