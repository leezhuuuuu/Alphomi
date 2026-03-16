from typing import Dict, Any
from ..core.tool_base import BaseTool, RiskLevel
from ..core.pras_client import PrasClient

class RemoteBrowserTool(BaseTool):
    def __init__(self, schema_def: Dict[str, Any]):
        self._name = schema_def["name"]
        self._description = schema_def.get("description", "")
        self._input_schema = schema_def.get("inputSchema", {})

    @property
    def name(self) -> str: return self._name
    @property
    def description(self) -> str: return self._description
    @property
    def parameters(self) -> Dict: return self._input_schema.get("properties", {})
    @property
    def required_params(self) -> list: return self._input_schema.get("required", [])

    async def execute(self, args: Dict[str, Any], context: PrasClient) -> str:
        if not context: return "Error: Browser session lost."
        res = await context.call_tool(self.name, args)
        result_text = res.get("result", str(res))
        snapshot = res.get("snapshot")
        if snapshot:
            snapshot_text = str(snapshot)
            if snapshot_text.startswith("# Snapshot Unchanged") or snapshot_text.startswith("# Snapshot Delta"):
                return f"{result_text}\n{snapshot_text}"
            return f"{result_text}\nPage Snapshot:\n```yaml\n{snapshot_text}\n```"
        return result_text # 简化处理，快照等逻辑在 Client 处理

    def calculate_risk(self, args: Dict[str, Any]) -> RiskLevel:
        # 定义浏览器操作的风险
        if self.name in ["browser_snapshot", "browser_navigate", "browser_tabs", "browser_verify_text_visible", "browser_inspect_visual", "browser_ask_visual"]:
            return RiskLevel.SAFE
        # 交互类操作在 Auto 模式下通常是可以容忍的
        if self.name in ["browser_click", "browser_type", "browser_fill_form", "browser_click_point", "browser_type_point"]:
            return RiskLevel.SAFE
        return RiskLevel.RISKY
