#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Standalone harness to validate file_edit behavior (original_text/new_text) using the
project's FileEditTool implementation.
"""
import asyncio
import sys
from datetime import datetime
from pathlib import Path

# Ensure repo root is on sys.path
REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "apps" / "brain" / "src"))

from alphomi_brain.tools.exec_tools import FileEditTool  # noqa: E402


def _now_stamp() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S")


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


async def run_edit(path: Path, original_text: str, new_text: str) -> str:
    tool = FileEditTool()
    return await tool.execute(
        {"path": str(path), "original_text": original_text, "new_text": new_text}
    )


async def main() -> int:
    base_dir = Path(__file__).resolve().parent / f"_file_ops_edit_run_{_now_stamp()}"
    base_dir.mkdir(parents=True, exist_ok=True)

    results = []

    def record(name: str, ok: bool, detail: str = "") -> None:
        status = "PASS" if ok else "FAIL"
        results.append((name, status, detail))

    # 1) Create new file (original_text empty)
    create_path = base_dir / "created.txt"
    out = await run_edit(create_path, "", "alpha\nbeta\n")
    ok = create_path.exists() and _read(create_path) == "alpha\nbeta\n"
    record("create_file", ok, out)

    # 2) Missing file with non-empty search should error
    missing_path = base_dir / "missing_edit.txt"
    out = await run_edit(missing_path, "foo\n", "bar\n")
    record("missing_file_with_search", out.startswith("Error: File not found:"), out)

    # 3) Update existing file
    update_path = base_dir / "update_target.txt"
    _write(update_path, "line1\nline2\nline3\n")
    out = await run_edit(update_path, "line2\n", "line2-updated\n")
    updated = _read(update_path)
    ok = "line2-updated\n" in updated and "line2\n" not in updated
    record("update_file", ok, out)

    # 4) Delete code (replace with empty)
    out = await run_edit(update_path, "line3\n", "")
    updated = _read(update_path)
    ok = "line3\n" not in updated
    record("delete_code", ok, out)

    # 5) Search block not found should error
    miss_path = base_dir / "context_miss.txt"
    _write(miss_path, "aaa\nbbb\n")
    out = await run_edit(miss_path, "ccc\n", "ddd\n")
    record("search_not_found", out.startswith("Error: 'original_text' block not found"), out)

    # 6) Search block matches multiple times should error
    multi_path = base_dir / "multi_match.txt"
    _write(multi_path, "dup\nx\ndup\n")
    out = await run_edit(multi_path, "dup\n", "dup2\n")
    record("search_not_unique", "matches" in out, out)

    # 7) Add file with non-ASCII path
    unicode_path = base_dir / "子目录" / "文件-测试.txt"
    out = await run_edit(unicode_path, "", "中文文件名 ok\n")
    ok = unicode_path.exists() and _read(unicode_path) == "中文文件名 ok\n"
    record("create_file_unicode_path", ok, out)

    # Print summary
    print("FileEdit Harness Results")
    for name, status, detail in results:
        print(f"- {name}: {status}")
        if status == "FAIL":
            print(f"  detail: {detail}")

    report_path = base_dir / "report.txt"
    report_lines = [f"{name}: {status}\n{detail}\n" for name, status, detail in results]
    report_path.write_text("\n".join(report_lines), encoding="utf-8")

    return 0 if all(status == "PASS" for _, status, _ in results) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
