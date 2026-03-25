import asyncio
import os
from typing import Iterable

import httpx
from .local_definitions import PythonTool, ShellTool, SkillsManagementTool
from .exec_tools import ExecCommandTool, WriteStdinTool, FileEditTool
from .remote_definitions import RemoteBrowserTool
from .todo_tool import TodoListTool, ComplexTodoListTool  # <--- [新增] 导入
from .dispatch_tool import DispatchSubAgentTool
from .teaching_tools import (
    GetTeachingCaseOverviewTool,
    ReadTeachingTimelineTool,
    ReadTeachingArtifactTool,
    GenerateProcessCardsTool,
    LocateCardEvidenceTool,
    SaveProcessAssetTool,
)
from ..core.tool_base import registry
from ..core.discovery import discover_driver_url

# 旧工具名到新工具名的映射表
LEGACY_TOOL_MAPPING = {
    "navigate": "browser_navigate",
    "click": "browser_click",
    "type": "browser_type",
    "snapshot": "browser_snapshot",
    "fill": "browser_fill_form",
    "screenshot": "browser_take_screenshot",
    "tabs": "browser_tabs",
    "navigate_back": "browser_navigate_back",
    "navigate_forward": "browser_navigate_forward",
    "resize_view": "browser_resize"
}

_REMOTE_REFRESH_TASK: asyncio.Task | None = None


def _local_candidates() -> Iterable:
    return [
        # PythonTool(),  # 临时禁用：不注册 run_python_code
        ShellTool(),
        ExecCommandTool(),
        WriteStdinTool(),
        FileEditTool(),
        TodoListTool(),
        ComplexTodoListTool(),
        DispatchSubAgentTool(),
        SkillsManagementTool(),
        GetTeachingCaseOverviewTool(),
        ReadTeachingTimelineTool(),
        ReadTeachingArtifactTool(),
        GenerateProcessCardsTool(),
        LocateCardEvidenceTool(),
        SaveProcessAssetTool(),
    ]


def _register_local_tools() -> None:
    for tool in _local_candidates():
        registry.register(tool)
        print(f"✅ [Factory] Loaded local tool: {tool.name}")


async def _load_remote_tools_once() -> bool:
    pras_url = await discover_driver_url()
    os.environ["PRAS_URL"] = pras_url
    print(f"🔎 [Factory] Using Driver at: {pras_url}")

    async with httpx.AsyncClient(timeout=2.5) as client:
        resp = await client.get(f"{pras_url}/tools", params={"includeDisabled": "1"})
        remote_tools_data = resp.json().get("data", {}).get("tools", [])

    loaded = 0
    for t_def in remote_tools_data:
        name = t_def["name"]
        tool_obj = RemoteBrowserTool(t_def)
        registry.register(tool_obj)
        loaded += 1
        print(f"✅ [Factory] Loaded remote tool: {name}")

    return loaded > 0


async def _background_refresh_remote_tools() -> None:
    # 背景持续重试，直到成功拉到远程工具为止
    attempt = 0
    while True:
        attempt += 1
        try:
            if await _load_remote_tools_once():
                print("✅ [Factory] Remote tools loaded in background refresh.")
                return
        except Exception as e:
            print(f"⚠️ [Factory] Background remote tools refresh failed: {e}")

        await asyncio.sleep(min(10.0, 1.5 * attempt))


def _ensure_background_refresh() -> None:
    global _REMOTE_REFRESH_TASK
    if _REMOTE_REFRESH_TASK and not _REMOTE_REFRESH_TASK.done():
        return
    _REMOTE_REFRESH_TASK = asyncio.create_task(_background_refresh_remote_tools())


async def initialize_tools_from_config():
    """
    初始化工具注册表：
    1) 先注册本地工具，保证服务可用
    2) 远程工具采用“前台有限重试 + 后台持续重试”，提高时序容错
    """
    registry.clear()

    # 工具启用/禁用由运行时配置控制。这里始终加载完整工具目录，
    # 这样用户在设置页重新启用某个工具时，不需要重启 Brain。

    # 3. 注册本地工具（立即可用）
    _register_local_tools()

    # 4. 注册远程工具（前台有限重试，减少“刚启动就失败”的概率）
    max_attempts = int(os.getenv("REMOTE_TOOLS_INIT_RETRIES", "8"))
    delay_seconds = float(os.getenv("REMOTE_TOOLS_INIT_DELAY_SECONDS", "1.0"))
    remote_loaded = False

    for attempt in range(1, max_attempts + 1):
        try:
            remote_loaded = await _load_remote_tools_once()
            if remote_loaded:
                break
            print("⚠️ [Factory] Driver responded but returned no tools.")
        except Exception as e:
            print(f"⚠️ [Factory] Failed to fetch browser tools (attempt {attempt}/{max_attempts}): {e}")

        if attempt < max_attempts:
            await asyncio.sleep(delay_seconds * attempt)

    # 5. 如果前台仍未加载到远程工具，进入后台重试
    if not remote_loaded:
        print("⏳ [Factory] Remote tools not ready yet; starting background refresh.")
        _ensure_background_refresh()

    print(f"🎉 [Factory] Total tools loaded: {len(registry.get_all_tools())}")
