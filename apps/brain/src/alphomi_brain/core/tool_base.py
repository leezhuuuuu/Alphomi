from abc import ABC, abstractmethod
from typing import Dict, Any, List, Optional
from enum import Enum

class RiskLevel(Enum):
    SAFE = 0        # 可以在 Auto 模式下静默执行
    RISKY = 1       # 在 Auto 模式下通常允许，但在 Manual 模式下拦截
    DANGEROUS = 2   # 必须拦截并弹窗，除非是 God 模式

class BaseTool(ABC):
    """所有工具的抽象基类"""

    @property
    @abstractmethod
    def name(self) -> str:
        """工具名称，作为唯一标识 (e.g., 'run_shell_command')"""
        pass

    @property
    @abstractmethod
    def description(self) -> str:
        """工具描述 (给 LLM 看的)"""
        pass

    @property
    @abstractmethod
    def parameters(self) -> Dict[str, Any]:
        """JSON Schema 的 parameters.properties 部分"""
        pass

    @property
    def required_params(self) -> List[str]:
        """必填参数列表"""
        return []

    def to_openai_schema(self) -> Dict[str, Any]:
        """生成 OpenAI Function Definition"""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": self.parameters,
                    "required": self.required_params
                }
            }
        }

    @abstractmethod
    async def execute(self, args: Dict[str, Any], context: Any = None) -> str:
        """执行逻辑。context 可以传入 PrasClient 或其他上下文对象"""
        pass

    @abstractmethod
    def calculate_risk(self, args: Dict[str, Any]) -> RiskLevel:
        """
        核心风控逻辑：由工具自己判断本次调用的风险等级。
        这样可以把 'rm -rf' 的判断逻辑内聚在 Shell 工具内部。
        """
        pass

class ToolRegistry:
    """
    单例注册表：存储所有已实例化的工具对象
    """
    def __init__(self):
        self._tools: Dict[str, BaseTool] = {}

    def register(self, tool: BaseTool):
        self._tools[tool.name] = tool
        # print(f"🔧 [Registry] Registered tool: {tool.name}")

    def get_tool(self, name: str) -> Optional[BaseTool]:
        return self._tools.get(name)

    def get_all_tools(self) -> List[BaseTool]:
        return list(self._tools.values())

    def get_openai_schemas(self) -> List[Dict[str, Any]]:
        return [t.to_openai_schema() for t in self._tools.values()]

    def clear(self):
        self._tools.clear()

# 全局实例
registry = ToolRegistry()