import asyncio
import httpx
import os
from typing import Dict, Any, Optional

from .discovery import discover_driver_url

async def resolve_pras_base_url() -> str:
    # 不做永久缓存，避免在端口漂移/启动时序下锁死到错误地址
    return await discover_driver_url()


def _parse_timeout_ms(env_name: str, default_ms: int) -> float:
    raw = os.getenv(env_name)
    if not raw:
        return float(default_ms) / 1000.0
    try:
        parsed = int(raw)
        if parsed <= 0:
            return float(default_ms) / 1000.0
        return float(parsed) / 1000.0
    except ValueError:
        return float(default_ms) / 1000.0

class PrasClient:
    def __init__(self, session_id: str):
        self.session_id = session_id
        self.base_url: str | None = os.getenv("PRAS_URL")

    @classmethod
    async def create_session(
        cls,
        headless: bool = True,
        retries: int = 2,
        backoff_base: float = 0.3,
    ) -> str:
        base_url = await resolve_pras_base_url()
        url = f"{base_url}/sessions"
        attempts = max(0, retries) + 1
        last_error: Exception | None = None
        for attempt in range(attempts):
            async with httpx.AsyncClient(timeout=40.0) as client:
                try:
                    response = await client.post(url, json={"headless": headless})
                    if response.status_code == 200:
                        payload = response.json().get("data", {})
                        session_id = payload.get("sessionId")
                        if session_id:
                            return session_id
                        raise RuntimeError("PRAS create session returned empty sessionId")
                    if response.status_code == 400:
                        err_data = response.json()
                        code = err_data.get("code", "ERROR")
                        msg = err_data.get("error", "Unknown error")
                        raise RuntimeError(f"PRAS create session failed ({code}): {msg}")
                    response.raise_for_status()
                except Exception as e:
                    last_error = e
            if attempt < attempts - 1:
                await asyncio.sleep(backoff_base * (2 ** attempt))
        raise RuntimeError(f"PRAS create session failed: {last_error}") from last_error

    @classmethod
    async def close_session(cls, session_id: str) -> None:
        base_url = await resolve_pras_base_url()
        url = f"{base_url}/sessions/{session_id}"
        async with httpx.AsyncClient(timeout=20.0) as client:
            try:
                await client.delete(url)
            except Exception:
                pass

    async def _ensure_base_url(self) -> str:
        if self.base_url:
            return self.base_url
        self.base_url = await resolve_pras_base_url()
        return self.base_url

    async def get_storage_state(self, scope: str = "visited-origins") -> Dict[str, Any]:
        base_url = await self._ensure_base_url()
        url = f"{base_url}/sessions/{self.session_id}/storageState"
        async with httpx.AsyncClient(timeout=40.0) as client:
            try:
                response = await client.get(url, params={"scope": scope})
                if response.status_code == 200:
                    return response.json().get("data", {})
                if response.status_code == 400:
                    err_data = response.json()
                    code = err_data.get("code", "ERROR")
                    msg = err_data.get("error", "Unknown error")
                    return {"error": f"StorageState export failed ({code}): {msg}"}
                response.raise_for_status()
            except Exception as e:
                return {"error": f"StorageState export failed: {str(e)}"}

    async def apply_storage_state(
        self,
        cookies: list,
        local_storage: Dict[str, Any],
        merge_policy: str = "merge",
    ) -> Dict[str, Any]:
        base_url = await self._ensure_base_url()
        url = f"{base_url}/sessions/{self.session_id}/storageState"
        payload = {
            "cookies": cookies,
            "localStorage": local_storage,
            "mergePolicy": merge_policy,
        }
        async with httpx.AsyncClient(timeout=40.0) as client:
            try:
                response = await client.post(url, json=payload)
                if response.status_code == 200:
                    return response.json().get("data", {})
                if response.status_code == 400:
                    err_data = response.json()
                    code = err_data.get("code", "ERROR")
                    msg = err_data.get("error", "Unknown error")
                    return {"error": f"StorageState import failed ({code}): {msg}"}
                response.raise_for_status()
            except Exception as e:
                return {"error": f"StorageState import failed: {str(e)}"}

    async def call_tool(self, tool_name: str, args: Dict[str, Any]) -> Dict:
        base_url = await self._ensure_base_url()
        url = f"{base_url}/sessions/{self.session_id}/tools/{tool_name}"
        print(f"📡 [PRAS] Async Calling {tool_name}...")

        total_timeout = _parse_timeout_ms("PRAS_TOOL_TIMEOUT_MS", 90000)
        connect_timeout = _parse_timeout_ms("PRAS_TOOL_CONNECT_TIMEOUT_MS", 10000)
        timeout = httpx.Timeout(total_timeout, connect=connect_timeout)

        async with httpx.AsyncClient(timeout=timeout) as client:
            try:
                response = await client.post(url, json=args)
                
                # 🟢 正常响应
                if response.status_code == 200:
                    return response.json().get("data", {})
                
                # 🟢 错误透传处理
                if response.status_code == 400:
                    err_data = response.json()
                    code = err_data.get("code", "ERROR")
                    msg = err_data.get("error", "Unknown error")
                    # 返回给 LLM 的自然语言描述
                    return {"error": f"Tool Failed ({code}): {msg}"}

                response.raise_for_status()
                
            except httpx.ReadTimeout:
                timeout_ms = int(total_timeout * 1000)
                if tool_name == "browser_inspect_visual":
                    return {
                        "error": (
                            f"Timeout: Driver did not respond within {timeout_ms}ms while waiting for visual inspection. "
                            "The upstream vision model may be slow or timed out. Check apps/brain/logs/vllm_traces."
                        )
                    }
                return {"error": f"Timeout: Driver did not respond within {timeout_ms}ms."}
            except Exception as e:
                return {"error": f"System Error: {str(e)}"}

    async def navigate(self, url: str) -> str:
        result = await self.call_tool("browser_navigate", {"url": url})
        return result.get("result", "Navigation failed")

    async def click(self, ref: str, element: str = "Target Element") -> str:
        result = await self.call_tool("browser_click", {"ref": ref, "element": element})
        return result.get("result", "Click failed")

    async def type_text(self, ref: str, text: str, element: str = "Input Field") -> str:
        # 注意：这里我们暂时不传 submit 参数，保持最小修改
        result = await self.call_tool("browser_type", {"ref": ref, "text": text, "submit": True, "element": element})

        # 🟢 如果有错误，直接返回错误信息
        if "error" in result:
            return f"Type failed: {result['error']}"

        return result.get("result", "Type failed (Unknown reason)")

    async def get_snapshot(self) -> str:
        """
        获取页面快照 (YAML)
        """
        result = await self.call_tool("browser_snapshot", {})
        return result.get("snapshot", "No snapshot available")
