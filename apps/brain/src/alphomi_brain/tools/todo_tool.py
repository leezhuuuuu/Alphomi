from typing import Dict, Any, List, Optional
from ..core.tool_base import BaseTool, RiskLevel

# 简单的内存存储：SessionID -> List[Dict]
# 注意：在多进程部署下需要换成 Redis，但当前架构 Brain 是单进程运行的，内存字典足够。
_SESSION_TODOS: Dict[str, List[Dict[str, Any]]] = {}
_SESSION_COMPLEX_TODOS: Dict[str, List[Dict[str, Any]]] = {}

class TodoListTool(BaseTool):
    name = "manage_todos"
    description = """
    Manage a task list (todo list) for complex, multi-step goals.
    Use this to plan ahead before executing actions, or to update progress.
    """

    @property
    def parameters(self):
        return {
            "mode": {
                "type": "string",
                "enum": ["overwrite", "update", "clear"],
                "description": "overwrite: Create a fresh plan (clears old ones). update: Update status of a specific step. clear: Remove all tasks."
            },
            "todos": {
                "type": "array",
                "items": {"type": "string"},
                "description": "List of task descriptions. Required ONLY when mode is 'overwrite'."
            },
            "index": {
                "type": "integer",
                "description": "1-based index of the task to update. Required ONLY when mode is 'update'."
            },
            "status": {
                "type": "string",
                "enum": ["done", "failed", "skipped", "pending"],
                "description": "New status for the task. Default is 'done'."
            },
            "result": {
                "type": "string",
                "description": "Short observation or data obtained from this step (e.g., 'Price is $50')."
            }
        }

    @property
    def required_params(self):
        # 虽然根据 mode 不同必填项不同，但为了 Schema 简单，我们只强制 mode
        # 逻辑校验在 execute 中做
        return ["mode"]

    async def execute(self, args: Dict[str, Any], context: Any = None) -> str:
        # 1. 获取 Session ID
        session_id = "default"
        if context and hasattr(context, "session_id"):
            session_id = context.session_id

        mode = args.get("mode")
        current_list = _SESSION_TODOS.get(session_id, [])

        # 2. 逻辑处理
        if mode == "overwrite":
            raw_todos = args.get("todos", [])
            if not raw_todos:
                _SESSION_TODOS[session_id] = []
                return self._render_markdown([])
            
            # 初始化结构
            current_list = [{"text": t, "status": "pending", "result": ""} for t in raw_todos]
            _SESSION_TODOS[session_id] = current_list

        elif mode == "clear":
            _SESSION_TODOS[session_id] = []
            return self._render_markdown([])

        elif mode == "update":
            idx = args.get("index")
            if idx is None:
                return "Error: 'index' is required when mode is 'update'."
            
            # 转换为 0-based
            real_idx = idx - 1
            if 0 <= real_idx < len(current_list):
                item = current_list[real_idx]
                item["status"] = args.get("status", "done")
                if args.get("result"):
                    item["result"] = args.get("result")
            else:
                return f"Error: Index {idx} out of bounds. Current list size: {len(current_list)}."

        # 3. 渲染 Markdown
        return self._render_markdown(current_list)

    def _render_markdown(self, todo_list: List[Dict]) -> str:
        if not todo_list:
            return "No active plan."

        lines = ["# Current Task List"]
        next_found = False

        status_symbols = {
            "pending": " ",
            "done": "x",
            "failed": "-",
            "skipped": "?"
        }

        for i, item in enumerate(todo_list):
            idx = i + 1
            mark = status_symbols.get(item["status"], " ")
            text = item["text"]
            result_str = f" (Result: {item['result']})" if item['result'] else ""
            
            line = f"{idx}. [{mark}] {text}{result_str}"

            # 智能添加指针：指向第一个未完成的任务
            if item["status"] == "pending" and not next_found:
                line += " <--- CURRENT STEP"
                next_found = True
            
            lines.append(line)

        # 如果全部完成
        if not next_found:
            lines.append("\n[All tasks completed]")

        return "\n".join(lines)

    def calculate_risk(self, args: Dict[str, Any]) -> RiskLevel:
        # 这是一个纯逻辑工具，没有任何副作用，绝对安全
        return RiskLevel.SAFE


class ComplexTodoListTool(BaseTool):
    name = "manage_complex_todos"
    description = """
    Manage an advanced task list that supports grouping for parallel execution,
    batch updates, and result summaries for each task.
    """

    @property
    def parameters(self):
        return {
            "mode": {
                "type": "string",
                "enum": ["overwrite", "update"],
                "description": "overwrite: Create a fresh plan. update: Update status/results."
            },
            "todos": {
                "type": "array",
                "description": "Full task list. Required ONLY when mode is 'overwrite'.",
                "items": {
                    "type": "object",
                    "properties": {
                        "desc": {"type": "string", "description": "Task goal description."},
                        "group": {"type": "string", "description": "Parallel group name."}
                    },
                    "required": ["desc"]
                }
            },
            "updates": {
                "type": "array",
                "description": "Batch updates. Required ONLY when mode is 'update'.",
                "items": {
                    "type": "object",
                    "properties": {
                        "index": {"type": "integer", "description": "1-based task index."},
                        "status": {
                            "type": "string",
                            "enum": ["done", "failed", "skipped"],
                            "description": "New status."
                        },
                        "result": {"type": "string", "description": "Summary result for the task."}
                    },
                    "required": ["index", "status"]
                }
            }
        }

    @property
    def required_params(self):
        return ["mode"]

    async def execute(self, args: Dict[str, Any], context: Any = None) -> str:
        session_id = "default"
        if context and hasattr(context, "session_id"):
            session_id = context.session_id

        mode = args.get("mode")
        current_list = _SESSION_COMPLEX_TODOS.get(session_id, [])

        if mode == "overwrite":
            raw_todos = args.get("todos", [])
            if not raw_todos:
                _SESSION_COMPLEX_TODOS[session_id] = []
                return self._render_markdown([])

            current_list = []
            for todo in raw_todos:
                if isinstance(todo, dict):
                    desc = todo.get("desc", "").strip()
                    if not desc:
                        continue
                    current_list.append({
                        "desc": desc,
                        "group": todo.get("group"),
                        "status": "pending",
                        "result": ""
                    })
            _SESSION_COMPLEX_TODOS[session_id] = current_list

        elif mode == "update":
            updates = args.get("updates")
            if not updates:
                return "Error: 'updates' is required when mode is 'update'."

            for update in updates:
                idx = update.get("index")
                if idx is None:
                    return "Error: 'index' is required for each update item."
                real_idx = idx - 1
                if not (0 <= real_idx < len(current_list)):
                    return f"Error: Index {idx} out of bounds. Current list size: {len(current_list)}."

            for update in updates:
                real_idx = update.get("index") - 1
                item = current_list[real_idx]
                item["status"] = update.get("status", "done")
                if update.get("result"):
                    item["result"] = update.get("result")

        return self._render_markdown(current_list)

    def _render_markdown(self, todo_list: List[Dict[str, Any]]) -> str:
        if not todo_list:
            return "No active plan."

        lines = ["# 🚀 Mission Control Board"]

        ready_indices = set()
        first_pending_idx = None
        for i, item in enumerate(todo_list):
            if item.get("status") == "pending":
                first_pending_idx = i
                break

        if first_pending_idx is not None:
            first_group = todo_list[first_pending_idx].get("group")
            if first_group:
                i = first_pending_idx
                while i < len(todo_list):
                    item = todo_list[i]
                    if item.get("status") != "pending" or item.get("group") != first_group:
                        break
                    ready_indices.add(i)
                    i += 1
            else:
                ready_indices.add(first_pending_idx)

        status_symbols = {
            "pending": " ",
            "done": "x",
            "failed": "!",
            "skipped": "-"
        }

        for i, item in enumerate(todo_list):
            idx = i + 1
            status = item.get("status", "pending")
            mark = status_symbols.get(status, " ")
            desc = item.get("desc", "")
            group = item.get("group")
            group_str = f" (Group: {group})" if group else ""
            line = f"{idx}. [{mark}] {desc}{group_str}"

            if status == "failed":
                line += " <--- FAILED"
            if i in ready_indices:
                line += " <--- READY"

            lines.append(line)

            result = item.get("result")
            if result:
                lines.append(f"   - Result: {result}")

        return "\n".join(lines)

    def calculate_risk(self, args: Dict[str, Any]) -> RiskLevel:
        return RiskLevel.SAFE
