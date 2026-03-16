import json
import os
import signal as py_signal
try:
    import pty
except ImportError:  # pragma: no cover - Windows fallback
    pty = None
import select
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Any, Optional, List

from ..core.tool_base import BaseTool, RiskLevel
from ..core.runtimes import WorkspaceManager


workspace = WorkspaceManager()


@dataclass
class ExecSession:
    proc: subprocess.Popen
    master_fd: int
    created_at: float


_EXEC_SESSIONS: Dict[int, ExecSession] = {}
_SESSION_COUNTER = 0


def _next_session_id() -> int:
    global _SESSION_COUNTER
    _SESSION_COUNTER += 1
    return _SESSION_COUNTER


def _read_available(master_fd: int, max_bytes: int = 65536) -> bytes:
    chunks: List[bytes] = []
    while True:
        rlist, _, _ = select.select([master_fd], [], [], 0)
        if not rlist:
            break
        try:
            data = os.read(master_fd, max_bytes)
        except OSError:
            break
        if not data:
            break
        chunks.append(data)
    return b"".join(chunks)


def _collect_output(proc: subprocess.Popen, master_fd: int, wait_ms: Optional[int]) -> tuple[str, bool]:
    output_chunks: List[bytes] = []
    if wait_ms is None:
        wait_ms = 1000  # default hard cap for interactive responsiveness

    deadline = time.time() + (wait_ms / 1000.0)
    finished = False

    while True:
        remaining = deadline - time.time()
        if remaining <= 0:
            break
        timeout = min(0.1, remaining)
        rlist, _, _ = select.select([master_fd], [], [], timeout)
        if rlist:
            output_chunks.append(_read_available(master_fd))
        if proc.poll() is not None:
            finished = True
            output_chunks.append(_read_available(master_fd))
            break

    output = b"".join(output_chunks).decode(errors="replace")
    return output, finished


def _trim_output(text: str, max_tokens: Optional[int]) -> str:
    if not max_tokens or max_tokens <= 0:
        return text
    # Approximate 4 chars per token.
    limit = max_tokens * 4
    if len(text) <= limit:
        return text
    return text[:limit] + "\n...[truncated]..."


def _map_ps_state(state_text: str) -> Optional[str]:
    state_text = (state_text or "").strip()
    if not state_text:
        return None
    code = state_text[0]
    if code == "R":
        return "running"
    if code in ("S", "I", "D", "T"):
        return "sleeping"
    if code == "Z":
        return "zombie"
    return "running"


def _get_popen_group_kwargs() -> Dict[str, Any]:
    if os.name == "posix":
        return {"start_new_session": True}
    if os.name == "nt" and hasattr(subprocess, "CREATE_NEW_PROCESS_GROUP"):
        return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    return {}


def _get_process_state(pid: int) -> Optional[str]:
    if os.name != "posix":
        return None
    try:
        result = subprocess.run(
            ["ps", "-o", "state=", "-p", str(pid)],
            capture_output=True,
            text=True,
            timeout=1,
        )
        if result.returncode != 0:
            return None
        return _map_ps_state(result.stdout)
    except Exception:
        return None


def _process_status(proc: subprocess.Popen) -> tuple[str, Optional[int]]:
    exit_code = proc.poll()
    if exit_code is not None:
        return "dead", exit_code
    state = _get_process_state(proc.pid)
    if state:
        return state, None
    return "running", None


def _resolve_signal(signal_name: str) -> Optional[int]:
    name = (signal_name or "").strip().upper()
    mapping = {
        "SIGINT": getattr(py_signal, "SIGINT", None),
        "SIGTERM": getattr(py_signal, "SIGTERM", None),
        "SIGKILL": getattr(py_signal, "SIGKILL", None),
    }
    return mapping.get(name)


def _send_signal(proc: subprocess.Popen, signal_name: str) -> Optional[str]:
    sig = _resolve_signal(signal_name)
    if sig is None:
        return f"Unsupported signal: {signal_name}"
    try:
        if os.name == "posix":
            try:
                pgid = os.getpgid(proc.pid)
                os.killpg(pgid, sig)
            except Exception:
                proc.send_signal(sig)
        else:
            proc.send_signal(sig)
        return None
    except Exception as e:
        return f"Failed to send signal {signal_name}: {str(e)}"


def _infer_waiting_input(status: str, output: str, wrote_input: bool) -> bool:
    if wrote_input or output:
        return False
    return status == "sleeping"


def _render_result(
    output: str,
    status: str,
    pid: Optional[int],
    exit_code: Optional[int],
    is_waiting_input: bool,
    session_id: Optional[int] = None,
    error: Optional[str] = None,
    signal_name: Optional[str] = None,
    signal_sent: Optional[bool] = None,
) -> str:
    payload: Dict[str, Any] = {
        "output": output or "",
        "status": status,
        "pid": pid,
        "exit_code": exit_code,
        "is_waiting_input": is_waiting_input,
    }
    if session_id is not None:
        payload["session_id"] = session_id
    if error:
        payload["error"] = error
    if signal_name is not None:
        payload["signal"] = signal_name
    if signal_sent is not None:
        payload["signal_sent"] = signal_sent
    return json.dumps(payload, ensure_ascii=True)


def _error_result(message: str) -> str:
    return _render_result(
        output="",
        status="dead",
        pid=None,
        exit_code=None,
        is_waiting_input=False,
        error=message,
    )


def _normalize_workdir(workdir: Optional[str]) -> str:
    if workdir:
        return os.path.abspath(os.path.expanduser(workdir))
    return workspace.get_path()


class ExecCommandTool(BaseTool):
    name = "exec_command"
    description = (
        "Runs a command in a PTY and returns a JSON object with output, status, pid, exit_code, "
        "is_waiting_input, and optional session_id for ongoing interaction."
    )

    @property
    def parameters(self):
        return {
            "cmd": {"type": "string", "description": "Shell command to execute."},
            "justification": {"type": "string", "description": "Explanation for elevated permissions."},
            "login": {"type": "boolean", "description": "Whether to run as a login shell."},
            "max_output_tokens": {"type": "integer", "description": "Maximum output tokens to return."},
            "sandbox_permissions": {
                "type": "string",
                "enum": ["use_default", "require_escalated"],
                "description": "Sandbox permission requirement.",
            },
            "shell": {"type": "string", "description": "Shell binary to launch."},
            "tty": {"type": "boolean", "description": "Whether to allocate a TTY."},
            "workdir": {"type": "string", "description": "Working directory for the command."},
            "yield_time_ms": {"type": "integer", "description": "Wait time (ms) for output before yielding."},
        }

    @property
    def required_params(self):
        return ["cmd"]

    async def execute(self, args: Dict[str, Any], context=None) -> str:
        cmd = args.get("cmd", "")
        if not cmd:
            return _error_result("cmd is required.")

        shell_bin = args.get("shell")
        workdir = _normalize_workdir(args.get("workdir"))
        yield_time_ms = args.get("yield_time_ms")
        max_output_tokens = args.get("max_output_tokens")

        return self._run_pty(cmd, workdir, shell_bin, yield_time_ms, max_output_tokens)

    def _run_pty(
        self,
        cmd: str,
        workdir: str,
        shell_bin: Optional[str],
        yield_time_ms: Optional[int],
        max_output_tokens: Optional[int],
    ) -> str:
        if pty is None:
            return self._run_pipes(cmd, workdir, shell_bin, yield_time_ms, max_output_tokens)
        try:
            master_fd, slave_fd = pty.openpty()
            proc = subprocess.Popen(
                cmd,
                shell=True,
                cwd=workdir,
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
                executable=shell_bin,
                **_get_popen_group_kwargs(),
            )
            os.close(slave_fd)

            output, finished = _collect_output(proc, master_fd, yield_time_ms)
            output = _trim_output(output, max_output_tokens).strip()

            if finished:
                status = "dead"
                exit_code = proc.returncode
                try:
                    os.close(master_fd)
                except OSError:
                    pass
                return _render_result(
                    output=output,
                    status=status,
                    pid=proc.pid,
                    exit_code=exit_code,
                    is_waiting_input=False,
                )
            status, exit_code = _process_status(proc)
            if status == "dead":
                try:
                    os.close(master_fd)
                except OSError:
                    pass
                return _render_result(
                    output=output,
                    status=status,
                    pid=proc.pid,
                    exit_code=exit_code,
                    is_waiting_input=False,
                )
            session_id = _next_session_id()
            _EXEC_SESSIONS[session_id] = ExecSession(proc=proc, master_fd=master_fd, created_at=time.time())
            is_waiting_input = _infer_waiting_input(status, output, wrote_input=False)
            return _render_result(
                output=output,
                status=status,
                pid=proc.pid,
                exit_code=exit_code,
                is_waiting_input=is_waiting_input,
                session_id=session_id,
            )
        except Exception as e:
            return _error_result(f"System Error: {str(e)}")

    def _run_pipes(
        self,
        cmd: str,
        workdir: str,
        shell_bin: Optional[str],
        yield_time_ms: Optional[int],
        max_output_tokens: Optional[int],
    ) -> str:
        timeout = 60.0 if yield_time_ms is None else max(yield_time_ms / 1000.0, 0.001)
        try:
            proc = subprocess.Popen(
                cmd,
                shell=True,
                cwd=workdir,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                executable=shell_bin,
                text=True,
                **_get_popen_group_kwargs(),
            )
            try:
                stdout, stderr = proc.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                proc.kill()
                return _render_result(
                    output="",
                    status="dead",
                    pid=proc.pid,
                    exit_code=None,
                    is_waiting_input=False,
                    error="Command timed out.",
                )

            output = (stdout or "") + (stderr or "")
            output = _trim_output(output, max_output_tokens).strip()
            return _render_result(
                output=output,
                status="dead",
                pid=proc.pid,
                exit_code=proc.returncode,
                is_waiting_input=False,
            )
        except Exception as e:
            return _error_result(f"System Error: {str(e)}")

    def calculate_risk(self, args: Dict[str, Any]) -> RiskLevel:
        cmd = (args.get("cmd") or "").strip().lower()
        if not cmd:
            return RiskLevel.DANGEROUS

        dangerous_markers = [
            "sudo ",
            "rm -rf /",
            "mkfs",
            "dd ",
            "shutdown",
            "reboot",
            "| sh",
            "| bash",
            ":(){",
        ]
        if any(marker in cmd for marker in dangerous_markers):
            return RiskLevel.DANGEROUS

        safe_prefixes = (
            "ls",
            "pwd",
            "cat",
            "rg",
            "grep",
            "find",
            "diff",
            "stat",
            "head",
            "tail",
        )
        if cmd.startswith(safe_prefixes):
            return RiskLevel.SAFE

        return RiskLevel.RISKY


class WriteStdinTool(BaseTool):
    name = "write_stdin"
    description = (
        "Interact with an existing session. Provide 'chars' to write to stdin, "
        "or leave 'chars' empty to just read more output from the running command. "
        "Optionally use poll_delay_ms to wait before reading, or signal to send SIGINT/SIGTERM/SIGKILL. "
        "Returns a JSON object with output, status, pid, exit_code, is_waiting_input, and session_id."
    )

    @property
    def parameters(self):
        return {
            "session_id": {"type": "integer", "description": "Identifier of the running exec session."},
            "chars": {"type": "string", "description": "Bytes to write to stdin (may be empty)."},
            "signal": {
                "type": "string",
                "enum": ["SIGINT", "SIGTERM", "SIGKILL"],
                "description": "Send a system signal to the process.",
            },
            "poll_delay_ms": {
                "type": "integer",
                "description": "Delay before reading output (ms).",
            },
            "max_output_tokens": {"type": "integer", "description": "Maximum output tokens to return."},
            "yield_time_ms": {"type": "integer", "description": "Wait time (ms) for output."},
        }

    @property
    def required_params(self):
        return ["session_id"]

    async def execute(self, args: Dict[str, Any], context=None) -> str:
        session_id = args.get("session_id")
        if session_id is None:
            return _error_result("session_id is required.")
        try:
            session_id = int(session_id)
        except (TypeError, ValueError):
            return _error_result("session_id must be an integer.")
        chars = args.get("chars", "")
        signal_name = args.get("signal")
        poll_delay_ms = args.get("poll_delay_ms")
        yield_time_ms = args.get("yield_time_ms")
        max_output_tokens = args.get("max_output_tokens")

        session = _EXEC_SESSIONS.get(session_id)
        if not session:
            return _error_result(f"session {session_id} not found.")

        try:
            wrote_input = bool(chars)
            signal_sent = None
            if signal_name:
                err = _send_signal(session.proc, signal_name)
                if err:
                    return _render_result(
                        output="",
                        status="dead" if session.proc.poll() is not None else "running",
                        pid=session.proc.pid,
                        exit_code=session.proc.poll(),
                        is_waiting_input=False,
                        session_id=session_id,
                        error=err,
                        signal_name=signal_name,
                        signal_sent=False,
                    )
                signal_sent = True
            if chars:
                os.write(session.master_fd, chars.encode())

            if poll_delay_ms is not None:
                try:
                    delay_ms = max(int(poll_delay_ms), 0)
                except (TypeError, ValueError):
                    return _error_result("poll_delay_ms must be an integer.")
                if delay_ms > 0:
                    time.sleep(delay_ms / 1000.0)

            output, finished = _collect_output(session.proc, session.master_fd, yield_time_ms)
            output = _trim_output(output, max_output_tokens).strip()

            if finished:
                status = "dead"
                exit_code = session.proc.returncode
                _EXEC_SESSIONS.pop(session_id, None)
                try:
                    os.close(session.master_fd)
                except OSError:
                    pass
                return _render_result(
                    output=output,
                    status=status,
                    pid=session.proc.pid,
                    exit_code=exit_code,
                    is_waiting_input=False,
                    session_id=session_id,
                    signal_name=signal_name,
                    signal_sent=signal_sent,
                )
            status, exit_code = _process_status(session.proc)
            if status == "dead":
                _EXEC_SESSIONS.pop(session_id, None)
                try:
                    os.close(session.master_fd)
                except OSError:
                    pass
                return _render_result(
                    output=output,
                    status=status,
                    pid=session.proc.pid,
                    exit_code=exit_code,
                    is_waiting_input=False,
                    session_id=session_id,
                    signal_name=signal_name,
                    signal_sent=signal_sent,
                )
            is_waiting_input = _infer_waiting_input(status, output, wrote_input=wrote_input)
            return _render_result(
                output=output,
                status=status,
                pid=session.proc.pid,
                exit_code=exit_code,
                is_waiting_input=is_waiting_input,
                session_id=session_id,
                signal_name=signal_name,
                signal_sent=signal_sent,
            )
        except Exception as e:
            return _error_result(f"System Error: {str(e)}")

    def calculate_risk(self, args: Dict[str, Any]) -> RiskLevel:
        return RiskLevel.RISKY


class FileEditTool(BaseTool):
    name = "file_edit"
    description = """
    Edit a file by replacing a text block.
    Arguments:
    - path: The absolute path to the file.
    - original_text: The exact text block to be replaced. Must match file content exactly (including whitespace).
    - new_text: The new text to insert.
    """

    @property
    def parameters(self):
        return {
            "path": {
                "type": "string",
                "description": "Absolute path to the file to edit.",
            },
            "original_text": {
                "type": "string",
                "description": "The exact block of text to be replaced. Leave empty to create a new file.",
            },
            "new_text": {
                "type": "string",
                "description": "The new text to insert.",
            },
        }

    @property
    def required_params(self):
        return ["path", "new_text"]

    async def execute(self, args: Dict[str, Any], context=None) -> str:
        path_str = (args.get("path") or "").strip()
        original_text = args.get("original_text", "")
        new_text = args.get("new_text", "")

        if not path_str:
            return "Error: 'path' argument is required."
        if new_text is None:
            new_text = ""
        if original_text is None:
            original_text = ""

        file_path = Path(path_str)

        # 1. 处理文件不存在的情况 (创建新文件)
        # 如果是创建文件，通常 original_text 为空
        if not file_path.exists():
            # 如果提供了 original_text 且不为空，说明想修改但文件不在
            if original_text and original_text.strip():
                return f"Error: File not found: {path_str}"

            try:
                file_path.parent.mkdir(parents=True, exist_ok=True)
                content = new_text
                if content.startswith("\n"):
                    content = content[1:]
                file_path.write_text(content, encoding="utf-8")
                return f"Successfully created file: {path_str}"
            except Exception as e:
                return f"System Error creating file: {e}"

        # 2. 读取原文件
        try:
            file_content = file_path.read_text(encoding="utf-8")
        except Exception as e:
            return f"System Error reading file: {e}"

        # 3. 核心替换逻辑
        # 场景 A: 原文为空，但文件存在 -> 强制要求锚点，除非文件是空的
        if not original_text:
            if not file_content.strip():
                pass
            else:
                return "Error: 'original_text' is required to edit an existing non-empty file."

        # 4. 查找与替换
        if original_text and original_text not in file_content:
            stripped_search = original_text.strip("\n")
            if stripped_search and stripped_search in file_content:
                original_text = stripped_search
            else:
                snippet = original_text[:50].replace("\n", "\\n")
                return (
                    "Error: 'original_text' block not found in file.\n"
                    "Please ensure you copied the EXACT indentation and content from the file.\n"
                    f"Your search block started with: '{snippet}...'"
                )

        # 5. 检查唯一性
        if original_text:
            count = file_content.count(original_text)
            if count > 1:
                return (
                    f"Error: 'original_text' matches {count} times in the file. "
                    "Please provide more context lines to make it unique."
                )

            new_content = file_content.replace(original_text, new_text, 1)
        else:
            new_content = new_text

        try:
            file_path.write_text(new_content, encoding="utf-8")
            return "Successfully edited file."
        except Exception as e:
            return f"System Error writing file: {e}"

    def calculate_risk(self, args: Dict[str, Any]) -> RiskLevel:
        return RiskLevel.RISKY
