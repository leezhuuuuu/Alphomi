import json
import os
from typing import Dict, Any
from ..core.tool_base import BaseTool, RiskLevel
from ..core.runtimes import WorkspaceManager, PythonRuntime, ShellRuntime
from ..core.teaching_store import teaching_store

workspace = WorkspaceManager()
py_runtime = PythonRuntime(workspace)
sh_runtime = ShellRuntime(workspace)

class PythonTool(BaseTool):
    name = "run_python_code"
    description = "Execute Python code for data analysis, calculations, or file processing. Variables are preserved."

    @property
    def parameters(self):
        return {"code": {"type": "string", "description": "Valid Python code"}}

    @property
    def required_params(self):
        return ["code"]

    async def execute(self, args: Dict[str, Any], context=None) -> str:
        return py_runtime.run(args.get("code", ""))

    def calculate_risk(self, args: Dict[str, Any]) -> RiskLevel:
        code = args.get("code", "")
        # 高危库检测
        if "os.system" in code or "subprocess" in code or "shutil.rmtree" in code:
            return RiskLevel.DANGEROUS
        # 写文件检测
        if "open(" in code and ("'w'" in code or '"w"' in code):
            return RiskLevel.RISKY
        # 默认安全
        return RiskLevel.SAFE


class ShellTool(BaseTool):
    name = "run_shell_command"
    description = "Execute a shell command (bash/zsh) in the workspace."

    @property
    def parameters(self):
        return {"command": {"type": "string", "description": "Shell command"}}

    @property
    def required_params(self):
        return ["command"]

    async def execute(self, args: Dict[str, Any], context=None) -> str:
        return sh_runtime.run(args.get("command", ""))

    def calculate_risk(self, args: Dict[str, Any]) -> RiskLevel:
        cmd = args.get("command", "").strip()
        # 白名单
        safe_cmds = ("ls", "echo", "pwd", "cat", "grep", "find", "git status", "git log")
        if cmd.startswith(safe_cmds):
            return RiskLevel.SAFE
        # 其他默认危险
        return RiskLevel.DANGEROUS


class SkillsManagementTool(BaseTool):
    name = "manage_skills"
    description = """
    Official package manager for agent skills.
    STRICT RULES:
    1. To CHECK installed skills, ALWAYS use `action='list'`. DO NOT use `ls` or shell commands.
    2. To FIND new skills, use `action='search'`.
    3. To INSTALL a skill, use `action='install'`.
    4. To LEARN a skill, use `action='details'`.
    """

    def __init__(self):
        from ..utils.config import load_config_from_yaml
        conf = load_config_from_yaml("skills")
        self.web_ui_base = conf.get("REGISTRY_URL", "https://skills.leezhu.cn")

    @property
    def parameters(self):
        return {
            "action": {
                "type": "string",
                "enum": ["search", "install", "details", "list"],
                "description": "Operation to perform. IMPORTANT: Use 'list' to check installed skills."
            },
            "query": {
                "type": "string",
                "description": "Keywords for search."
            },
            "name": {
                "type": "string",
                "description": "Exact skill name for install/details."
            }
        }

    @property
    def required_params(self):
        return ["action"]

    async def execute(self, args: Dict[str, Any], context=None) -> str:
        action = args.get("action")

        # === 1. Search ===
        if action == "search":
            query = args.get("query", "")

            # [Visual Sync] 浏览器跳转到搜索页（临时禁用，保留注释）
            # if context:
            #     try:
            #         await context.navigate(f"{self.web_ui_base}/?q={query}")
            #     except Exception:
            #         pass

            # API 查询
            try:
                from skills_mcp import api
                client = api.RegistryClient()
                results = client.search(query)
                skills = results.get("skills", [])
                if not skills:
                    return "No skills found."

                # 返回精简信息给 LLM
                summary = [{"name": s["name"], "desc": s["description"]} for s in skills[:5]]
                return json.dumps(summary, ensure_ascii=False)
            except Exception as e:
                return f"Search Error: {e}"

        # === 2. Install ===
        elif action == "install":
            name = args.get("name")
            try:
                from skills_mcp import local
                msg = local.install_skill(name)
                return f"SUCCESS: {msg}"
            except Exception as e:
                return f"Install Error: {e}"

        # === 3. Details (Learning) ===
        elif action == "details":
            name = args.get("name")

            # [Visual Sync] 浏览器跳转到详情页（临时禁用，保留注释）
            # if context:
            #     try:
            #         await context.navigate(f"{self.web_ui_base}/skill/{name}")
            #     except Exception:
            #         pass

            try:
                from skills_mcp import local
                info = local.get_details(name)
                return (
                    f"PATH: {info['path']}\n"
                    f"FILES:\n{info['tree']}\n"
                    f"MANUAL:\n{info['instruction']}\n\n"
                    f"IMPORTANT: To execute this skill, assume you are in the workspace root. "
                    f"Use 'uv run {info['path']}/<script_name> ...' to automatically handle dependencies."
                )
            except Exception as e:
                return f"Details Error: {e}"

        # === 4. List (Installed skills) ===
        elif action == "list":
            try:
                from skills_mcp import local
                skills = local.get_installed_skills()
                if not skills:
                    return "No skills installed yet. Use action='search' to find some."

                summary = [{"name": s["name"], "desc": s.get("description", "")} for s in skills]
                return json.dumps(summary, ensure_ascii=False)
            except Exception as e:
                return f"List Error: {e}"

        return "Invalid action."

    def calculate_risk(self, args: Dict[str, Any]) -> RiskLevel:
        action = args.get("action")
        if action == "install":
            return RiskLevel.RISKY
        return RiskLevel.SAFE


class ManageTeachingsTool(BaseTool):
    name = "manage_teachings"
    description = """
    Lightweight manager for saved teaching assets.
    STRICT RULES:
    1. To CHECK available teachings, ALWAYS use `action='list'`.
    2. To READ one saved teaching, use `action='details'`.
    3. Prefer `list` first when you need the latest catalog or asset ids.
    4. Read `details` only for a specific teaching that is likely relevant.
    """

    @property
    def parameters(self):
        return {
            "action": {
                "type": "string",
                "enum": ["list", "details"],
                "description": "Operation to perform. Use 'list' first to inspect saved teachings.",
            },
            "asset_id": {
                "type": "string",
                "description": "Exact asset id for details.",
            },
            "title": {
                "type": "string",
                "description": "Teaching title for details when asset id is unknown.",
            },
            "limit": {
                "type": "integer",
                "description": "Maximum number of teachings to list.",
            },
        }

    @property
    def required_params(self):
        return ["action"]

    def _resolve_asset_by_title(self, title: str) -> tuple[dict | None, str | None]:
        wanted = title.strip()
        if not wanted:
            return None, "Missing title."

        assets = teaching_store.list_assets()
        exact = [
            asset for asset in assets
            if isinstance(asset, dict) and str(asset.get("title") or "").strip() == wanted
        ]
        if len(exact) == 1:
            return exact[0], None
        if len(exact) > 1:
            return None, (
                "Multiple saved teachings share that title. "
                "Use action='list' to inspect asset ids and call details with asset_id."
            )

        lowered = wanted.lower()
        fuzzy = [
            asset for asset in assets
            if isinstance(asset, dict) and str(asset.get("title") or "").strip().lower() == lowered
        ]
        if len(fuzzy) == 1:
            return fuzzy[0], None
        if len(fuzzy) > 1:
            return None, (
                "Multiple saved teachings match that title. "
                "Use action='list' to inspect asset ids and call details with asset_id."
            )
        return None, "Saved teaching not found."

    async def execute(self, args: Dict[str, Any], context=None) -> str:
        action = args.get("action")

        if action == "list":
            limit = args.get("limit")
            try:
                limit_num = int(limit) if limit is not None else 20
            except Exception:
                limit_num = 20
            assets = teaching_store.list_assets(limit=max(1, limit_num))
            if not assets:
                return "No saved teachings yet."
            summary = [
                {
                    "assetId": asset.get("assetId"),
                    "title": asset.get("title"),
                    "sourceDomain": asset.get("sourceDomain") or "",
                    "cardCount": asset.get("cardCount") or 0,
                    "createdAt": asset.get("createdAt") or "",
                }
                for asset in assets
                if isinstance(asset, dict)
            ]
            return json.dumps(summary, ensure_ascii=False)

        if action == "details":
            asset_id = str(args.get("asset_id") or "").strip()
            title = str(args.get("title") or "").strip()

            detail = None
            if asset_id:
                detail = teaching_store.get_saved_asset(asset_id)
                if not detail:
                    return "Saved teaching not found."
            elif title:
                matched, error = self._resolve_asset_by_title(title)
                if error:
                    return error
                detail = teaching_store.get_saved_asset(str((matched or {}).get("assetId") or "").strip())
            else:
                return "Provide asset_id or title when action='details'."

            if not isinstance(detail, dict):
                return "Saved teaching not found."

            cards = detail.get("cards") if isinstance(detail.get("cards"), list) else []
            payload = {
                "assetId": detail.get("assetId"),
                "title": detail.get("title"),
                "sourceDomain": detail.get("sourceDomain") or "",
                "sourceTitle": detail.get("sourceTitle") or "",
                "cardCount": detail.get("cardCount") or len(cards),
                "cards": [
                    {
                        "title": card.get("title") or "",
                        "goal": card.get("goal") or "",
                        "keyActions": card.get("keyActions") or [],
                    }
                    for card in cards
                    if isinstance(card, dict)
                ],
            }
            return json.dumps(payload, ensure_ascii=False)

        return "Invalid action."

    def calculate_risk(self, args: Dict[str, Any]) -> RiskLevel:
        return RiskLevel.SAFE
