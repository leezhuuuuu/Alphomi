from enum import Enum
from typing import Dict, Any
from .tool_base import registry, RiskLevel

class SecurityMode(Enum):
    AUTO = "auto"
    GOD = "god"
    MANUAL = "manual"

class SecurityGuard:
    def __init__(self):
        self.mode = SecurityMode.AUTO

    def set_mode(self, mode_str: str):
        try:
            self.mode = SecurityMode(mode_str.lower())
            print(f"🛡️ [Guard] Mode set to: {self.mode.value}")
        except: pass

    def get_risk_level(self, tool_name: str, args: Dict[str, Any]) -> str:
        """Helper for UI display"""
        tool = registry.get_tool(tool_name)
        if not tool: return "UNKNOWN"
        return tool.calculate_risk(args).name

    def check_permission(self, tool_name: str, args: Dict[str, Any]) -> bool:
        """
        True = Allowed
        False = Blocked (Need Approval)
        """
        if self.mode == SecurityMode.GOD: return True
        if self.mode == SecurityMode.MANUAL: return False

        tool = registry.get_tool(tool_name)
        if not tool: return False # Unknown tool -> Block

        risk = tool.calculate_risk(args)

        # Auto Mode Policy
        if risk == RiskLevel.SAFE: return True
        if risk == RiskLevel.RISKY: return True # Auto 模式放行 RISKY

        # DANGEROUS -> Block
        return False

guard = SecurityGuard()