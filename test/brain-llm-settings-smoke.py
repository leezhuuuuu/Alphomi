#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

ROOT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT_DIR / "apps/brain/src"))

from alphomi_brain.core.llm_client import CustomLLMClient  # noqa: E402
from alphomi_brain.core.runtime_llm_config import resolve_runtime_llm_config  # noqa: E402
from alphomi_brain.utils.config import load_config_from_yaml  # noqa: E402


class SharedState:
    def __init__(self) -> None:
        self.desktop_payload: dict[str, Any] = {}
        self.requests: list[dict[str, Any]] = []


def _json_bytes(payload: Any) -> bytes:
    return json.dumps(payload).encode("utf-8")


def make_handler(state: SharedState):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            if self.path.startswith("/llm/effective"):
                body = _json_bytes({"success": True, "data": state.desktop_payload})
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return

            self.send_response(404)
            self.end_headers()

        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8") if length else "{}"
            payload = json.loads(raw or "{}")
            state.requests.append(
                {
                    "path": self.path,
                    "authorization": self.headers.get("Authorization"),
                    "payload": payload,
                }
            )

            if self.path == "/responses":
                body = _json_bytes(
                    {
                        "id": "resp_1",
                        "object": "response",
                        "model": payload.get("model"),
                        "output": [
                            {
                                "type": "message",
                                "role": "assistant",
                                "content": [
                                    {"type": "output_text", "text": "from responses"}
                                ],
                            }
                        ],
                    }
                )
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return

            if self.path == "/chat/completions":
                body = _json_bytes(
                    {
                        "id": "chatcmpl_1",
                        "object": "chat.completion",
                        "model": payload.get("model"),
                        "choices": [
                            {
                                "index": 0,
                                "message": {
                                    "role": "assistant",
                                    "content": "from chat completions",
                                },
                                "finish_reason": "stop",
                            }
                        ],
                    }
                )
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return

            self.send_response(404)
            self.end_headers()

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
            return

    return Handler


@contextmanager
def run_server(handler_cls):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


@contextmanager
def temp_registry(desktop_port: int):
    with tempfile.TemporaryDirectory(prefix="alphomi-llm-registry-") as tmp_dir:
        registry_path = Path(tmp_dir) / "ports.json"
        registry_path.write_text(
            json.dumps(
                {
                    "desktopControl": {
                        "port": desktop_port,
                        "url": f"http://127.0.0.1:{desktop_port}",
                        "ready": True,
                        "updatedAt": "2026-03-17T00:00:00Z",
                    }
                }
            ),
            encoding="utf-8",
        )
        yield registry_path


@contextmanager
def override_env(updates: dict[str, str | None]):
    original = {key: os.environ.get(key) for key in updates}
    try:
        for key, value in updates.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        yield
    finally:
        for key, value in original.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


async def main() -> None:
    state = SharedState()
    with run_server(make_handler(state)) as provider_server, run_server(make_handler(state)) as desktop_server:
        provider_base = f"http://127.0.0.1:{provider_server.server_address[1]}"
        desktop_port = desktop_server.server_address[1]
        state.desktop_payload = {
            "providerType": "openai_compatible",
            "activeProfileId": "desktop-main",
            "activeProfileLabel": "Desktop Main",
            "baseUrl": provider_base,
            "model": "desktop-model",
            "endpointMode": "responses",
            "apiKey": "desktop-key",
            "hasApiKey": True,
            "sources": {
                "baseUrl": "user",
                "model": "user",
                "endpointMode": "user",
                "apiKey": "user",
            },
        }

        with temp_registry(desktop_port) as registry_path, override_env(
            {
                "PORT_REGISTRY_PATH": str(registry_path),
                "DESKTOP_CONTROL_URL": None,
                "DESKTOP_CONTROL_PORT": None,
                "LLM_BASE_URL": None,
                "LLM_MODEL": None,
                "LLM_API_KEY": None,
                "LLM_ENDPOINT_MODE": None,
            }
        ):
            load_config_from_yaml("brain")

            resolved = await resolve_runtime_llm_config()
            assert resolved["base_url"] == provider_base
            assert resolved["model"] == "desktop-model"
            assert resolved["endpoint_mode"] == "responses"
            assert resolved["api_key"] == "desktop-key"
            assert resolved["sources"]["base_url"] == "user"

            client = CustomLLMClient()
            first = await client.chat_completion(
                messages=[{"role": "user", "content": "say hi"}]
            )
            assert first["choices"][0]["message"]["content"] == "from responses"
            assert state.requests[-1]["path"] == "/responses"
            assert state.requests[-1]["authorization"] == "Bearer desktop-key"
            assert state.requests[-1]["payload"]["model"] == "desktop-model"

            with override_env(
                {
                    "LLM_BASE_URL": provider_base,
                    "LLM_MODEL": "env-model",
                    "LLM_API_KEY": "env-key",
                    "LLM_ENDPOINT_MODE": "chat_completions",
                }
            ):
                resolved_override = await resolve_runtime_llm_config()
                assert resolved_override["base_url"] == provider_base
                assert resolved_override["model"] == "env-model"
                assert resolved_override["endpoint_mode"] == "chat_completions"
                assert resolved_override["api_key"] == "env-key"
                assert resolved_override["sources"]["model"] == "environment"

                client_override = CustomLLMClient()
                second = await client_override.chat_completion(
                    messages=[{"role": "user", "content": "say hi again"}]
                )
                assert second["choices"][0]["message"]["content"] == "from chat completions"
                assert state.requests[-1]["path"] == "/chat/completions"
                assert state.requests[-1]["authorization"] == "Bearer env-key"
                assert state.requests[-1]["payload"]["model"] == "env-model"

    print("[brain-llm-settings-smoke] passed")


if __name__ == "__main__":
    asyncio.run(main())
