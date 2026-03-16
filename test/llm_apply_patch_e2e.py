#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
End-to-end harness: use configured LLM to emit file_edit tool calls,
execute FileEditTool, and iterate until success.
"""
import asyncio
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Dict, Any, List, Callable, Tuple
from urllib.parse import urlparse

# Ensure repo root on sys.path
REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "apps" / "brain" / "src"))

from alphomi_brain.utils.config import load_config_from_yaml  # noqa: E402
from alphomi_brain.core.llm_client import CustomLLMClient  # noqa: E402
from alphomi_brain.tools.exec_tools import FileEditTool  # noqa: E402


def _is_truthy_env(name: str) -> bool:
    value = os.getenv(name, "").strip().lower()
    return value in {"1", "true", "yes", "on"}


def _validate_llm_base_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def _now_stamp() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S")


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


async def _call_llm(
    client: CustomLLMClient,
    messages: List[Dict[str, Any]],
    tools: List[Dict[str, Any]],
) -> Dict[str, Any]:
    return await client.chat_completion(messages=messages, tools=tools)


def _extract_tool_calls(resp: Dict[str, Any]) -> List[Dict[str, Any]]:
    if not resp:
        return []
    choices = resp.get("choices") or []
    if not choices:
        return []
    message = choices[0].get("message") or {}
    return message.get("tool_calls") or []


def _make_messages(system_prompt: str, user_prompt: str) -> List[Dict[str, Any]]:
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]


def _count_occurrences(text: str, needle: str) -> int:
    return text.count(needle)


def _assert_contains_once(text: str, needle: str) -> Tuple[bool, str]:
    count = _count_occurrences(text, needle)
    if count == 1:
        return True, ""
    return False, f"Expected exactly one occurrence of '{needle}', found {count}"


def _between(text: str, left: str, right: str) -> str:
    lidx = text.find(left)
    if lidx == -1:
        return ""
    ridx = text.find(right, lidx + len(left))
    if ridx == -1:
        return ""
    return text[lidx + len(left):ridx]


class Scenario:
    def __init__(
        self,
        name: str,
        target_relpath: str,
        initial_content: str,
        user_prompt: str,
        validator: Callable[[str], Tuple[bool, str]],
        context_hint: str = "",
        extra_system_rules: str = "",
    ) -> None:
        self.name = name
        self.target_relpath = target_relpath
        self.initial_content = initial_content
        self.user_prompt = user_prompt
        self.validator = validator
        self.context_hint = context_hint
        self.extra_system_rules = extra_system_rules


async def run_scenario(
    client: CustomLLMClient,
    tools: List[Dict[str, Any]],
    base_dir: Path,
    scenario: Scenario,
    max_attempts: int = 8,
) -> Tuple[bool, str, str, List[Dict[str, Any]]]:
    target = base_dir / scenario.target_relpath
    _write(target, scenario.initial_content)
    original = _read(target)

    system_prompt = (
        "You are a coding assistant. You must use file_edit for file edits.\n"
        "File edit rules:\n"
        "1) Call file_edit with JSON: {\"path\": \"...\", \"original_text\": \"...\", \"new_text\": \"...\"}.\n"
        "2) original_text must be an exact copy of file content including indentation and whitespace.\n"
        "3) Include enough context so original_text matches exactly once.\n"
        "4) Do NOT use exec_command.\n"
        "5) Keep existing functions and signatures unchanged unless asked.\n"
        "6) Do NOT add content before the first line of the file.\n"
    )
    if scenario.extra_system_rules:
        system_prompt += scenario.extra_system_rules + "\n"

    user_prompt = scenario.user_prompt + f"\n目标文件路径: {target}\n"
    if scenario.context_hint:
        user_prompt += (
            "\n请把以下原始上下文行原样放入 original_text 字段中（保持一致，含缩进）：\n"
            f"{scenario.context_hint}\n"
        )
    messages = _make_messages(system_prompt, user_prompt)
    attempt_logs: List[Dict[str, Any]] = []

    for attempt in range(1, max_attempts + 1):
        resp = await _call_llm(client, messages, tools)
        tool_calls = _extract_tool_calls(resp)
        if not tool_calls:
            messages.append({"role": "assistant", "content": "No tool calls found."})
            messages.append({"role": "user", "content": "请使用 file_edit 工具调用。"})
            continue

        tc = tool_calls[0]
        call_id = tc.get("id") or f"{scenario.name}_call_{attempt}"
        func = tc.get("function") or {}
        args_raw = func.get("arguments", "{}").strip() if func else "{}"

        try:
            args = json.loads(args_raw) if args_raw else {}
        except json.JSONDecodeError:
            args = {}

        original_text = args.get("original_text", "") if isinstance(args, dict) else ""
        new_text = args.get("new_text", "") if isinstance(args, dict) else ""
        tool = FileEditTool()
        result = await tool.execute(args)
        attempt_logs.append(
            {
                "attempt": attempt,
                "tool_name": func.get("name", "file_edit"),
                "args_raw": args_raw,
                "original_text": original_text,
                "new_text": new_text,
                "result": result,
            }
        )

        messages.append({"role": "assistant", "tool_calls": [tc]})
        messages.append({"role": "tool", "tool_call_id": call_id, "content": result})

        if result.startswith("Error:") or result.startswith("System Error:"):
            current_text = _read(target)
            messages.append(
                {
                    "role": "user",
                    "content": (
                        "file_edit failed: "
                        f"{result}\n"
                        "请修复并重试：确保 original_text 与文件内容完全一致，且唯一匹配。\n"
                        "下面是当前文件的完整内容，请从这里复制 exact original_text：\n"
                        f"```python\n{current_text}\n```\n"
                        "只返回 file_edit 的工具调用。"
                    ),
                }
            )
            continue

        updated = _read(target)
        ok, detail = scenario.validator(updated)
        if ok:
            return True, original, updated, attempt_logs

        messages.append(
            {
                "role": "user",
                "content": (
                    "结果不符合要求，请修复。问题："
                    f"{detail}\n"
                    "下面是当前文件的完整内容，请基于它继续修改，而不是基于旧版本：\n"
                    f"```python\n{updated}\n```\n"
                    "请只返回 file_edit 的工具调用。"
                ),
            }
        )

    return False, original, _read(target), attempt_logs


async def main() -> int:
    load_config_from_yaml("brain")

    llm_base_url = os.getenv("LLM_BASE_URL", "").strip()
    require_llm = _is_truthy_env("REQUIRE_LLM_E2E")
    if not llm_base_url or not _validate_llm_base_url(llm_base_url):
        print("LLM file_edit E2E (complex)")
        print("[skip] Missing or invalid LLM_BASE_URL.")
        print("[skip] Configure config.yaml or env vars before running this integration test.")
        print("[skip] Expected an http(s) endpoint, for example:")
        print("        LLM_BASE_URL=https://your-provider.example/v1/chat/completions")
        if require_llm:
            return 1
        return 0

    base_dir = Path(__file__).resolve().parent / f"_llm_file_edit_run_{_now_stamp()}"
    base_dir.mkdir(parents=True, exist_ok=True)

    tools = [FileEditTool().to_openai_schema()]
    client = CustomLLMClient()

    scenarios: List[Scenario] = []

    # Scenario 1: Insert a function between add and multiply
    content1 = '''# demo target
from typing import List


def add(a: int, b: int) -> int:
    """add two ints"""
    return a + b


def multiply(a: int, b: int) -> int:
    """multiply two ints"""
    return a * b
'''
    user1 = (
        "在 add 和 multiply 之间插入一个新函数 random_sum，"
        "不要移动其它函数，不要修改现有函数内容。"
    )
    def validate1(text: str) -> Tuple[bool, str]:
        ok, detail = _assert_contains_once(text, "def random_sum")
        if not ok:
            return ok, detail
        between = _between(text, "def add", "def multiply")
        if "def random_sum" not in between:
            return False, "random_sum not between add and multiply"
        return True, ""
    hint1 = (
        "def add(a: int, b: int) -> int:\\n"
        "    \\\"\\\"\\\"add two ints\\\"\\\"\\\"\\n"
        "    return a + b\\n\\n"
        "def multiply(a: int, b: int) -> int:\\n"
        "    \\\"\\\"\\\"multiply two ints\\\"\\\"\\\"\\n"
        "    return a * b"
    )
    scenarios.append(
        Scenario(
            name="insert_between",
            target_relpath="case1/demo_target.py",
            initial_content=content1,
            user_prompt=user1,
            validator=validate1,
            context_hint=hint1,
        )
    )

    # Scenario 2: Modify function body only (no rename)
    content2 = '''def area_square(x: int) -> int:
    """return area"""
    return x + x
'''
    user2 = "修复 area_square 的实现，使其返回 x*x，但函数名和签名必须保持不变。"
    def validate2(text: str) -> Tuple[bool, str]:
        if "def area_square" not in text:
            return False, "area_square missing"
        if "return x * x" not in text and "return x*x" not in text:
            return False, "area_square not fixed"
        return True, ""
    hint2 = (
        "def area_square(x: int) -> int:\\n"
        "    \\\"\\\"\\\"return area\\\"\\\"\\\"\\n"
        "    return x + x"
    )
    scenarios.append(
        Scenario(
            name="fix_logic",
            target_relpath="case2/area.py",
            initial_content=content2,
            user_prompt=user2,
            validator=validate2,
            context_hint=hint2,
        )
    )

    # Scenario 3: Multi-hunk update in a single file
    content3 = '''def f1() -> str:
    return "a"


def f2() -> str:
    return "b"


def f3() -> str:
    return "c"
'''
    user3 = "把 f1 返回值改成 'A'，f3 返回值改成 'C'，不要改动 f2。"
    def validate3(text: str) -> Tuple[bool, str]:
        if "return \"A\"" not in text:
            return False, "f1 not updated"
        if "return \"C\"" not in text:
            return False, "f3 not updated"
        if "def f2" not in text or "return \"b\"" not in text:
            return False, "f2 changed unexpectedly"
        return True, ""
    hint3 = (
        "def f1() -> str:\\n"
        "    return \\\"a\\\"\\n\\n"
        "def f2() -> str:\\n"
        "    return \\\"b\\\"\\n\\n"
        "def f3() -> str:\\n"
        "    return \\\"c\\\""
    )
    scenarios.append(
        Scenario(
            name="multi_hunk",
            target_relpath="case3/multi.py",
            initial_content=content3,
            user_prompt=user3,
            validator=validate3,
            context_hint=hint3,
        )
    )

    # Scenario 4: Path with spaces and unicode, add a function
    content4 = '''# header
def hello() -> str:
    return "hi"
'''
    user4 = "在文件末尾增加一个函数 roll_dice，返回随机点数列表和总和。"
    def validate4(text: str) -> Tuple[bool, str]:
        if "def roll_dice" not in text:
            return False, "roll_dice missing"
        return True, ""
    hint4 = "def hello() -> str:\\n    return \\\"hi\\\""
    scenarios.append(
        Scenario(
            name="unicode_path",
            target_relpath="case4/子目录/space file.py",
            initial_content=content4,
            user_prompt=user4,
            validator=validate4,
            context_hint=hint4,
        )
    )

    # Scenario 5: Insert function after a specific marker comment
    content5 = '''# util file
def alpha() -> int:
    return 1

# INSERT HERE

def beta() -> int:
    return 2
'''
    user5 = "在 '# INSERT HERE' 后插入一个函数 gamma，返回 3。不要改动其它部分。"
    def validate5(text: str) -> Tuple[bool, str]:
        if "def gamma" not in text:
            return False, "gamma missing"
        segment = _between(text, "# INSERT HERE", "def beta")
        if "def gamma" not in segment:
            return False, "gamma not inserted after marker"
        return True, ""
    hint5 = "# INSERT HERE"
    scenarios.append(
        Scenario(
            name="marker_insert",
            target_relpath="case5/marker.py",
            initial_content=content5,
            user_prompt=user5,
            validator=validate5,
            context_hint=hint5,
            extra_system_rules="Do not move the '# INSERT HERE' marker.",
        )
    )

    overall_ok = True
    report_lines: List[str] = []
    for scenario in scenarios:
        ok, original, updated, logs = await run_scenario(client, tools, base_dir, scenario)
        overall_ok = overall_ok and ok
        report_lines.append(f"=== {scenario.name} ===")
        report_lines.append(f"target: {base_dir / scenario.target_relpath}")
        report_lines.append(f"status: {'PASS' if ok else 'FAIL'}")
        report_lines.append("---- ORIGINAL ----")
        report_lines.append(original)
        report_lines.append("---- UPDATED ----")
        report_lines.append(updated)
        report_lines.append("---- ATTEMPTS ----")
        for log in logs:
            report_lines.append(f"attempt: {log['attempt']}")
            report_lines.append(f"tool: {log['tool_name']}")
            report_lines.append(f"args_raw: {log['args_raw']}")
            report_lines.append(f"result: {log['result']}")
            report_lines.append("original_text:")
            report_lines.append(log.get("original_text", ""))
            report_lines.append("new_text:")
            report_lines.append(log.get("new_text", ""))

    report = base_dir / "report.txt"
    report.write_text("\n".join(report_lines), encoding="utf-8")

    print("LLM file_edit E2E (complex)")
    print(f"run_dir: {base_dir}")
    print(f"report: {report}")
    print(f"overall_ok: {overall_ok}")

    return 0 if overall_ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
