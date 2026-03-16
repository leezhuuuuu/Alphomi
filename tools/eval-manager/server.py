#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from threading import RLock, Thread
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
import uvicorn


ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS_ROOT = ROOT / "artifacts" / "webarena_verified"
MANAGER_DIR = ARTIFACTS_ROOT / "_manager"
RUNS_DIR = MANAGER_DIR / "runs"
STATE_PATH = MANAGER_DIR / "state.json"
CATALOG_PATH = MANAGER_DIR / "task_catalog.json"
SERIAL_STATE_PATH = MANAGER_DIR / "serial_state.json"
RUNNER_SCRIPT = ROOT / "scripts" / "run_webarena_verified_full_eval.py"


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _mkdirs() -> None:
    MANAGER_DIR.mkdir(parents=True, exist_ok=True)
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    ARTIFACTS_ROOT.mkdir(parents=True, exist_ok=True)


def _normalize_csv(raw: str) -> str:
    parts = [part.strip() for part in (raw or "").split(",") if part.strip()]
    return ",".join(parts)


def _is_pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _safe_load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _tail_text(path: Path, max_chars: int = 20_000) -> str:
    if not path.exists():
        return ""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return ""
    if len(text) <= max_chars:
        return text
    return text[-max_chars:]


def _parse_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except Exception:
        return False


@dataclass
class RunRecord:
    run_id: str
    name: str
    output_dir: str
    command: list[str]
    log_path: str
    pid: int | None
    status: str
    created_at: str
    started_at: str | None
    ended_at: str | None
    updated_at: str
    return_code: int | None


class CreateRunRequest(BaseModel):
    name: str = Field(default="", description="Optional display name")
    task_ids: str = Field(default="", description="Comma-separated task IDs")
    exclude_sites: str = Field(default="map,wikipedia", description="Comma-separated site names")
    timeout_per_task: int = Field(default=420, ge=30, le=7200)
    keep_sites_running: bool = False
    no_resume: bool = False
    only_unsuccessful: bool = False
    output_dir: str = Field(default="", description="Optional absolute/relative output dir")


class CreateSerialSessionRequest(BaseModel):
    name: str = Field(default="", description="Serial session name")
    task_ids: str = Field(default="", description="Comma-separated task IDs; empty means all feasible catalog tasks")
    exclude_sites: str = Field(default="map,wikipedia", description="Comma-separated excluded sites")
    timeout_per_task: int = Field(default=420, ge=30, le=7200)
    max_retries: int = Field(default=2, ge=0, le=20, description="Retries per task after first attempt")
    auto_skip: bool = True
    keep_sites_running: bool = False
    only_unsuccessful: bool = True
    output_dir: str = Field(default="", description="Optional output directory")


class ActionResponse(BaseModel):
    ok: bool
    message: str


class EvalManager:
    def __init__(self) -> None:
        _mkdirs()
        self._lock = RLock()
        self._runs: dict[str, RunRecord] = {}
        self._procs: dict[str, subprocess.Popen[str]] = {}
        self._task_catalog: list[dict[str, Any]] = []
        self._catalog_error: str = ""
        self._success_cache_ids: set[int] = set()
        self._success_cache_at: float = 0.0
        self._load_state()
        self.ensure_catalog(force_refresh=False)

    def _load_state(self) -> None:
        payload = _safe_load_json(STATE_PATH, {"runs": []})
        for item in payload.get("runs", []):
            try:
                record = RunRecord(**item)
            except TypeError:
                continue
            if record.pid and record.status in {"running", "paused"} and not _is_pid_alive(record.pid):
                record.status = "stopped"
                record.ended_at = record.ended_at or _now()
                record.updated_at = _now()
            self._runs[record.run_id] = record

    def _save_state(self) -> None:
        rows = [asdict(run) for run in sorted(self._runs.values(), key=lambda x: x.created_at, reverse=True)]
        STATE_PATH.write_text(json.dumps({"runs": rows}, ensure_ascii=False, indent=2), encoding="utf-8")

    def _invalidate_success_cache(self) -> None:
        self._success_cache_at = 0.0

    def _refresh_run(self, run: RunRecord) -> None:
        if run.status not in {"running", "paused"} or run.pid is None:
            return
        proc = self._procs.get(run.run_id)
        if proc is not None:
            rc = proc.poll()
            if rc is None:
                return
            run.return_code = rc
            run.status = "finished" if rc == 0 else "failed"
            run.ended_at = _now()
            run.updated_at = _now()
            self._procs.pop(run.run_id, None)
            self._save_state()
            return
        if not _is_pid_alive(run.pid):
            run.status = "stopped"
            run.ended_at = run.ended_at or _now()
            run.updated_at = _now()
            self._save_state()

    def _output_dir_for(self, req: CreateRunRequest, run_id: str) -> Path:
        if req.output_dir.strip():
            raw = Path(req.output_dir.strip())
            return raw if raw.is_absolute() else (ROOT / raw)
        name = req.name.strip() or f"run_{run_id[:8]}"
        safe = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "_" for ch in name)[:48]
        ts = time.strftime("%Y%m%d_%H%M%S")
        return ARTIFACTS_ROOT / f"{safe}_{ts}"

    def _extract_command_option(self, cmd: list[str], flag: str, default: str = "") -> str:
        if flag not in cmd:
            return default
        idx = cmd.index(flag)
        if idx + 1 >= len(cmd):
            return default
        return str(cmd[idx + 1])

    def _target_task_ids_for_run(self, output_dir: Path) -> set[int]:
        raw = _safe_load_json(output_dir / "tasks.json", [])
        task_ids: set[int] = set()
        if isinstance(raw, list):
            for item in raw:
                if not isinstance(item, dict):
                    continue
                tid = _parse_int(item.get("task_id"))
                if tid is not None:
                    task_ids.add(tid)
        return task_ids

    def _current_progress_task_id(self, output_dir: Path) -> int | None:
        progress = _safe_load_json(output_dir / "progress.json", {})
        return _parse_int(progress.get("task_id"))

    def resolve_task_ids(self, task_ids_csv: str, exclude_sites_csv: str) -> list[int]:
        catalog = self.ensure_catalog(force_refresh=False)
        catalog_map = {int(row["task_id"]): row for row in catalog}
        excluded_sites = {site.strip().lower() for site in _normalize_csv(exclude_sites_csv).split(",") if site.strip()}

        if _normalize_csv(task_ids_csv):
            rows: list[int] = []
            seen: set[int] = set()
            for part in _normalize_csv(task_ids_csv).split(","):
                tid = _parse_int(part)
                if tid is None or tid in seen:
                    continue
                if tid not in catalog_map:
                    continue
                if excluded_sites:
                    task_sites = {str(site).lower() for site in catalog_map[tid].get("sites", [])}
                    if task_sites & excluded_sites:
                        continue
                seen.add(tid)
                rows.append(tid)
            return rows

        rows: list[int] = []
        for item in catalog:
            tid = int(item["task_id"])
            if excluded_sites:
                task_sites = {str(site).lower() for site in item.get("sites", [])}
                if task_sites & excluded_sites:
                    continue
            rows.append(tid)
        return rows

    def create_run(self, req: CreateRunRequest) -> RunRecord:
        if not RUNNER_SCRIPT.exists():
            raise HTTPException(status_code=500, detail=f"Runner script missing: {RUNNER_SCRIPT}")
        with self._lock:
            run_id = str(uuid.uuid4())
            output_dir = self._output_dir_for(req, run_id)
            output_dir.mkdir(parents=True, exist_ok=True)
            log_path = RUNS_DIR / f"{run_id}.log"
            log_handle = log_path.open("a", encoding="utf-8")

            cmd = [
                "python3",
                "-u",
                str(RUNNER_SCRIPT),
                "--output-dir",
                str(output_dir),
                "--timeout-per-task",
                str(req.timeout_per_task),
            ]
            exclude_sites = _normalize_csv(req.exclude_sites)
            task_ids = _normalize_csv(req.task_ids)
            if req.only_unsuccessful:
                resolved = self.resolve_task_ids(task_ids, exclude_sites)
                if not resolved:
                    raise HTTPException(status_code=400, detail="No tasks matched run filters")
                successful_ids = self.successful_task_ids_global(force_refresh=True)
                filtered = [tid for tid in resolved if tid not in successful_ids]
                if not filtered:
                    raise HTTPException(status_code=400, detail="All selected tasks already succeeded; nothing to run")
                task_ids = ",".join(str(tid) for tid in filtered)

            if task_ids:
                cmd.extend(["--task-ids", task_ids])
            if exclude_sites:
                cmd.extend(["--exclude-sites", exclude_sites])
            if req.keep_sites_running:
                cmd.append("--keep-sites-running")
            if req.no_resume:
                cmd.append("--no-resume")

            proc = subprocess.Popen(
                cmd,
                cwd=str(ROOT),
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                text=True,
                preexec_fn=os.setsid,
            )
            self._procs[run_id] = proc

            now = _now()
            record = RunRecord(
                run_id=run_id,
                name=req.name.strip() or f"run-{run_id[:8]}",
                output_dir=str(output_dir),
                command=cmd,
                log_path=str(log_path),
                pid=proc.pid,
                status="running",
                created_at=now,
                started_at=now,
                ended_at=None,
                updated_at=now,
                return_code=None,
            )
            self._runs[run_id] = record
            self._save_state()
            return record

    def list_runs(self) -> list[RunRecord]:
        with self._lock:
            rows = sorted(self._runs.values(), key=lambda x: x.created_at, reverse=True)
            for row in rows:
                self._refresh_run(row)
            return rows

    def get_run(self, run_id: str) -> RunRecord:
        with self._lock:
            run = self._runs.get(run_id)
            if run is None:
                raise HTTPException(status_code=404, detail=f"Run not found: {run_id}")
            self._refresh_run(run)
            return run

    def _signal_run(self, run_id: str, sig: int, next_status: str, action: str) -> ActionResponse:
        with self._lock:
            run = self.get_run(run_id)
            if run.pid is None:
                raise HTTPException(status_code=400, detail=f"Run {run_id} has no pid")
            if not _is_pid_alive(run.pid):
                run.status = "stopped"
                run.ended_at = run.ended_at or _now()
                run.updated_at = _now()
                self._save_state()
                raise HTTPException(status_code=400, detail=f"Run {run_id} is not alive")
            try:
                os.killpg(run.pid, sig)
            except ProcessLookupError:
                run.status = "stopped"
                run.ended_at = run.ended_at or _now()
                run.updated_at = _now()
                self._save_state()
                raise HTTPException(status_code=400, detail=f"Run {run_id} already exited")
            run.status = next_status
            run.updated_at = _now()
            if next_status in {"stopped", "finished", "failed"}:
                run.ended_at = run.ended_at or _now()
            self._save_state()
            return ActionResponse(ok=True, message=f"{action} sent to run {run_id}")

    def pause_run(self, run_id: str) -> ActionResponse:
        return self._signal_run(run_id, signal.SIGSTOP, "paused", "pause")

    def resume_run(self, run_id: str) -> ActionResponse:
        return self._signal_run(run_id, signal.SIGCONT, "running", "resume")

    def stop_run(self, run_id: str) -> ActionResponse:
        with self._lock:
            run = self.get_run(run_id)
            if run.pid is None:
                raise HTTPException(status_code=400, detail=f"Run {run_id} has no pid")
            if not _is_pid_alive(run.pid):
                run.status = "stopped"
                run.ended_at = run.ended_at or _now()
                run.updated_at = _now()
                self._save_state()
                return ActionResponse(ok=True, message=f"Run {run_id} already stopped")
            try:
                os.killpg(run.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            run.status = "stopped"
            run.ended_at = _now()
            run.updated_at = _now()
            self._save_state()
            return ActionResponse(ok=True, message=f"stop sent to run {run_id}")

    def read_run_log(self, run_id: str) -> str:
        run = self.get_run(run_id)
        return _tail_text(Path(run.log_path))

    def _iter_task_dirs(self, output_dir: Path) -> list[Path]:
        if not output_dir.exists():
            return []
        rows: list[Path] = []
        for item in output_dir.iterdir():
            if item.is_dir() and item.name.isdigit():
                rows.append(item)
        rows.sort(key=lambda p: int(p.name))
        return rows

    def _classify_failure(self, detail: str) -> str:
        lowered = detail.lower()
        if "model did not return valid json" in lowered:
            return "invalid_json"
        if "driver request failed" in lowered or "err_connection_refused" in lowered:
            return "driver_request_failed"
        if "rate limit" in lowered or "429" in lowered or "usage limit exceeded" in lowered:
            return "rate_limited"
        if "timed out" in lowered:
            return "timeout"
        return "other"

    def collect_task_rows(self, run_id: str) -> list[dict[str, Any]]:
        run = self.get_run(run_id)
        output_dir = Path(run.output_dir)
        rows: list[dict[str, Any]] = []

        target_tasks_path = output_dir / "tasks.json"
        target_tasks_raw = _safe_load_json(target_tasks_path, [])
        target_tasks: dict[int, dict[str, Any]] = {}
        if isinstance(target_tasks_raw, list):
            for item in target_tasks_raw:
                if not isinstance(item, dict):
                    continue
                tid = _parse_int(item.get("task_id"))
                if tid is None:
                    continue
                target_tasks[tid] = item

        discovered_dirs = {int(p.name) for p in self._iter_task_dirs(output_dir)}
        all_task_ids = set(target_tasks.keys()) | discovered_dirs
        current_task_id = self._current_progress_task_id(output_dir)

        for task_id in sorted(all_task_ids):
            task_dir = output_dir / str(task_id)
            task_meta = target_tasks.get(task_id, {})
            has_agent = (task_dir / "agent_response.json").exists()
            has_eval = (task_dir / "eval_result.json").exists()
            has_outputs = (task_dir / "agent_response.json").exists() and (task_dir / "network.har").exists()

            agent = _safe_load_json(task_dir / "agent_response.json", {})
            eval_result = _safe_load_json(task_dir / "eval_result.json", {})

            raw_status = str(agent.get("status") or "PENDING").upper() if has_agent else "PENDING"
            display_status = raw_status
            error_details = str(agent.get("error_details") or "") if has_agent else ""

            is_current = current_task_id == task_id
            if is_current and run.status == "running":
                display_status = "RUNNING"
            elif is_current and run.status == "paused":
                display_status = "PAUSED"

            if display_status == "SUCCESS":
                failure_class = "none"
            elif display_status in {"PENDING", "RUNNING", "PAUSED"}:
                failure_class = display_status.lower()
            else:
                failure_class = self._classify_failure(error_details)

            row = {
                "task_id": task_id,
                "sites": list(task_meta.get("sites", [])) if isinstance(task_meta.get("sites"), list) else [],
                "intent": str(task_meta.get("intent") or ""),
                "start_urls": list(task_meta.get("start_urls", [])) if isinstance(task_meta.get("start_urls"), list) else [],
                "expected_task_type": str(task_meta.get("expected_task_type") or ""),
                "agent_status": display_status,
                "raw_agent_status": raw_status,
                "error_details": error_details,
                "failure_class": failure_class,
                "eval_status": str(eval_result.get("status") or ""),
                "eval_score": eval_result.get("score"),
                "has_outputs": has_outputs,
                "has_agent_response": has_agent,
                "has_eval_result": has_eval,
                "task_dir": str(task_dir),
                "in_target_run": task_id in target_tasks,
                "is_current": is_current,
            }
            rows.append(row)
        return rows

    def run_metrics(self, run_id: str) -> dict[str, Any]:
        run = self.get_run(run_id)
        output_dir = Path(run.output_dir)
        progress = _safe_load_json(output_dir / "progress.json", {})
        summary = _safe_load_json(output_dir / "summary.json", {})
        eval_results = _safe_load_json(output_dir / "eval_results.json", {})
        tasks = self.collect_task_rows(run_id)

        failure_groups: dict[str, int] = {}
        success_count = 0
        pending_count = 0
        completed_count = 0
        for row in tasks:
            if row["raw_agent_status"] == "SUCCESS":
                success_count += 1
            if row["agent_status"] in {"PENDING", "RUNNING", "PAUSED"} and row["in_target_run"]:
                pending_count += 1
            if row["has_agent_response"]:
                completed_count += 1
            key = row["failure_class"]
            failure_groups[key] = failure_groups.get(key, 0) + 1

        target_count = len(self._target_task_ids_for_run(output_dir))
        if target_count <= 0:
            target_count = int(progress.get("total") or summary.get("task_count") or 0)

        current_index = int(progress.get("current_index") or 0)
        eval_overall = (eval_results.get("summary") or {}).get("overall") if isinstance(eval_results, dict) else None

        return {
            "run_id": run_id,
            "status": run.status,
            "output_dir": run.output_dir,
            "progress": progress,
            "total_target_tasks": target_count,
            "current_index": current_index,
            "completed_task_dirs": completed_count,
            "agent_success_count": success_count,
            "pending_count": pending_count,
            "failure_groups": failure_groups,
            "summary_json": summary,
            "eval_overall": eval_overall,
        }

    def retry_failed(self, run_id: str, reason: str) -> RunRecord:
        base = self.get_run(run_id)
        rows = self.collect_task_rows(run_id)
        reason_key = reason.strip().lower()
        target_ids: list[int] = []
        for row in rows:
            if row["raw_agent_status"] == "SUCCESS":
                continue
            if reason_key and reason_key not in {"all", row["failure_class"]}:
                continue
            target_ids.append(int(row["task_id"]))
        if not target_ids:
            raise HTTPException(status_code=400, detail=f"No failed tasks matched reason={reason}")

        req = CreateRunRequest(
            name=f"{base.name}-retry-{reason_key or 'all'}",
            task_ids=",".join(str(tid) for tid in sorted(target_ids)),
            exclude_sites="",
            timeout_per_task=420,
            keep_sites_running=False,
            no_resume=False,
            output_dir=base.output_dir,
        )

        req.exclude_sites = self._extract_command_option(base.command, "--exclude-sites", "")
        timeout_raw = self._extract_command_option(base.command, "--timeout-per-task", "420")
        req.timeout_per_task = _parse_int(timeout_raw) or 420
        req.keep_sites_running = "--keep-sites-running" in base.command

        return self.create_run(req)

    def _normalize_catalog_rows(self, raw: Any) -> list[dict[str, Any]]:
        if not isinstance(raw, list):
            return []
        by_id: dict[int, dict[str, Any]] = {}
        for item in raw:
            if not isinstance(item, dict):
                continue
            task_id = _parse_int(item.get("task_id"))
            if task_id is None:
                continue
            sites = [str(site) for site in item.get("sites", []) if isinstance(site, str)] if isinstance(item.get("sites"), list) else []
            start_urls = (
                [str(url) for url in item.get("start_urls", []) if isinstance(url, str)]
                if isinstance(item.get("start_urls"), list)
                else []
            )
            row = {
                "task_id": task_id,
                "sites": sites,
                "intent": str(item.get("intent") or ""),
                "start_urls": start_urls,
                "intent_template_id": _parse_int(item.get("intent_template_id")),
            }
            if task_id not in by_id or len(row["intent"]) > len(by_id[task_id].get("intent", "")):
                by_id[task_id] = row
        rows = list(by_id.values())
        rows.sort(key=lambda r: int(r["task_id"]))
        return rows

    def _discover_tasks_json_candidates(self) -> list[Path]:
        candidates: list[Path] = []
        seen: set[str] = set()

        for run in self._runs.values():
            path = Path(run.output_dir) / "tasks.json"
            key = str(path.resolve()) if path.exists() else str(path)
            if path.exists() and key not in seen:
                seen.add(key)
                candidates.append(path)

        if ARTIFACTS_ROOT.exists():
            for child in ARTIFACTS_ROOT.iterdir():
                if not child.is_dir() or child.name == "_manager":
                    continue
                path = child / "tasks.json"
                key = str(path.resolve()) if path.exists() else str(path)
                if path.exists() and key not in seen:
                    seen.add(key)
                    candidates.append(path)

        return candidates

    def _load_catalog_from_candidate_files(self) -> list[dict[str, Any]]:
        best_rows: list[dict[str, Any]] = []
        for path in self._discover_tasks_json_candidates():
            rows = self._normalize_catalog_rows(_safe_load_json(path, []))
            if len(rows) > len(best_rows):
                best_rows = rows
        return best_rows

    def _generate_catalog_via_cli(self) -> list[dict[str, Any]]:
        tmp_path = CATALOG_PATH.with_suffix(".tmp.json")
        cmd = [
            "uvx",
            "webarena-verified",
            "dataset-get",
            "--fields",
            "task_id,sites,intent,start_urls,intent_template_id",
            "--output",
            str(tmp_path),
        ]
        completed = subprocess.run(
            cmd,
            cwd=str(ROOT),
            text=True,
            capture_output=True,
            timeout=30 * 60,
            check=False,
        )
        if completed.returncode != 0:
            stderr = (completed.stderr or "").strip()
            stdout = (completed.stdout or "").strip()
            msg = stderr if stderr else stdout
            raise RuntimeError(f"Failed to export catalog via CLI: {msg[:800]}")

        rows = self._normalize_catalog_rows(_safe_load_json(tmp_path, []))
        if not rows:
            raise RuntimeError("CLI returned empty task catalog")
        tmp_path.replace(CATALOG_PATH)
        return rows

    def ensure_catalog(self, force_refresh: bool = False) -> list[dict[str, Any]]:
        with self._lock:
            if self._task_catalog and not force_refresh:
                return [dict(row) for row in self._task_catalog]

            rows: list[dict[str, Any]] = []
            self._catalog_error = ""

            if not force_refresh and CATALOG_PATH.exists():
                rows = self._normalize_catalog_rows(_safe_load_json(CATALOG_PATH, []))

            if not rows:
                rows = self._load_catalog_from_candidate_files()
                if rows:
                    CATALOG_PATH.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")

            should_try_cli = force_refresh or len(rows) < 700
            if should_try_cli:
                try:
                    rows = self._generate_catalog_via_cli()
                except Exception as exc:
                    self._catalog_error = str(exc)
                    if not rows:
                        raise HTTPException(status_code=500, detail=f"Task catalog unavailable: {self._catalog_error}")

            self._task_catalog = rows
            return [dict(row) for row in self._task_catalog]

    def catalog_rows(self, run_id: str | None = None) -> list[dict[str, Any]]:
        catalog = self.ensure_catalog(force_refresh=False)
        if not run_id:
            rows: list[dict[str, Any]] = []
            for base in catalog:
                row = dict(base)
                row.update(
                    {
                        "agent_status": "UNTRACKED",
                        "raw_agent_status": "UNTRACKED",
                        "eval_status": "",
                        "eval_score": None,
                        "failure_class": "untracked",
                        "error_details": "",
                        "has_outputs": False,
                        "has_agent_response": False,
                        "has_eval_result": False,
                        "in_target_run": False,
                        "is_current": False,
                        "task_dir": "",
                    }
                )
                rows.append(row)
            return rows

        run = self.get_run(run_id)
        run_rows = self.collect_task_rows(run_id)
        run_map = {int(row["task_id"]): row for row in run_rows}
        target_ids = self._target_task_ids_for_run(Path(run.output_dir))
        global_success_ids = self.successful_task_ids_global()
        known_ids = {int(row["task_id"]) for row in catalog}

        rows: list[dict[str, Any]] = []
        for base in catalog:
            task_id = int(base["task_id"])
            merged = run_map.get(task_id)
            in_target = task_id in target_ids
            row = dict(base)
            if merged is not None:
                row.update(
                    {
                        "agent_status": merged["agent_status"],
                        "raw_agent_status": merged["raw_agent_status"],
                        "eval_status": merged["eval_status"],
                        "eval_score": merged["eval_score"],
                        "failure_class": merged["failure_class"],
                        "error_details": merged["error_details"],
                        "has_outputs": merged["has_outputs"],
                        "has_agent_response": merged["has_agent_response"],
                        "has_eval_result": merged["has_eval_result"],
                        "in_target_run": merged["in_target_run"],
                        "is_current": merged["is_current"],
                        "task_dir": merged["task_dir"],
                    }
                )
            elif in_target:
                row.update(
                    {
                        "agent_status": "PENDING",
                        "raw_agent_status": "PENDING",
                        "eval_status": "",
                        "eval_score": None,
                        "failure_class": "pending",
                        "error_details": "",
                        "has_outputs": False,
                        "has_agent_response": False,
                        "has_eval_result": False,
                        "in_target_run": True,
                        "is_current": False,
                        "task_dir": str(Path(run.output_dir) / str(task_id)),
                    }
                )
            else:
                if task_id in global_success_ids:
                    row.update(
                        {
                            "agent_status": "SUCCESS",
                            "raw_agent_status": "SUCCESS",
                            "eval_status": "success",
                            "eval_score": 1.0,
                            "failure_class": "none",
                            "error_details": "",
                            "has_outputs": True,
                            "has_agent_response": True,
                            "has_eval_result": True,
                            "in_target_run": False,
                            "is_current": False,
                            "task_dir": str(Path(run.output_dir) / str(task_id)),
                        }
                    )
                else:
                    row.update(
                        {
                            "agent_status": "NOT_IN_RUN",
                            "raw_agent_status": "NOT_IN_RUN",
                            "eval_status": "",
                            "eval_score": None,
                            "failure_class": "not_in_run",
                            "error_details": "",
                            "has_outputs": False,
                            "has_agent_response": False,
                            "has_eval_result": False,
                            "in_target_run": False,
                            "is_current": False,
                            "task_dir": str(Path(run.output_dir) / str(task_id)),
                        }
                    )
            rows.append(row)

        for task_id, merged in run_map.items():
            if task_id in known_ids:
                continue
            rows.append(
                {
                    "task_id": task_id,
                    "sites": merged.get("sites", []),
                    "intent": merged.get("intent", ""),
                    "start_urls": merged.get("start_urls", []),
                    "intent_template_id": None,
                    "agent_status": merged["agent_status"],
                    "raw_agent_status": merged["raw_agent_status"],
                    "eval_status": merged["eval_status"],
                    "eval_score": merged["eval_score"],
                    "failure_class": merged["failure_class"],
                    "error_details": merged["error_details"],
                    "has_outputs": merged["has_outputs"],
                    "has_agent_response": merged["has_agent_response"],
                    "has_eval_result": merged["has_eval_result"],
                    "in_target_run": merged["in_target_run"],
                    "is_current": merged["is_current"],
                    "task_dir": merged["task_dir"],
                }
            )

        rows.sort(key=lambda r: int(r["task_id"]))
        return rows

    def refresh_catalog(self) -> int:
        return len(self.ensure_catalog(force_refresh=True))

    def _assert_task_exists(self, task_id: int) -> None:
        rows = self.ensure_catalog(force_refresh=False)
        for row in rows:
            if int(row["task_id"]) == int(task_id):
                return
        raise HTTPException(status_code=404, detail=f"Task not found in catalog: {task_id}")

    def start_task(self, run_id: str, task_id: int) -> RunRecord:
        self._assert_task_exists(task_id)
        base = self.get_run(run_id)
        if base.status in {"running", "paused"}:
            raise HTTPException(status_code=400, detail=f"Run {run_id} is active; stop/pause handling first")

        timeout_raw = self._extract_command_option(base.command, "--timeout-per-task", "420")
        exclude_sites = self._extract_command_option(base.command, "--exclude-sites", "")
        timeout_per_task = _parse_int(timeout_raw) or 420
        req = CreateRunRequest(
            name=f"{base.name}-task-{task_id}",
            task_ids=str(task_id),
            exclude_sites=exclude_sites,
            timeout_per_task=timeout_per_task,
            keep_sites_running="--keep-sites-running" in base.command,
            no_resume=True,
            output_dir=base.output_dir,
        )
        return self.create_run(req)

    def pause_task(self, run_id: str, task_id: int) -> ActionResponse:
        run = self.get_run(run_id)
        current_task = self._current_progress_task_id(Path(run.output_dir))
        if run.status != "running":
            raise HTTPException(status_code=400, detail=f"Run {run_id} is not running")
        if current_task != task_id:
            raise HTTPException(
                status_code=400,
                detail=f"Task {task_id} is not the current running task (current={current_task})",
            )
        return self.pause_run(run_id)

    def resume_task(self, run_id: str, task_id: int) -> ActionResponse:
        run = self.get_run(run_id)
        current_task = self._current_progress_task_id(Path(run.output_dir))
        if run.status != "paused":
            raise HTTPException(status_code=400, detail=f"Run {run_id} is not paused")
        if current_task != task_id:
            raise HTTPException(
                status_code=400,
                detail=f"Task {task_id} is not the paused current task (current={current_task})",
            )
        return self.resume_run(run_id)

    def reset_task(self, run_id: str, task_id: int) -> ActionResponse:
        run = self.get_run(run_id)
        if run.status in {"running", "paused"}:
            raise HTTPException(status_code=400, detail=f"Run {run_id} is active; stop it before resetting tasks")

        output_dir = Path(run.output_dir).resolve()
        task_dir = (output_dir / str(task_id)).resolve()
        if not _is_relative_to(task_dir, output_dir):
            raise HTTPException(status_code=400, detail=f"Unsafe task path: {task_dir}")

        if not task_dir.exists():
            return ActionResponse(ok=True, message=f"Task {task_id} already clean")
        if not task_dir.is_dir():
            raise HTTPException(status_code=400, detail=f"Task path is not a directory: {task_dir}")
        shutil.rmtree(task_dir)
        self._invalidate_success_cache()
        return ActionResponse(ok=True, message=f"Task {task_id} artifacts removed")

    def _task_succeeded_in_output_dir(self, output_dir: Path, task_id: int) -> bool:
        task_dir = output_dir / str(task_id)
        agent = _safe_load_json(task_dir / "agent_response.json", {})
        if str(agent.get("status") or "").upper() == "SUCCESS":
            return True
        eval_result = _safe_load_json(task_dir / "eval_result.json", {})
        return str(eval_result.get("status") or "").upper() in {"PASS", "SUCCESS"}

    def successful_task_ids_global(self, *, force_refresh: bool = False, max_age_sec: float = 10.0) -> set[int]:
        with self._lock:
            now_ts = time.time()
            if (
                not force_refresh
                and self._success_cache_at > 0.0
                and (now_ts - self._success_cache_at) <= max_age_sec
            ):
                return set(self._success_cache_ids)

            output_dirs: set[Path] = set()
            for run in self._runs.values():
                output_dirs.add(Path(run.output_dir))
            if ARTIFACTS_ROOT.exists():
                for item in ARTIFACTS_ROOT.iterdir():
                    if item.is_dir() and item.name != "_manager":
                        output_dirs.add(item)

            success_ids: set[int] = set()
            for output_dir in output_dirs:
                if not output_dir.exists():
                    continue
                for item in output_dir.iterdir():
                    if not item.is_dir() or not item.name.isdigit():
                        continue
                    task_id = int(item.name)
                    if self._task_succeeded_in_output_dir(output_dir, task_id):
                        success_ids.add(task_id)

            self._success_cache_ids = set(success_ids)
            self._success_cache_at = now_ts
            return success_ids

    def task_detail(self, run_id: str, task_id: int) -> dict[str, Any]:
        run = self.get_run(run_id)
        task: dict[str, Any] | None = None
        for row in self.catalog_rows(run_id):
            if int(row["task_id"]) == int(task_id):
                task = row
                break
        if task is None:
            raise HTTPException(status_code=404, detail=f"Task {task_id} not found for run {run_id}")

        task_dir = Path(run.output_dir) / str(task_id)
        return {
            "run": asdict(run),
            "task": task,
            "task_dir": str(task_dir),
            "task_log": _tail_text(task_dir / "run.log", max_chars=30_000),
            "agent_response": _safe_load_json(task_dir / "agent_response.json", {}),
            "eval_result": _safe_load_json(task_dir / "eval_result.json", {}),
            "assistant_turn_outputs_tail": _tail_text(task_dir / "assistant_turn_outputs.json", max_chars=40_000),
        }


class SerialEvaluatorController:
    def __init__(self, manager: EvalManager) -> None:
        self._manager = manager
        self._lock = RLock()
        self._state: dict[str, Any] | None = None
        self._worker: Thread | None = None
        self._pause_requested = False
        self._stop_requested = False
        self._load_state()

    def _load_state(self) -> None:
        payload = _safe_load_json(SERIAL_STATE_PATH, {})
        if not isinstance(payload, dict) or not payload.get("session_id"):
            self._state = None
            return
        self._state = payload
        if self._state.get("status") in {"running", "paused", "stopping"}:
            self._state["status"] = "stopped"
            self._state["ended_at"] = self._state.get("ended_at") or _now()
            self._state["updated_at"] = _now()
            self._state["last_message"] = "Recovered after service restart; previous serial worker was interrupted."
            self._save_state()

    def _save_state(self) -> None:
        if not self._state:
            SERIAL_STATE_PATH.write_text("{}", encoding="utf-8")
            return
        SERIAL_STATE_PATH.write_text(json.dumps(self._state, ensure_ascii=False, indent=2), encoding="utf-8")

    def _copy_state(self) -> dict[str, Any]:
        if not self._state:
            return {}
        return json.loads(json.dumps(self._state, ensure_ascii=False))

    def get_state(self) -> dict[str, Any]:
        with self._lock:
            if not self._state:
                return {
                    "exists": False,
                    "status": "idle",
                    "worker_alive": False,
                    "pause_requested": False,
                    "stop_requested": False,
                }
            payload = self._copy_state()
            payload["exists"] = True
            payload["worker_alive"] = bool(self._worker and self._worker.is_alive())
            payload["pause_requested"] = self._pause_requested
            payload["stop_requested"] = self._stop_requested
            payload["remaining_tasks"] = max(
                0,
                int(payload.get("total_tasks") or 0) - int(payload.get("current_index") or 0),
            )
            current_run_id = str(payload.get("current_run_id") or "").strip()

        if current_run_id:
            try:
                run = self._manager.get_run(current_run_id)
                payload["current_run_status"] = run.status
            except Exception:
                payload["current_run_status"] = "unknown"
        else:
            payload["current_run_status"] = ""
        return payload

    def create_session(self, req: CreateSerialSessionRequest) -> dict[str, Any]:
        all_selected = self._manager.resolve_task_ids(req.task_ids, req.exclude_sites)
        if not all_selected:
            raise HTTPException(status_code=400, detail="No tasks matched serial session filters")
        skipped_success = 0
        task_ids = all_selected
        if req.only_unsuccessful:
            successful_ids = self._manager.successful_task_ids_global(force_refresh=True)
            task_ids = [tid for tid in all_selected if tid not in successful_ids]
            skipped_success = len(all_selected) - len(task_ids)
            if not task_ids:
                raise HTTPException(status_code=400, detail="All selected tasks already succeeded; nothing to run")

        with self._lock:
            if self._state and self._state.get("status") in {"running", "paused", "stopping"}:
                raise HTTPException(status_code=400, detail="A serial session is active; stop it first")

            if req.output_dir.strip():
                out_path_raw = Path(req.output_dir.strip())
                output_dir = out_path_raw if out_path_raw.is_absolute() else (ROOT / out_path_raw)
            else:
                safe_name = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "_" for ch in (req.name or "serial"))[:40]
                output_dir = ARTIFACTS_ROOT / f"serial_{safe_name}_{time.strftime('%Y%m%d_%H%M%S')}"
            output_dir.mkdir(parents=True, exist_ok=True)

            now = _now()
            self._state = {
                "session_id": str(uuid.uuid4()),
                "name": req.name.strip() or "serial-single-thread",
                "status": "idle",
                "created_at": now,
                "started_at": None,
                "ended_at": None,
                "updated_at": now,
                "last_message": (
                    f"Serial session created; skipped {skipped_success} previously successful task(s)"
                    if skipped_success
                    else "Serial session created"
                ),
                "task_ids": task_ids,
                "total_tasks": len(task_ids),
                "source_total_tasks": len(all_selected),
                "skipped_success_tasks": skipped_success,
                "current_index": 0,
                "current_task_id": None,
                "current_attempt": 0,
                "current_run_id": "",
                "success_count": 0,
                "failed_count": 0,
                "skipped_count": 0,
                "attempts": {},
                "history": [],
                "max_retries": int(req.max_retries),
                "auto_skip": bool(req.auto_skip),
                "timeout_per_task": int(req.timeout_per_task),
                "exclude_sites": _normalize_csv(req.exclude_sites),
                "keep_sites_running": bool(req.keep_sites_running),
                "only_unsuccessful": bool(req.only_unsuccessful),
                "output_dir": str(output_dir),
            }
            self._pause_requested = False
            self._stop_requested = False
            self._save_state()
            return self.get_state()

    def _ensure_session(self) -> dict[str, Any]:
        if not self._state:
            raise HTTPException(status_code=404, detail="Serial session not created")
        return self._state

    def _ensure_worker_running(self) -> None:
        if self._worker and self._worker.is_alive():
            return
        self._worker = Thread(target=self._worker_loop, name="serial-eval-worker", daemon=True)
        self._worker.start()

    def start(self) -> ActionResponse:
        with self._lock:
            state = self._ensure_session()
            if state.get("status") == "completed":
                raise HTTPException(status_code=400, detail="Session already completed; create a new one")
            self._stop_requested = False
            self._pause_requested = False
            state["status"] = "running"
            state["started_at"] = state.get("started_at") or _now()
            state["updated_at"] = _now()
            state["last_message"] = "Serial worker started"
            self._save_state()
            self._ensure_worker_running()
            return ActionResponse(ok=True, message="serial session started")

    def pause(self) -> ActionResponse:
        run_id = ""
        with self._lock:
            state = self._ensure_session()
            self._pause_requested = True
            if state.get("status") in {"running", "idle"}:
                state["status"] = "paused"
            state["updated_at"] = _now()
            state["last_message"] = "Pause requested"
            run_id = str(state.get("current_run_id") or "")
            self._save_state()
        if run_id:
            try:
                self._manager.pause_run(run_id)
            except Exception:
                pass
        return ActionResponse(ok=True, message="pause requested")

    def resume(self) -> ActionResponse:
        run_id = ""
        with self._lock:
            state = self._ensure_session()
            if state.get("status") == "completed":
                raise HTTPException(status_code=400, detail="Session already completed")
            self._stop_requested = False
            self._pause_requested = False
            state["status"] = "running"
            state["updated_at"] = _now()
            state["last_message"] = "Resume requested"
            run_id = str(state.get("current_run_id") or "")
            self._save_state()
            self._ensure_worker_running()
        if run_id:
            try:
                self._manager.resume_run(run_id)
            except Exception:
                pass
        return ActionResponse(ok=True, message="resume requested")

    def stop(self) -> ActionResponse:
        run_id = ""
        with self._lock:
            state = self._ensure_session()
            self._stop_requested = True
            self._pause_requested = False
            run_id = str(state.get("current_run_id") or "")
            state["status"] = "stopping"
            state["updated_at"] = _now()
            state["last_message"] = "Stop requested"
            self._save_state()
        if run_id:
            try:
                self._manager.stop_run(run_id)
            except Exception:
                pass
        with self._lock:
            if self._state and not (self._worker and self._worker.is_alive()):
                self._state["status"] = "stopped"
                self._state["ended_at"] = self._state.get("ended_at") or _now()
                self._state["updated_at"] = _now()
                self._save_state()
        return ActionResponse(ok=True, message="stop requested")

    def _task_succeeded(self, output_dir: str, task_id: int) -> bool:
        task_dir = Path(output_dir) / str(task_id)
        agent = _safe_load_json(task_dir / "agent_response.json", {})
        if str(agent.get("status") or "").upper() == "SUCCESS":
            return True
        eval_result = _safe_load_json(task_dir / "eval_result.json", {})
        return str(eval_result.get("status") or "").upper() in {"PASS", "SUCCESS"}

    def _append_history(self, *, task_id: int, attempt: int, run_id: str, result: str, note: str = "") -> None:
        if not self._state:
            return
        history = self._state.setdefault("history", [])
        history.append(
            {
                "task_id": int(task_id),
                "attempt": int(attempt),
                "run_id": run_id,
                "result": result,
                "note": note,
                "finished_at": _now(),
            }
        )

    def _worker_loop(self) -> None:
        while True:
            with self._lock:
                state = self._state
                if not state:
                    return
                if self._stop_requested:
                    state["status"] = "stopped"
                    state["ended_at"] = state.get("ended_at") or _now()
                    state["updated_at"] = _now()
                    state["last_message"] = "Stopped by user"
                    state["current_run_id"] = ""
                    self._save_state()
                    return

                total = int(state.get("total_tasks") or 0)
                index = int(state.get("current_index") or 0)
                current_run_id = str(state.get("current_run_id") or "")
                pause_requested = self._pause_requested
                if index >= total and not current_run_id:
                    state["status"] = "completed"
                    state["ended_at"] = state.get("ended_at") or _now()
                    state["updated_at"] = _now()
                    state["current_task_id"] = None
                    state["current_attempt"] = 0
                    state["last_message"] = "All tasks completed"
                    self._save_state()
                    return

                task_ids = list(state.get("task_ids") or [])
                timeout_per_task = int(state.get("timeout_per_task") or 420)
                exclude_sites = str(state.get("exclude_sites") or "")
                keep_sites_running = bool(state.get("keep_sites_running"))
                max_retries = int(state.get("max_retries") or 0)
                auto_skip = bool(state.get("auto_skip"))
                output_dir = str(state.get("output_dir") or "")
                task_id = int(task_ids[index]) if index < len(task_ids) else -1
                current_attempt = int(state.get("current_attempt") or 0)

            if pause_requested:
                if current_run_id:
                    try:
                        run = self._manager.get_run(current_run_id)
                        if run.status == "running":
                            self._manager.pause_run(current_run_id)
                    except Exception:
                        pass
                time.sleep(1.0)
                continue

            if current_run_id:
                try:
                    run = self._manager.get_run(current_run_id)
                except Exception:
                    run = None

                if run and run.status in {"running", "paused"}:
                    if run.status == "paused" and not self._pause_requested:
                        try:
                            self._manager.resume_run(current_run_id)
                        except Exception:
                            pass
                    time.sleep(1.5)
                    continue

                success = self._task_succeeded(output_dir, task_id)
                with self._lock:
                    if not self._state:
                        return
                    state = self._state
                    state["current_run_id"] = ""
                    state["updated_at"] = _now()
                    attempt = int(state.get("current_attempt") or current_attempt or 1)
                    self._append_history(
                        task_id=task_id,
                        attempt=attempt,
                        run_id=current_run_id,
                        result="success" if success else "failed",
                    )
                    if success:
                        state["success_count"] = int(state.get("success_count") or 0) + 1
                        state["current_index"] = int(state.get("current_index") or 0) + 1
                        state["current_task_id"] = None
                        state["current_attempt"] = 0
                        state["last_message"] = f"Task {task_id} succeeded on attempt {attempt}"
                    else:
                        if attempt <= max_retries:
                            state["current_task_id"] = None
                            state["current_attempt"] = 0
                            state["last_message"] = f"Task {task_id} failed on attempt {attempt}; retrying"
                        else:
                            state["failed_count"] = int(state.get("failed_count") or 0) + 1
                            state["current_task_id"] = None
                            state["current_attempt"] = 0
                            if auto_skip:
                                state["skipped_count"] = int(state.get("skipped_count") or 0) + 1
                                state["current_index"] = int(state.get("current_index") or 0) + 1
                                state["last_message"] = (
                                    f"Task {task_id} failed after {attempt} attempts; skipped automatically"
                                )
                            else:
                                state["status"] = "stopped"
                                state["ended_at"] = _now()
                                state["last_message"] = (
                                    f"Task {task_id} failed after {attempt} attempts; session stopped"
                                )
                    self._save_state()
                    if state.get("status") == "stopped":
                        return
                continue

            with self._lock:
                if not self._state:
                    return
                state = self._state
                index = int(state.get("current_index") or 0)
                task_ids = list(state.get("task_ids") or [])
                if index >= len(task_ids):
                    continue
                task_id = int(task_ids[index])
                attempts = state.setdefault("attempts", {})
                attempt = int(attempts.get(str(task_id), 0)) + 1
                attempts[str(task_id)] = attempt
                state["current_task_id"] = task_id
                state["current_attempt"] = attempt
                state["status"] = "running"
                state["started_at"] = state.get("started_at") or _now()
                state["updated_at"] = _now()
                state["last_message"] = f"Running task {task_id} attempt {attempt}/{max_retries + 1}"
                timeout_per_task = int(state.get("timeout_per_task") or 420)
                exclude_sites = str(state.get("exclude_sites") or "")
                keep_sites_running = bool(state.get("keep_sites_running"))
                output_dir = str(state.get("output_dir") or "")
                session_name = str(state.get("name") or "serial")
                self._save_state()

            try:
                run = self._manager.create_run(
                    CreateRunRequest(
                        name=f"{session_name}-task-{task_id}-a{attempt}",
                        task_ids=str(task_id),
                        exclude_sites=exclude_sites,
                        timeout_per_task=timeout_per_task,
                        keep_sites_running=keep_sites_running,
                        no_resume=True,
                        output_dir=output_dir,
                    )
                )
            except Exception as exc:
                with self._lock:
                    if not self._state:
                        return
                    state = self._state
                    state["updated_at"] = _now()
                    state["current_run_id"] = ""
                    self._append_history(
                        task_id=task_id,
                        attempt=attempt,
                        run_id="",
                        result="launch_failed",
                        note=str(exc),
                    )
                    if attempt <= max_retries:
                        state["last_message"] = f"Launch failed for task {task_id} attempt {attempt}; retrying"
                        state["current_task_id"] = None
                        state["current_attempt"] = 0
                    else:
                        state["failed_count"] = int(state.get("failed_count") or 0) + 1
                        state["current_task_id"] = None
                        state["current_attempt"] = 0
                        if auto_skip:
                            state["skipped_count"] = int(state.get("skipped_count") or 0) + 1
                            state["current_index"] = int(state.get("current_index") or 0) + 1
                            state["last_message"] = (
                                f"Task {task_id} launch failed after {attempt} attempts; skipped automatically"
                            )
                        else:
                            state["status"] = "stopped"
                            state["ended_at"] = _now()
                            state["last_message"] = (
                                f"Task {task_id} launch failed after {attempt} attempts; session stopped"
                            )
                    self._save_state()
                    if state.get("status") == "stopped":
                        return
                time.sleep(1.0)
                continue

            with self._lock:
                if not self._state:
                    return
                state = self._state
                state["current_run_id"] = run.run_id
                state["updated_at"] = _now()
                state["last_message"] = f"Task {task_id} attempt {attempt} started (run={run.run_id})"
                self._save_state()

            time.sleep(1.0)


manager = EvalManager()
serial_controller = SerialEvaluatorController(manager)
app = FastAPI(title="WebArena Eval Manager", version="0.2.0")


def _task_ids_meta_from_command(cmd: list[str]) -> dict[str, Any]:
    if "--task-ids" not in cmd:
        return {"task_ids_raw": "", "task_ids_count": 0, "task_ids_display": "ALL"}
    idx = cmd.index("--task-ids")
    if idx + 1 >= len(cmd):
        return {"task_ids_raw": "", "task_ids_count": 0, "task_ids_display": "ALL"}
    raw = _normalize_csv(cmd[idx + 1])
    if not raw:
        return {"task_ids_raw": "", "task_ids_count": 0, "task_ids_display": "ALL"}
    parts = [part for part in raw.split(",") if part]
    count = len(parts)
    if count <= 6:
        display = raw
    else:
        display = f"{parts[0]}..{parts[-1]} ({count})"
    return {"task_ids_raw": raw, "task_ids_count": count, "task_ids_display": display}


def _run_to_dict(run: RunRecord) -> dict[str, Any]:
    payload = asdict(run)
    payload.update(_task_ids_meta_from_command(run.command))
    payload["live_url"] = f"/runs/{run.run_id}/live"
    return payload


def _sort_rows(rows: list[dict[str, Any]], sort_by: str, sort_dir: str) -> list[dict[str, Any]]:
    key = sort_by.strip() or "task_id"
    desc = sort_dir.strip().lower() == "desc"

    def _value(row: dict[str, Any]) -> Any:
        if key == "task_id":
            return int(row.get("task_id") or 0)
        if key == "sites":
            return ",".join(str(site) for site in row.get("sites", []))
        value = row.get(key)
        if value is None:
            return ""
        if isinstance(value, (int, float)):
            return value
        return str(value).lower()

    return sorted(rows, key=_value, reverse=desc)


def _task_status_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    success = 0
    failed = 0
    untested = 0
    for row in rows:
        status = str(row.get("agent_status") or "").upper()
        raw = str(row.get("raw_agent_status") or "").upper()
        if status == "SUCCESS" or raw == "SUCCESS":
            success += 1
            continue
        if status in {"UNTRACKED", "NOT_IN_RUN", "PENDING", "RUNNING", "PAUSED"}:
            untested += 1
            continue
        failed += 1

    total = len(rows)
    tested = success + failed
    tested_success_rate = (success / tested * 100.0) if tested else 0.0
    overall_success_rate = (success / total * 100.0) if total else 0.0
    return {
        "total": total,
        "success": success,
        "failed": failed,
        "untested": untested,
        "tested": tested,
        "tested_success_rate": tested_success_rate,
        "overall_success_rate": overall_success_rate,
    }


@app.get("/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "service": "eval_manager", "time": _now()}


@app.get("/api/runs")
def list_runs() -> dict[str, Any]:
    runs = [_run_to_dict(run) for run in manager.list_runs()]
    return {"runs": runs}


@app.post("/api/runs")
def create_run(req: CreateRunRequest) -> dict[str, Any]:
    run = manager.create_run(req)
    return {"run": _run_to_dict(run)}


@app.get("/api/runs/{run_id}")
def get_run(run_id: str) -> dict[str, Any]:
    run = manager.get_run(run_id)
    metrics = manager.run_metrics(run_id)
    return {"run": _run_to_dict(run), "metrics": metrics}


@app.post("/api/runs/{run_id}/pause", response_model=ActionResponse)
def pause_run(run_id: str) -> ActionResponse:
    return manager.pause_run(run_id)


@app.post("/api/runs/{run_id}/resume", response_model=ActionResponse)
def resume_run(run_id: str) -> ActionResponse:
    return manager.resume_run(run_id)


@app.post("/api/runs/{run_id}/stop", response_model=ActionResponse)
def stop_run(run_id: str) -> ActionResponse:
    return manager.stop_run(run_id)


@app.get("/api/runs/{run_id}/logs")
def read_logs(run_id: str) -> dict[str, Any]:
    return {"run_id": run_id, "log": manager.read_run_log(run_id)}


@app.get("/api/runs/{run_id}/tasks")
def list_tasks(
    run_id: str,
    status: str = Query(default="all", description="all|pending|running|paused|success|failed"),
    limit: int = Query(default=500, ge=1, le=50000),
    offset: int = Query(default=0, ge=0),
) -> dict[str, Any]:
    rows = manager.collect_task_rows(run_id)
    status_key = status.strip().lower()
    if status_key == "pending":
        rows = [row for row in rows if row["agent_status"] == "PENDING"]
    elif status_key == "running":
        rows = [row for row in rows if row["agent_status"] == "RUNNING"]
    elif status_key == "paused":
        rows = [row for row in rows if row["agent_status"] == "PAUSED"]
    elif status_key == "success":
        rows = [row for row in rows if row["raw_agent_status"] == "SUCCESS"]
    elif status_key == "failed":
        rows = [
            row
            for row in rows
            if row["raw_agent_status"] != "SUCCESS" and row["agent_status"] not in {"PENDING", "RUNNING", "PAUSED"}
        ]
    total = len(rows)
    return {"total": total, "rows": rows[offset : offset + limit]}


@app.post("/api/runs/{run_id}/retry-failed")
def retry_failed(
    run_id: str,
    reason: str = Query(
        default="all",
        description="all|invalid_json|driver_request_failed|rate_limited|timeout|other|pending|running|paused",
    ),
) -> dict[str, Any]:
    run = manager.retry_failed(run_id, reason=reason)
    return {"run": _run_to_dict(run)}


@app.get("/api/tasks/catalog")
def task_catalog(
    run_id: str = Query(default="", description="Optional run_id for status overlay"),
    status: str = Query(default="all", description="all|pending|running|paused|success|failed|not_in_run|untracked"),
    site: str = Query(default="", description="Optional site filter"),
    q: str = Query(default="", description="Intent/error search"),
    target_only: bool = Query(default=False),
    sort_by: str = Query(default="task_id"),
    sort_dir: str = Query(default="asc"),
) -> dict[str, Any]:
    selected_run_id = run_id.strip() or None
    rows = manager.catalog_rows(selected_run_id)

    status_key = status.strip().lower()
    if status_key == "pending":
        rows = [row for row in rows if row["agent_status"] == "PENDING"]
    elif status_key == "running":
        rows = [row for row in rows if row["agent_status"] == "RUNNING"]
    elif status_key == "paused":
        rows = [row for row in rows if row["agent_status"] == "PAUSED"]
    elif status_key == "success":
        rows = [row for row in rows if row["raw_agent_status"] == "SUCCESS"]
    elif status_key == "failed":
        rows = [
            row
            for row in rows
            if row["agent_status"] not in {"UNTRACKED", "NOT_IN_RUN", "PENDING", "RUNNING", "PAUSED"}
            and row["raw_agent_status"] != "SUCCESS"
        ]
    elif status_key == "not_in_run":
        rows = [row for row in rows if row["agent_status"] == "NOT_IN_RUN"]
    elif status_key == "untracked":
        rows = [row for row in rows if row["agent_status"] == "UNTRACKED"]

    site_key = site.strip().lower()
    if site_key:
        rows = [row for row in rows if site_key in [str(s).lower() for s in row.get("sites", [])]]

    if target_only:
        rows = [row for row in rows if bool(row.get("in_target_run"))]

    q_key = q.strip().lower()
    if q_key:
        rows = [
            row
            for row in rows
            if q_key in str(row.get("intent", "")).lower()
            or q_key in str(row.get("task_id", "")).lower()
            or q_key in str(row.get("failure_class", "")).lower()
            or q_key in str(row.get("error_details", "")).lower()
        ]

    rows = _sort_rows(rows, sort_by=sort_by, sort_dir=sort_dir)
    return {
        "total": len(rows),
        "rows": rows,
        "catalog_path": str(CATALOG_PATH),
        "catalog_error": manager._catalog_error,
        "run_id": selected_run_id or "",
    }


@app.get("/api/tasks/summary")
def task_summary(
    run_id: str = Query(default="", description="Optional run_id for status summary"),
) -> dict[str, Any]:
    selected_run_id = run_id.strip() or None
    rows = manager.catalog_rows(selected_run_id)
    payload = _task_status_summary(rows)
    payload["run_id"] = selected_run_id or ""
    return payload


@app.post("/api/tasks/catalog/refresh", response_model=ActionResponse)
def refresh_catalog() -> ActionResponse:
    count = manager.refresh_catalog()
    return ActionResponse(ok=True, message=f"catalog refreshed: {count} tasks")


@app.get("/api/runs/{run_id}/tasks/{task_id}")
def get_task_detail(run_id: str, task_id: int) -> dict[str, Any]:
    return manager.task_detail(run_id, task_id)


@app.post("/api/runs/{run_id}/tasks/{task_id}/start")
def start_task(run_id: str, task_id: int) -> dict[str, Any]:
    run = manager.start_task(run_id, task_id)
    return {"run": _run_to_dict(run)}


@app.post("/api/runs/{run_id}/tasks/{task_id}/pause", response_model=ActionResponse)
def pause_task(run_id: str, task_id: int) -> ActionResponse:
    return manager.pause_task(run_id, task_id)


@app.post("/api/runs/{run_id}/tasks/{task_id}/resume", response_model=ActionResponse)
def resume_task(run_id: str, task_id: int) -> ActionResponse:
    return manager.resume_task(run_id, task_id)


@app.post("/api/runs/{run_id}/tasks/{task_id}/reset", response_model=ActionResponse)
def reset_task(run_id: str, task_id: int) -> ActionResponse:
    return manager.reset_task(run_id, task_id)


@app.get("/api/serial/session")
def get_serial_session() -> dict[str, Any]:
    return {"session": serial_controller.get_state()}


@app.post("/api/serial/session")
def create_serial_session(req: CreateSerialSessionRequest) -> dict[str, Any]:
    session = serial_controller.create_session(req)
    return {"session": session}


@app.post("/api/serial/session/start", response_model=ActionResponse)
def start_serial_session() -> ActionResponse:
    return serial_controller.start()


@app.post("/api/serial/session/pause", response_model=ActionResponse)
def pause_serial_session() -> ActionResponse:
    return serial_controller.pause()


@app.post("/api/serial/session/resume", response_model=ActionResponse)
def resume_serial_session() -> ActionResponse:
    return serial_controller.resume()


@app.post("/api/serial/session/stop", response_model=ActionResponse)
def stop_serial_session() -> ActionResponse:
    return serial_controller.stop()


HOME_HTML = """
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WebArena Eval Command Center</title>
  <style>
    :root {
      --bg: #eef2f8;
      --ink: #0f172a;
      --muted: #526074;
      --card: rgba(255, 255, 255, 0.86);
      --line: rgba(15, 23, 42, 0.09);
      --accent: #0d9488;
      --accent-2: #0284c7;
      --danger: #dc2626;
      --shadow: 0 18px 42px rgba(7, 15, 40, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(1000px 480px at -8% -18%, rgba(13,148,136,.18), transparent 60%),
        radial-gradient(920px 450px at 108% 2%, rgba(2,132,199,.2), transparent 60%),
        linear-gradient(170deg, #f3f6fb, #e7edf6);
      color: var(--ink);
      font-family: "Space Grotesk", "Avenir Next", "Segoe UI", sans-serif;
      letter-spacing: .01em;
    }
    .app {
      max-width: 1440px;
      margin: 26px auto 48px;
      padding: 0 20px;
      display: grid;
      gap: 14px;
    }
    .top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      padding: 6px 2px;
    }
    .top h1 {
      margin: 0;
      font-size: 30px;
      line-height: 1.1;
      letter-spacing: .02em;
    }
    .top p {
      margin: 8px 0 0;
      color: var(--muted);
      font-size: 13px;
    }
    .top-actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .panel {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 16px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(8px);
      padding: 14px;
    }
    .title-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
      gap: 8px;
    }
    .title-row h2 {
      margin: 0;
      font-size: 16px;
      letter-spacing: .01em;
    }
    .muted { color: var(--muted); font-size: 12px; }
    .row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .grid {
      display: grid;
      grid-template-columns: minmax(440px, 1.3fr) minmax(420px, 1fr);
      gap: 14px;
    }
    @media (max-width: 1200px) {
      .grid { grid-template-columns: 1fr; }
    }
    input, select, button {
      border-radius: 10px;
      border: 1px solid rgba(15, 23, 42, .18);
      background: rgba(255, 255, 255, .96);
      color: var(--ink);
      height: 36px;
      padding: 0 10px;
      font-size: 13px;
      outline: none;
    }
    input:focus, select:focus {
      border-color: rgba(2, 132, 199, .62);
      box-shadow: 0 0 0 3px rgba(2,132,199,.14);
    }
    button {
      cursor: pointer;
      background: linear-gradient(180deg, #0ea5a3, #0f766e);
      color: #f8fbff;
      border-color: transparent;
      font-weight: 600;
      transition: transform .16s ease, box-shadow .2s ease, filter .2s ease;
      box-shadow: 0 10px 18px rgba(15, 118, 110, .22);
    }
    button:hover { transform: translateY(-1px); filter: saturate(1.04); }
    button.ghost {
      background: rgba(255,255,255,.8);
      color: #0f172a;
      border-color: rgba(15,23,42,.2);
      box-shadow: none;
    }
    button.warn {
      background: linear-gradient(180deg, #ef4444, #b91c1c);
      box-shadow: 0 10px 18px rgba(185, 28, 28, .2);
    }
    button:disabled {
      cursor: not-allowed;
      opacity: .48;
      transform: none;
      box-shadow: none;
      filter: grayscale(.2);
    }
    a.mini-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 30px;
      padding: 0 10px;
      border-radius: 8px;
      border: 1px solid rgba(15,23,42,.16);
      text-decoration: none;
      color: #0f172a;
      background: rgba(255,255,255,.82);
      font-size: 12px;
      font-weight: 600;
    }
    .badge {
      border-radius: 999px;
      padding: 3px 10px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: .04em;
      text-transform: uppercase;
      border: 1px solid rgba(15,23,42,.15);
      background: rgba(255,255,255,.8);
      color: #0f172a;
    }
    .badge.running { color: #075985; border-color: rgba(2,132,199,.4); background: rgba(2,132,199,.15); }
    .badge.paused { color: #854d0e; border-color: rgba(234,179,8,.36); background: rgba(250,204,21,.16); }
    .badge.finished { color: #166534; border-color: rgba(34,197,94,.35); background: rgba(34,197,94,.13); }
    .badge.failed, .badge.stopped { color: #991b1b; border-color: rgba(239,68,68,.32); background: rgba(239,68,68,.12); }
    .table-wrap {
      overflow: auto;
      border: 1px solid rgba(15,23,42,.12);
      border-radius: 12px;
      background: rgba(255,255,255,.82);
      max-height: 560px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 940px;
      font-size: 12px;
    }
    thead th {
      position: sticky;
      top: 0;
      background: rgba(241,247,255,.96);
      backdrop-filter: blur(6px);
      border-bottom: 1px solid rgba(15,23,42,.12);
      text-align: left;
      padding: 8px 9px;
      white-space: nowrap;
      z-index: 1;
    }
    thead th.sortable { cursor: pointer; user-select: none; }
    tbody td {
      border-bottom: 1px solid rgba(15,23,42,.08);
      padding: 7px 9px;
      vertical-align: top;
    }
    tbody tr:hover { background: rgba(2,132,199,.07); }
    .status-cell {
      display: flex;
      align-items: center;
      gap: 8px;
      white-space: nowrap;
      font-weight: 600;
    }
    .status-dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      display: inline-block;
      box-shadow: 0 0 0 2px rgba(255,255,255,.9), 0 0 0 4px rgba(15,23,42,.06);
    }
    .s-success { background: #16a34a; }
    .s-running { background: #0284c7; }
    .s-paused { background: #eab308; }
    .s-pending { background: #64748b; }
    .s-failed { background: #dc2626; }
    .s-not-in-run { background: #9ca3af; }
    .s-untracked { background: #475569; }
    .intent {
      max-width: 620px;
      line-height: 1.35;
    }
    .actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      align-items: center;
    }
    .actions button, .runs-actions button {
      height: 30px;
      padding: 0 10px;
      border-radius: 8px;
      font-size: 12px;
      box-shadow: none;
    }
    .runs-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      align-items: center;
    }
    .log {
      border-radius: 12px;
      border: 1px solid rgba(148,163,184,.28);
      background: #071421;
      color: #d6e6fb;
      padding: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      white-space: pre-wrap;
      max-height: 280px;
      overflow: auto;
      margin: 0;
      font-size: 12px;
      line-height: 1.38;
    }
    .toast {
      border-radius: 10px;
      padding: 8px 10px;
      border: 1px solid rgba(15,23,42,.15);
      background: rgba(255,255,255,.86);
      font-size: 12px;
      color: #0f172a;
      min-height: 34px;
      display: flex;
      align-items: center;
    }
    .toast.error {
      color: #991b1b;
      border-color: rgba(239,68,68,.3);
      background: rgba(254,226,226,.76);
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(5, minmax(140px, 1fr));
      gap: 10px;
    }
    @media (max-width: 1100px) {
      .summary-grid { grid-template-columns: repeat(2, minmax(140px, 1fr)); }
    }
    .summary-card {
      border: 1px solid rgba(15,23,42,.1);
      background: rgba(255,255,255,.75);
      border-radius: 12px;
      padding: 10px;
      min-height: 68px;
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 4px;
    }
    .summary-label {
      font-size: 11px;
      color: #526074;
      letter-spacing: .02em;
      text-transform: uppercase;
    }
    .summary-value {
      font-size: 22px;
      line-height: 1;
      font-weight: 700;
      color: #0f172a;
    }
    .sort-hint { font-size: 11px; color: #475569; margin-left: 4px; }
  </style>
</head>
<body>
  <main class="app">
    <header class="top">
      <div>
        <h1>WebArena Eval Command Center</h1>
        <p>Full task catalog is auto-loaded at startup. Click table headers to sort and use filters to slice quickly.</p>
      </div>
      <div class="top-actions">
        <button class="ghost" onclick="refreshCatalogFromCli()">Refresh Catalog</button>
        <a class="mini-link" href="/serial" target="_blank" rel="noopener">Serial Runner</a>
        <a class="mini-link" id="selected_live_link" href="#" target="_blank" rel="noopener">Open Run Live</a>
      </div>
    </header>

    <section class="summary-grid">
      <article class="summary-card"><div class="summary-label">Success</div><div id="sum_success" class="summary-value">0</div></article>
      <article class="summary-card"><div class="summary-label">Failed</div><div id="sum_failed" class="summary-value">0</div></article>
      <article class="summary-card"><div class="summary-label">Untested</div><div id="sum_untested" class="summary-value">0</div></article>
      <article class="summary-card"><div class="summary-label">Tested Success Rate</div><div id="sum_tested_rate" class="summary-value">0%</div></article>
      <article class="summary-card"><div class="summary-label">Overall Success Rate</div><div id="sum_overall_rate" class="summary-value">0%</div></article>
    </section>

    <section class="panel">
      <div class="title-row">
        <h2>Create Run</h2>
        <span class="muted">Create full run or subset run</span>
      </div>
      <div class="row">
        <input id="name" placeholder="run name (optional)" size="24" />
        <input id="task_ids" placeholder="task ids (optional): 27,28,30" size="30" />
        <input id="exclude_sites" value="map,wikipedia" size="18" />
        <input id="timeout" type="number" value="420" min="30" max="7200" />
        <label class="muted"><input id="only_unsuccessful" type="checkbox" checked /> only unsuccessful</label>
        <label class="muted"><input id="keep_sites_running" type="checkbox" /> keep sites</label>
        <label class="muted"><input id="no_resume" type="checkbox" /> no resume</label>
        <button onclick="createRun()">Start</button>
      </div>
      <div id="create_msg" class="toast" style="margin-top:10px;"></div>
    </section>

    <section class="grid">
      <article class="panel">
        <div class="title-row">
          <h2>Runs</h2>
          <span id="runs_meta" class="muted"></span>
        </div>
        <div class="table-wrap" style="max-height:330px;">
          <table id="runs_table">
            <thead>
              <tr>
                <th>name</th>
                <th>task_ids</th>
                <th>status</th>
                <th>pid</th>
                <th>created</th>
                <th>actions</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
      </article>

      <article class="panel">
        <div class="title-row">
          <h2>Run Detail</h2>
          <span id="run_badge" class="badge">none</span>
        </div>
        <div id="detail" class="muted">Select a run.</div>
        <div class="row" style="margin-top:10px;">
          <select id="retry_reason">
            <option value="all">all</option>
            <option value="invalid_json">invalid_json</option>
            <option value="driver_request_failed">driver_request_failed</option>
            <option value="rate_limited">rate_limited</option>
            <option value="timeout">timeout</option>
            <option value="other">other</option>
          </select>
          <button onclick="retryFailed()">Retry Failed</button>
          <button class="ghost" onclick="pauseSelectedRun()">Pause Selected</button>
          <button class="ghost" onclick="resumeSelectedRun()">Resume Selected</button>
          <button class="warn" onclick="stopSelectedRun()">Stop Selected</button>
        </div>
        <pre id="log_view" class="log" style="margin-top:10px;"></pre>
      </article>
    </section>

    <section class="panel">
      <div class="title-row">
        <h2>All Tasks</h2>
        <span id="task_meta" class="muted">Loading...</span>
      </div>
      <div class="row" style="margin-bottom:10px;">
        <input id="filter_q" placeholder="Search task id / intent / failure..." size="34" />
        <select id="filter_status">
          <option value="all">status: all</option>
          <option value="pending">pending</option>
          <option value="running">running</option>
          <option value="paused">paused</option>
          <option value="success">success</option>
          <option value="failed">failed</option>
          <option value="not_in_run">not_in_run</option>
          <option value="untracked">untracked</option>
        </select>
        <select id="filter_site">
          <option value="all">site: all</option>
        </select>
        <label class="muted"><input id="target_only" type="checkbox" /> target-only</label>
        <button class="ghost" onclick="loadCatalog()">Reload</button>
      </div>
      <div class="table-wrap">
        <table id="tasks_table">
          <thead>
            <tr>
              <th class="sortable" data-sort="agent_status">status <span class="sort-hint"></span></th>
              <th class="sortable" data-sort="task_id">task_id <span class="sort-hint"></span></th>
              <th class="sortable" data-sort="sites">sites <span class="sort-hint"></span></th>
              <th class="sortable" data-sort="intent">intent <span class="sort-hint"></span></th>
              <th class="sortable" data-sort="eval_status">eval <span class="sort-hint"></span></th>
              <th class="sortable" data-sort="failure_class">failure <span class="sort-hint"></span></th>
              <th>actions</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    </section>
  </main>

  <script>
    const state = {
      runs: [],
      selectedRunId: "",
      catalogRows: [],
      sortBy: "task_id",
      sortDir: "asc",
      summary: null,
    };

    function esc(v) {
      return String(v ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
    }

    async function api(path, opt = {}) {
      const res = await fetch(path, opt);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `${res.status} ${res.statusText}`);
      }
      return await res.json();
    }

    function notify(message, isError = false, target = "create_msg") {
      const el = document.getElementById(target);
      if (!el) return;
      el.textContent = message;
      el.classList.toggle("error", !!isError);
    }

    function formatRate(value) {
      return `${Number(value || 0).toFixed(2)}%`;
    }

    function renderTopSummary(summary) {
      const data = summary || {
        success: 0,
        failed: 0,
        untested: 0,
        tested_success_rate: 0,
        overall_success_rate: 0,
      };
      document.getElementById("sum_success").textContent = String(data.success ?? 0);
      document.getElementById("sum_failed").textContent = String(data.failed ?? 0);
      document.getElementById("sum_untested").textContent = String(data.untested ?? 0);
      document.getElementById("sum_tested_rate").textContent = formatRate(data.tested_success_rate);
      document.getElementById("sum_overall_rate").textContent = formatRate(data.overall_success_rate);
    }

    async function refreshTopSummary() {
      if (!state.selectedRunId) {
        state.summary = null;
        renderTopSummary(null);
        return;
      }
      try {
        const data = await api(`/api/tasks/summary?run_id=${encodeURIComponent(state.selectedRunId)}`);
        state.summary = data;
        renderTopSummary(data);
      } catch (e) {
        notify(`Load summary failed: ${e.message}`, true);
      }
    }

    function statusClass(status) {
      const s = String(status || "").toUpperCase();
      if (s === "SUCCESS") return "s-success";
      if (s === "RUNNING") return "s-running";
      if (s === "PAUSED") return "s-paused";
      if (s === "PENDING") return "s-pending";
      if (s === "NOT_IN_RUN") return "s-not-in-run";
      if (s === "UNTRACKED") return "s-untracked";
      return "s-failed";
    }

    function statusBadge(status) {
      const s = String(status || "none");
      return `<span class="badge ${esc(s)}">${esc(s)}</span>`;
    }

    function compareValues(a, b, key) {
      const av = a?.[key];
      const bv = b?.[key];
      if (key === "task_id") return Number(av || 0) - Number(bv || 0);
      if (key === "sites") {
        return String((av || []).join(",")).localeCompare(String((bv || []).join(",")));
      }
      return String(av ?? "").localeCompare(String(bv ?? ""), undefined, { sensitivity: "base" });
    }

    function updateSortHints() {
      document.querySelectorAll("#tasks_table thead th.sortable").forEach((th) => {
        const hint = th.querySelector(".sort-hint");
        if (!hint) return;
        if (th.dataset.sort === state.sortBy) {
          hint.textContent = state.sortDir === "asc" ? "▲" : "▼";
        } else {
          hint.textContent = "";
        }
      });
    }

    function setSelectedRunLink() {
      const link = document.getElementById("selected_live_link");
      if (!state.selectedRunId) {
        link.setAttribute("href", "#");
        link.style.pointerEvents = "none";
        link.style.opacity = ".55";
        return;
      }
      link.setAttribute("href", `/runs/${encodeURIComponent(state.selectedRunId)}/live`);
      link.style.pointerEvents = "auto";
      link.style.opacity = "1";
    }

    function renderRuns() {
      const tbody = document.querySelector("#runs_table tbody");
      tbody.innerHTML = "";
      for (const run of state.runs) {
        const tr = document.createElement("tr");
        if (state.selectedRunId === run.run_id) tr.style.background = "rgba(2,132,199,.09)";
        tr.innerHTML = `
          <td><a href="#" onclick="selectRun('${run.run_id}');return false;">${esc(run.name)}</a></td>
          <td title="${esc(run.task_ids_raw || run.task_ids_display || "ALL")}">${esc(run.task_ids_display || "ALL")}</td>
          <td>${statusBadge(run.status)}</td>
          <td>${esc(run.pid ?? "")}</td>
          <td>${esc(run.created_at)}</td>
          <td class="runs-actions">
            <button class="ghost" onclick="runAction('${run.run_id}','pause')">Pause</button>
            <button class="ghost" onclick="runAction('${run.run_id}','resume')">Resume</button>
            <button class="warn" onclick="runAction('${run.run_id}','stop')">Stop</button>
            <a class="mini-link" target="_blank" href="/runs/${run.run_id}/live" rel="noopener">Live</a>
          </td>`;
        tbody.appendChild(tr);
      }
      document.getElementById("runs_meta").textContent = `${state.runs.length} run(s)`;
      setSelectedRunLink();
    }

    async function pickPreferredRunId(runs) {
      if (!runs.length) return "";
      let bestId = runs[0].run_id;
      let bestScore = -1;
      for (const run of runs.slice(0, 12)) {
        try {
          const detail = await api(`/api/runs/${encodeURIComponent(run.run_id)}`);
          const m = detail.metrics || {};
          const success = Number(m.agent_success_count || 0);
          const completed = Number(m.completed_task_dirs || 0);
          const score = success * 100000 + completed;
          if (score > bestScore) {
            bestScore = score;
            bestId = run.run_id;
          }
        } catch (_) {}
      }
      return bestId;
    }

    async function refreshRuns(autoSelect = true) {
      const data = await api("/api/runs");
      state.runs = data.runs || [];

      if (autoSelect && !state.selectedRunId && state.runs.length > 0) {
        state.selectedRunId = await pickPreferredRunId(state.runs);
      }
      if (state.selectedRunId && !state.runs.find((r) => r.run_id === state.selectedRunId)) {
        state.selectedRunId = state.runs.length ? await pickPreferredRunId(state.runs) : "";
      }
      renderRuns();
    }

    async function createRun() {
      const body = {
        name: document.getElementById("name").value.trim(),
        task_ids: document.getElementById("task_ids").value.trim(),
        exclude_sites: document.getElementById("exclude_sites").value.trim(),
        timeout_per_task: Number(document.getElementById("timeout").value || 420),
        only_unsuccessful: document.getElementById("only_unsuccessful").checked,
        keep_sites_running: document.getElementById("keep_sites_running").checked,
        no_resume: document.getElementById("no_resume").checked,
      };
      try {
        const data = await api("/api/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        state.selectedRunId = data.run.run_id;
        notify(`Created run: ${data.run.run_id}`);
        await refreshRuns(false);
        await refreshRunDetail();
        await loadCatalog();
      } catch (e) {
        notify(`Create failed: ${e.message}`, true);
      }
    }

    async function runAction(runId, action) {
      try {
        await api(`/api/runs/${encodeURIComponent(runId)}/${action}`, { method: "POST" });
        await refreshRuns(false);
        if (state.selectedRunId === runId) {
          await refreshRunDetail();
          await loadCatalog();
        }
      } catch (e) {
        notify(`${action} failed: ${e.message}`, true);
      }
    }

    async function stopSelectedRun() {
      if (!state.selectedRunId) return;
      await runAction(state.selectedRunId, "stop");
    }

    async function pauseSelectedRun() {
      if (!state.selectedRunId) return;
      await runAction(state.selectedRunId, "pause");
    }

    async function resumeSelectedRun() {
      if (!state.selectedRunId) return;
      await runAction(state.selectedRunId, "resume");
    }

    async function retryFailed() {
      if (!state.selectedRunId) return;
      const reason = document.getElementById("retry_reason").value;
      try {
        const data = await api(`/api/runs/${encodeURIComponent(state.selectedRunId)}/retry-failed?reason=${encodeURIComponent(reason)}`, {
          method: "POST",
        });
        state.selectedRunId = data.run.run_id;
        notify(`Retry run created: ${data.run.run_id}`);
        await refreshRuns(false);
        await refreshRunDetail();
        await loadCatalog();
      } catch (e) {
        notify(`Retry failed: ${e.message}`, true);
      }
    }

    function renderDetail(data) {
      if (!data?.run) {
        document.getElementById("detail").textContent = "Select a run.";
        document.getElementById("run_badge").textContent = "none";
        document.getElementById("run_badge").className = "badge";
        document.getElementById("log_view").textContent = "";
        return;
      }
      const m = data.metrics || {};
      document.getElementById("detail").innerHTML = `
        <div><b>${esc(data.run.name)}</b> (${esc(data.run.run_id)})</div>
        <div class="muted">output_dir: ${esc(data.run.output_dir)}</div>
        <div style="margin-top:8px;">progress: ${esc(JSON.stringify(m.progress || {}))}</div>
        <div>targets=${esc(m.total_target_tasks)} completed=${esc(m.completed_task_dirs)} success=${esc(m.agent_success_count)} pending=${esc(m.pending_count)}</div>
        <div>failure_groups: ${esc(JSON.stringify(m.failure_groups || {}))}</div>
      `;
      const badge = document.getElementById("run_badge");
      badge.textContent = String(data.run.status || "unknown");
      badge.className = `badge ${String(data.run.status || "").toLowerCase()}`;
    }

    async function refreshRunDetail() {
      if (!state.selectedRunId) {
        renderDetail(null);
        return;
      }
      try {
        const data = await api(`/api/runs/${encodeURIComponent(state.selectedRunId)}`);
        renderDetail(data);
        const logs = await api(`/api/runs/${encodeURIComponent(state.selectedRunId)}/logs`);
        document.getElementById("log_view").textContent = logs.log || "";
      } catch (e) {
        notify(`Load run detail failed: ${e.message}`, true);
      }
    }

    async function selectRun(runId) {
      state.selectedRunId = runId;
      renderRuns();
      await refreshRunDetail();
      await loadCatalog();
    }

    function filteredRows() {
      const status = document.getElementById("filter_status").value;
      const site = document.getElementById("filter_site").value;
      const q = document.getElementById("filter_q").value.trim().toLowerCase();
      const targetOnly = document.getElementById("target_only").checked;

      let rows = state.catalogRows.slice();
      if (status !== "all") {
        if (status === "failed") {
          rows = rows.filter((row) => {
            const s = String(row.agent_status || "").toUpperCase();
            const raw = String(row.raw_agent_status || "").toUpperCase();
            return !["UNTRACKED", "NOT_IN_RUN", "PENDING", "RUNNING", "PAUSED"].includes(s) && raw !== "SUCCESS";
          });
        } else {
          rows = rows.filter((row) => String(row.agent_status || "").toLowerCase() === status);
        }
      }
      if (site !== "all") {
        rows = rows.filter((row) => (row.sites || []).map((s) => String(s).toLowerCase()).includes(site));
      }
      if (targetOnly) {
        rows = rows.filter((row) => !!row.in_target_run);
      }
      if (q) {
        rows = rows.filter((row) =>
          String(row.task_id).includes(q) ||
          String(row.intent || "").toLowerCase().includes(q) ||
          String(row.failure_class || "").toLowerCase().includes(q) ||
          String(row.error_details || "").toLowerCase().includes(q)
        );
      }

      rows.sort((a, b) => {
        const cmp = compareValues(a, b, state.sortBy);
        return state.sortDir === "asc" ? cmp : -cmp;
      });
      return rows;
    }

    function updateSiteFilter(rows) {
      const select = document.getElementById("filter_site");
      const previous = select.value;
      const set = new Set();
      for (const row of rows) {
        for (const site of row.sites || []) {
          set.add(String(site).toLowerCase());
        }
      }
      const options = Array.from(set).sort();
      select.innerHTML = '<option value="all">site: all</option>' + options.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
      if (options.includes(previous)) {
        select.value = previous;
      }
    }

    function renderTasks() {
      const rows = filteredRows();
      const tbody = document.querySelector("#tasks_table tbody");
      tbody.innerHTML = "";

      for (const row of rows) {
        const status = String(row.agent_status || "");
        const intent = String(row.intent || "");
        const intentShort = intent.length > 140 ? `${intent.slice(0, 140)}...` : intent;
        const canAct = !!state.selectedRunId;
        const canPause = canAct && status === "RUNNING";
        const canResume = canAct && status === "PAUSED";
        const liveHref = canAct ? `/runs/${encodeURIComponent(state.selectedRunId)}/tasks/${row.task_id}/live` : "#";

        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="status-cell">
            <span class="status-dot ${statusClass(status)}"></span>
            <span>${esc(status)}</span>
          </td>
          <td>${canAct ? `<a target="_blank" href="${liveHref}" rel="noopener">${esc(row.task_id)}</a>` : esc(row.task_id)}</td>
          <td>${esc((row.sites || []).join(","))}</td>
          <td class="intent" title="${esc(intent)}">${esc(intentShort)}</td>
          <td>${esc(row.eval_status || "")}</td>
          <td title="${esc(row.error_details || "")}">${esc(row.failure_class || "")}</td>
          <td class="actions">
            <button class="ghost" ${canAct ? "" : "disabled"} onclick="startTask(${row.task_id})">Start</button>
            <button class="ghost" ${canPause ? "" : "disabled"} onclick="pauseTask(${row.task_id})">Pause</button>
            <button class="ghost" ${canResume ? "" : "disabled"} onclick="resumeTask(${row.task_id})">Resume</button>
            <button class="warn" ${canAct ? "" : "disabled"} onclick="resetTask(${row.task_id})">Reset</button>
            ${canAct ? `<a class="mini-link" target="_blank" href="${liveHref}" rel="noopener">Live</a>` : ""}
          </td>
        `;
        tbody.appendChild(tr);
      }

      const total = state.catalogRows.length;
      document.getElementById("task_meta").textContent = `${rows.length} shown / ${total} total | run=${state.selectedRunId || "none"} | sort=${state.sortBy}:${state.sortDir}`;
      updateSortHints();
    }

    async function loadCatalog() {
      try {
        const params = new URLSearchParams();
        if (state.selectedRunId) params.set("run_id", state.selectedRunId);
        const data = await api(`/api/tasks/catalog?${params.toString()}`);
        state.catalogRows = data.rows || [];
        updateSiteFilter(state.catalogRows);
        renderTasks();
        await refreshTopSummary();
      } catch (e) {
        notify(`Load catalog failed: ${e.message}`, true);
      }
    }

    async function refreshCatalogFromCli() {
      try {
        const data = await api("/api/tasks/catalog/refresh", { method: "POST" });
        notify(data.message || "catalog refreshed");
        await loadCatalog();
      } catch (e) {
        notify(`Catalog refresh failed: ${e.message}`, true);
      }
    }

    async function startTask(taskId) {
      if (!state.selectedRunId) return;
      try {
        const data = await api(`/api/runs/${encodeURIComponent(state.selectedRunId)}/tasks/${taskId}/start`, { method: "POST" });
        state.selectedRunId = data.run.run_id;
        notify(`Task ${taskId} started in run ${data.run.run_id}`);
        await refreshRuns(false);
        await refreshRunDetail();
        await loadCatalog();
      } catch (e) {
        notify(`Start task ${taskId} failed: ${e.message}`, true);
      }
    }

    async function pauseTask(taskId) {
      if (!state.selectedRunId) return;
      try {
        const data = await api(`/api/runs/${encodeURIComponent(state.selectedRunId)}/tasks/${taskId}/pause`, { method: "POST" });
        notify(data.message || `Paused task ${taskId}`);
        await refreshRuns(false);
        await refreshRunDetail();
        await loadCatalog();
      } catch (e) {
        notify(`Pause task ${taskId} failed: ${e.message}`, true);
      }
    }

    async function resumeTask(taskId) {
      if (!state.selectedRunId) return;
      try {
        const data = await api(`/api/runs/${encodeURIComponent(state.selectedRunId)}/tasks/${taskId}/resume`, { method: "POST" });
        notify(data.message || `Resumed task ${taskId}`);
        await refreshRuns(false);
        await refreshRunDetail();
        await loadCatalog();
      } catch (e) {
        notify(`Resume task ${taskId} failed: ${e.message}`, true);
      }
    }

    async function resetTask(taskId) {
      if (!state.selectedRunId) return;
      const ok = confirm(`Reset task ${taskId}? This will remove task artifacts in selected run output dir.`);
      if (!ok) return;
      try {
        const data = await api(`/api/runs/${encodeURIComponent(state.selectedRunId)}/tasks/${taskId}/reset`, { method: "POST" });
        notify(data.message || `Task ${taskId} reset`);
        await refreshRunDetail();
        await loadCatalog();
      } catch (e) {
        notify(`Reset task ${taskId} failed: ${e.message}`, true);
      }
    }

    function wireFilters() {
      document.getElementById("filter_q").addEventListener("input", renderTasks);
      document.getElementById("filter_status").addEventListener("change", renderTasks);
      document.getElementById("filter_site").addEventListener("change", renderTasks);
      document.getElementById("target_only").addEventListener("change", renderTasks);

      document.querySelectorAll("#tasks_table thead th.sortable").forEach((th) => {
        th.addEventListener("click", () => {
          const key = th.dataset.sort;
          if (!key) return;
          if (state.sortBy === key) {
            state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
          } else {
            state.sortBy = key;
            state.sortDir = "asc";
          }
          renderTasks();
        });
      });
    }

    async function boot() {
      wireFilters();
      notify("Ready.");
      await refreshRuns(true);
      await refreshRunDetail();
      await loadCatalog();
      setInterval(async () => {
        try {
          await refreshRuns(false);
          if (state.selectedRunId) {
            await refreshRunDetail();
            await loadCatalog();
          }
        } catch (_) {}
      }, 6000);
    }

    boot();
  </script>
</body>
</html>
"""


SERIAL_HTML = """
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WebArena Serial Runner</title>
  <style>
    :root {
      --bg: #eef4f8;
      --ink: #0f172a;
      --muted: #475569;
      --card: rgba(255, 255, 255, 0.9);
      --line: rgba(15, 23, 42, 0.12);
      --accent: #0f766e;
      --danger: #b91c1c;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--ink);
      background:
        radial-gradient(980px 460px at -8% -12%, rgba(15,118,110,.17), transparent 60%),
        radial-gradient(920px 450px at 108% 4%, rgba(2,132,199,.16), transparent 60%),
        linear-gradient(170deg, #f2f6fb, #e7eef6);
      font-family: "Space Grotesk", "Avenir Next", "Segoe UI", sans-serif;
    }
    .app {
      max-width: 1320px;
      margin: 26px auto 42px;
      padding: 0 20px;
      display: grid;
      gap: 14px;
    }
    .panel {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 14px;
      box-shadow: 0 16px 34px rgba(15, 23, 42, 0.1);
      backdrop-filter: blur(8px);
    }
    .top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
    }
    h1 { margin: 0; font-size: 29px; line-height: 1.12; }
    h2 { margin: 0; font-size: 16px; }
    .muted { color: var(--muted); font-size: 12px; }
    .row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    input, button, select {
      height: 36px;
      border-radius: 10px;
      border: 1px solid rgba(15, 23, 42, .2);
      padding: 0 10px;
      font-size: 13px;
      background: rgba(255,255,255,.95);
      color: var(--ink);
      outline: none;
    }
    button {
      cursor: pointer;
      border-color: transparent;
      color: #f8fbff;
      background: linear-gradient(180deg, #0f9c90, var(--accent));
      font-weight: 600;
      box-shadow: 0 10px 18px rgba(15, 118, 110, .2);
    }
    button:hover { transform: translateY(-1px); }
    button.ghost {
      background: rgba(255,255,255,.86);
      color: #0f172a;
      border-color: rgba(15,23,42,.2);
      box-shadow: none;
    }
    button.warn {
      background: linear-gradient(180deg, #ef4444, var(--danger));
      box-shadow: 0 10px 18px rgba(185, 28, 28, .2);
    }
    button:disabled {
      opacity: .5;
      cursor: not-allowed;
      transform: none;
      box-shadow: none;
    }
    .grid {
      display: grid;
      grid-template-columns: 1.15fr .85fr;
      gap: 14px;
    }
    @media (max-width: 1160px) {
      .grid { grid-template-columns: 1fr; }
    }
    .badge {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      border: 1px solid rgba(15,23,42,.16);
      padding: 4px 10px;
      font-size: 11px;
      letter-spacing: .04em;
      text-transform: uppercase;
      font-weight: 700;
      background: rgba(255,255,255,.82);
    }
    .badge.running { color: #075985; background: rgba(2,132,199,.13); border-color: rgba(2,132,199,.35); }
    .badge.paused { color: #854d0e; background: rgba(250,204,21,.17); border-color: rgba(234,179,8,.4); }
    .badge.stopped, .badge.stopping { color: #991b1b; background: rgba(239,68,68,.13); border-color: rgba(239,68,68,.32); }
    .badge.completed { color: #166534; background: rgba(34,197,94,.13); border-color: rgba(34,197,94,.35); }
    .badge.idle { color: #334155; }
    .kv {
      display: grid;
      grid-template-columns: 180px 1fr;
      gap: 8px;
      font-size: 12px;
      margin-top: 8px;
    }
    .kv .k { color: var(--muted); }
    .toast {
      margin-top: 10px;
      border-radius: 10px;
      padding: 8px 10px;
      border: 1px solid rgba(15,23,42,.15);
      background: rgba(255,255,255,.9);
      font-size: 12px;
    }
    .toast.error {
      border-color: rgba(239,68,68,.35);
      background: rgba(254,226,226,.82);
      color: #991b1b;
    }
    .table-wrap {
      border: 1px solid rgba(15,23,42,.12);
      border-radius: 12px;
      overflow: auto;
      max-height: 520px;
      background: rgba(255,255,255,.84);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
      min-width: 700px;
    }
    th, td {
      border-bottom: 1px solid rgba(15,23,42,.08);
      padding: 7px 9px;
      text-align: left;
      vertical-align: top;
    }
    th {
      position: sticky;
      top: 0;
      background: rgba(241,247,255,.96);
      z-index: 1;
    }
    pre {
      margin: 0;
      border-radius: 10px;
      background: #071421;
      color: #d6e6fb;
      padding: 12px;
      white-space: pre-wrap;
      max-height: 300px;
      overflow: auto;
      font-size: 12px;
      line-height: 1.36;
    }
    a.link {
      color: #0f766e;
      font-weight: 600;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <main class="app">
    <section class="panel top">
      <div>
        <h1>Serial Evaluation Runner</h1>
        <div class="muted">Single-thread queue: run one task at a time with auto retry and auto skip controls.</div>
      </div>
      <div class="row">
        <a class="link" href="/" target="_blank" rel="noopener">Open Main Panel</a>
      </div>
    </section>

    <section class="panel">
      <div class="row" style="margin-bottom:10px;">
        <h2 style="margin-right:8px;">Session Setup</h2>
        <span class="muted">Create one serial session first, then control start/pause/resume/stop.</span>
      </div>
      <div class="row">
        <input id="name" placeholder="session name" size="20" />
        <input id="task_ids" placeholder="task ids optional (e.g. 0,1,2)" size="28" />
        <input id="exclude_sites" value="map,wikipedia" size="18" />
        <input id="timeout" type="number" value="420" min="30" max="7200" />
        <input id="max_retries" type="number" value="2" min="0" max="20" />
        <label class="muted"><input id="only_unsuccessful" type="checkbox" checked /> only unsuccessful</label>
        <label class="muted"><input id="auto_skip" type="checkbox" checked /> auto skip</label>
        <label class="muted"><input id="keep_sites_running" type="checkbox" /> keep sites</label>
        <input id="output_dir" placeholder="output dir optional" size="26" />
        <button onclick="createSession()">Create Session</button>
      </div>
      <div class="row" style="margin-top:10px;">
        <button onclick="startSession()">Start</button>
        <button class="ghost" onclick="pauseSession()">Pause</button>
        <button class="ghost" onclick="resumeSession()">Resume</button>
        <button class="warn" onclick="stopSession()">Stop</button>
        <button class="ghost" onclick="refreshState()">Refresh</button>
      </div>
      <div id="msg" class="toast"></div>
    </section>

    <section class="grid">
      <article class="panel">
        <div class="row" style="justify-content:space-between;">
          <h2>Session State</h2>
          <span id="status_badge" class="badge">idle</span>
        </div>
        <div id="state_kv" class="kv"></div>
      </article>
      <article class="panel">
        <div class="row" style="justify-content:space-between;">
          <h2>Current Run</h2>
          <a id="current_run_live" class="link" href="#" target="_blank" rel="noopener">Open Live</a>
        </div>
        <pre id="current_run_log"></pre>
      </article>
    </section>

    <section class="panel">
      <h2 style="margin-bottom:10px;">Attempt History</h2>
      <div class="table-wrap">
        <table id="history_table">
          <thead>
            <tr>
              <th>finished_at</th>
              <th>task_id</th>
              <th>attempt</th>
              <th>result</th>
              <th>run_id</th>
              <th>note</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    </section>
  </main>

  <script>
    let state = null;

    function esc(v) {
      return String(v ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
    }

    async function api(path, opt = {}) {
      const res = await fetch(path, opt);
      if (!res.ok) throw new Error(await res.text());
      return await res.json();
    }

    function notify(message, isError = false) {
      const el = document.getElementById("msg");
      el.textContent = message;
      el.classList.toggle("error", !!isError);
    }

    async function createSession() {
      const body = {
        name: document.getElementById("name").value.trim(),
        task_ids: document.getElementById("task_ids").value.trim(),
        exclude_sites: document.getElementById("exclude_sites").value.trim(),
        timeout_per_task: Number(document.getElementById("timeout").value || 420),
        max_retries: Number(document.getElementById("max_retries").value || 2),
        only_unsuccessful: document.getElementById("only_unsuccessful").checked,
        auto_skip: document.getElementById("auto_skip").checked,
        keep_sites_running: document.getElementById("keep_sites_running").checked,
        output_dir: document.getElementById("output_dir").value.trim(),
      };
      try {
        const data = await api("/api/serial/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        state = data.session;
        notify("Serial session created.");
        render();
      } catch (e) {
        notify(`Create failed: ${e.message}`, true);
      }
    }

    async function startSession() {
      try {
        const data = await api("/api/serial/session/start", { method: "POST" });
        notify(data.message || "Started");
        await refreshState();
      } catch (e) {
        notify(`Start failed: ${e.message}`, true);
      }
    }

    async function pauseSession() {
      try {
        const data = await api("/api/serial/session/pause", { method: "POST" });
        notify(data.message || "Paused");
        await refreshState();
      } catch (e) {
        notify(`Pause failed: ${e.message}`, true);
      }
    }

    async function resumeSession() {
      try {
        const data = await api("/api/serial/session/resume", { method: "POST" });
        notify(data.message || "Resumed");
        await refreshState();
      } catch (e) {
        notify(`Resume failed: ${e.message}`, true);
      }
    }

    async function stopSession() {
      try {
        const data = await api("/api/serial/session/stop", { method: "POST" });
        notify(data.message || "Stopped");
        await refreshState();
      } catch (e) {
        notify(`Stop failed: ${e.message}`, true);
      }
    }

    function renderKV(rowKey, rowVal) {
      return `<div class="k">${esc(rowKey)}</div><div>${esc(rowVal)}</div>`;
    }

    function renderHistory() {
      const tbody = document.querySelector("#history_table tbody");
      tbody.innerHTML = "";
      const rows = (state && state.history) ? state.history.slice().reverse() : [];
      for (const row of rows) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${esc(row.finished_at || "")}</td>
          <td>${esc(row.task_id)}</td>
          <td>${esc(row.attempt)}</td>
          <td>${esc(row.result)}</td>
          <td>${row.run_id ? `<a class="link" target="_blank" href="/runs/${encodeURIComponent(row.run_id)}/live" rel="noopener">${esc(row.run_id)}</a>` : ""}</td>
          <td>${esc(row.note || "")}</td>
        `;
        tbody.appendChild(tr);
      }
    }

    async function renderCurrentRunLog() {
      const runId = state && state.current_run_id ? String(state.current_run_id) : "";
      const liveLink = document.getElementById("current_run_live");
      const logEl = document.getElementById("current_run_log");
      if (!runId) {
        liveLink.href = "#";
        liveLink.style.opacity = ".45";
        logEl.textContent = "";
        return;
      }
      liveLink.href = `/runs/${encodeURIComponent(runId)}/live`;
      liveLink.style.opacity = "1";
      try {
        const data = await api(`/api/runs/${encodeURIComponent(runId)}/logs`);
        logEl.textContent = data.log || "";
      } catch (e) {
        logEl.textContent = `Failed to load run log: ${e.message}`;
      }
    }

    async function render() {
      const badge = document.getElementById("status_badge");
      const kv = document.getElementById("state_kv");
      if (!state || !state.exists) {
        badge.textContent = "idle";
        badge.className = "badge idle";
        kv.innerHTML = renderKV("session", "not created");
        renderHistory();
        await renderCurrentRunLog();
        return;
      }
      const status = String(state.status || "idle");
      badge.textContent = status;
      badge.className = `badge ${status}`;
      kv.innerHTML = [
        renderKV("session_id", state.session_id),
        renderKV("name", state.name),
        renderKV("output_dir", state.output_dir),
        renderKV("task progress", `${state.current_index || 0} / ${state.total_tasks || 0}`),
        renderKV("source tasks", state.source_total_tasks || state.total_tasks || 0),
        renderKV("skipped successful", state.skipped_success_tasks || 0),
        renderKV("current task", state.current_task_id || ""),
        renderKV("current attempt", state.current_attempt || ""),
        renderKV("current run", state.current_run_id || ""),
        renderKV("success / failed / skipped", `${state.success_count || 0} / ${state.failed_count || 0} / ${state.skipped_count || 0}`),
        renderKV("only_unsuccessful", state.only_unsuccessful),
        renderKV("max_retries", state.max_retries),
        renderKV("auto_skip", state.auto_skip),
        renderKV("timeout_per_task", state.timeout_per_task),
        renderKV("exclude_sites", state.exclude_sites || ""),
        renderKV("worker_alive", state.worker_alive),
        renderKV("last_message", state.last_message || ""),
        renderKV("updated_at", state.updated_at || ""),
      ].join("");
      renderHistory();
      await renderCurrentRunLog();
    }

    async function refreshState() {
      try {
        const data = await api("/api/serial/session");
        state = data.session || null;
        await render();
      } catch (e) {
        notify(`Refresh failed: ${e.message}`, true);
      }
    }

    async function boot() {
      await refreshState();
      setInterval(refreshState, 3000);
    }

    boot();
  </script>
</body>
</html>
"""


RUN_LIVE_HTML_TEMPLATE = """
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Run Live</title>
  <style>
    body {
      margin: 0;
      padding: 16px;
      background: linear-gradient(170deg, #eef2f8, #e2e8f2);
      color: #0f172a;
      font-family: "Space Grotesk", "Avenir Next", "Segoe UI", sans-serif;
    }
    .card {
      background: rgba(255,255,255,.88);
      border: 1px solid rgba(15,23,42,.12);
      border-radius: 14px;
      padding: 14px;
      margin-bottom: 12px;
      box-shadow: 0 14px 28px rgba(0,0,0,.08);
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      background: #071421;
      color: #d6e6fb;
      border-radius: 10px;
      padding: 12px;
      max-height: 70vh;
      overflow: auto;
      font-size: 12px;
      line-height: 1.35;
    }
    .muted { color: #475569; font-size: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <h2 style="margin:0 0 8px;">Run Live</h2>
    <div id="meta" class="muted">Loading...</div>
  </div>
  <div class="card">
    <pre id="logs"></pre>
  </div>
  <script>
    const runId = __RUN_ID__;
    async function api(path) {
      const res = await fetch(path);
      if (!res.ok) throw new Error(await res.text());
      return await res.json();
    }
    async function load() {
      try {
        const detail = await api(`/api/runs/${encodeURIComponent(runId)}`);
        const logs = await api(`/api/runs/${encodeURIComponent(runId)}/logs`);
        const m = detail.metrics || {};
        document.getElementById("meta").textContent =
          `run=${detail.run.run_id} status=${detail.run.status} progress=${JSON.stringify(m.progress || {})} success=${m.agent_success_count} pending=${m.pending_count}`;
        document.getElementById("logs").textContent = logs.log || "";
      } catch (e) {
        document.getElementById("meta").textContent = `Load failed: ${e.message}`;
      }
    }
    setInterval(load, 3000);
    load();
  </script>
</body>
</html>
"""


TASK_LIVE_HTML_TEMPLATE = """
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Task Live</title>
  <style>
    body {
      margin: 0;
      padding: 16px;
      background: linear-gradient(170deg, #eef2f8, #e2e8f2);
      color: #0f172a;
      font-family: "Space Grotesk", "Avenir Next", "Segoe UI", sans-serif;
    }
    .grid {
      display: grid;
      gap: 12px;
      grid-template-columns: 1fr 1fr;
    }
    @media (max-width: 1100px) {
      .grid { grid-template-columns: 1fr; }
    }
    .card {
      background: rgba(255,255,255,.88);
      border: 1px solid rgba(15,23,42,.12);
      border-radius: 14px;
      padding: 14px;
      box-shadow: 0 14px 28px rgba(0,0,0,.08);
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      background: #071421;
      color: #d6e6fb;
      border-radius: 10px;
      padding: 12px;
      max-height: 68vh;
      overflow: auto;
      font-size: 12px;
      line-height: 1.35;
    }
    .muted { color: #475569; font-size: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <h2 style="margin:0 0 8px;">Task Live</h2>
    <div id="meta" class="muted">Loading...</div>
  </div>
  <div class="grid">
    <div class="card">
      <h3 style="margin:0 0 8px;">Task Run Log</h3>
      <pre id="task_log"></pre>
    </div>
    <div class="card">
      <h3 style="margin:0 0 8px;">Agent + Eval Snapshot</h3>
      <pre id="snapshot"></pre>
    </div>
  </div>
  <script>
    const runId = __RUN_ID__;
    const taskId = __TASK_ID__;
    async function api(path) {
      const res = await fetch(path);
      if (!res.ok) throw new Error(await res.text());
      return await res.json();
    }
    async function load() {
      try {
        const data = await api(`/api/runs/${encodeURIComponent(runId)}/tasks/${taskId}`);
        const task = data.task || {};
        document.getElementById("meta").textContent =
          `run=${runId} task=${taskId} status=${task.agent_status || ""} failure=${task.failure_class || ""} eval=${task.eval_status || ""}`;
        document.getElementById("task_log").textContent = data.task_log || "";
        const payload = {
          task: data.task,
          agent_response: data.agent_response,
          eval_result: data.eval_result
        };
        document.getElementById("snapshot").textContent = JSON.stringify(payload, null, 2);
      } catch (e) {
        document.getElementById("meta").textContent = `Load failed: ${e.message}`;
      }
    }
    setInterval(load, 3000);
    load();
  </script>
</body>
</html>
"""


@app.get("/", response_class=HTMLResponse)
def home() -> str:
    return HOME_HTML


@app.get("/serial", response_class=HTMLResponse)
def serial_home() -> str:
    return SERIAL_HTML


@app.get("/runs/{run_id}/live", response_class=HTMLResponse)
def run_live_page(run_id: str) -> str:
    manager.get_run(run_id)
    return RUN_LIVE_HTML_TEMPLATE.replace("__RUN_ID__", json.dumps(run_id))


@app.get("/runs/{run_id}/tasks/{task_id}/live", response_class=HTMLResponse)
def task_live_page(run_id: str, task_id: int) -> str:
    manager.get_run(run_id)
    return (
        TASK_LIVE_HTML_TEMPLATE.replace("__RUN_ID__", json.dumps(run_id)).replace("__TASK_ID__", json.dumps(task_id))
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="WebArena evaluation manager service.")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host")
    parser.add_argument("--port", type=int, default=18100, help="Bind port")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    uvicorn.run(app, host=args.host, port=args.port, reload=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
