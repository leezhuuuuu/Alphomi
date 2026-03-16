import os
import sys
import subprocess
import traceback
import io
import contextlib
from pathlib import Path
from typing import Dict, Any

# 默认工作空间
DEFAULT_WORKSPACE = Path(os.path.expanduser("~/AI-Browser-Workspace"))

class WorkspaceManager:
    def __init__(self, root_path: Path = DEFAULT_WORKSPACE):
        self.root_path = root_path
        self._ensure_exists()

    def _ensure_exists(self):
        if not self.root_path.exists():
            try:
                self.root_path.mkdir(parents=True, exist_ok=True)
            except: pass

    def get_path(self, subpath: str = "") -> str:
        return str(self.root_path / subpath)

class PythonRuntime:
    def __init__(self, workspace: WorkspaceManager):
        self.workspace = workspace
        self.globals: Dict[str, Any] = {}
        self._init_env()

    def _init_env(self):
        try:
            import pandas as pd
            import numpy as np
            import requests
            import json
            import os
            self.globals = {"pd": pd, "np": np, "requests": requests, "json": json, "os": os, "__builtins__": __builtins__}
        except: pass

    def run(self, code: str) -> str:
        cwd = self.workspace.get_path()
        original_cwd = os.getcwd()
        stdout_capture = io.StringIO()
        stderr_capture = io.StringIO()

        try:
            os.chdir(cwd)
            with contextlib.redirect_stdout(stdout_capture), contextlib.redirect_stderr(stderr_capture):
                exec(code, self.globals, {})

            output = stdout_capture.getvalue()
            errors = stderr_capture.getvalue()
            result = output + (f"\n[Stderr]:\n{errors}" if errors else "")
            return result.strip() or "[Code executed successfully with no output]"
        except Exception:
            return f"Traceback:\n{traceback.format_exc()}"
        finally:
            os.chdir(original_cwd)

class ShellRuntime:
    def __init__(self, workspace: WorkspaceManager):
        self.workspace = workspace
        self.current_cwd = self.workspace.get_path()

    def run(self, command: str) -> str:
        try:
            process = subprocess.run(
                command, shell=True, cwd=self.current_cwd,
                capture_output=True, text=True, timeout=60
            )
            # 简单的 cd 模拟 (不完美但够用)
            if command.strip().startswith("cd ") and process.returncode == 0:
                parts = command.strip().split(maxsplit=1)
                if len(parts) > 1:
                    new_path = os.path.abspath(os.path.join(self.current_cwd, parts[1]))
                    if os.path.exists(new_path) and os.path.isdir(new_path):
                        self.current_cwd = new_path

            output = process.stdout + (f"\n[Stderr]: {process.stderr}" if process.stderr else "")
            if process.returncode != 0: output += f"\n[Exit Code]: {process.returncode}"
            return output.strip() or "[Command executed]"
        except subprocess.TimeoutExpired:
            return "Error: Command timed out."
        except Exception as e:
            return f"System Error: {str(e)}"