import os
import json
import httpx
from typing import List, Dict, Any, AsyncGenerator
from ..utils.config import load_config_from_yaml
from .runtime_llm_config import resolve_runtime_llm_config
# 引入新的 logger 函数
from ..utils.logger import save_llm_trace

load_config_from_yaml("brain")


def _should_retry_without_env_proxy(exc: Exception) -> bool:
    """判断当前异常是否适合降级为直连重试。"""
    if isinstance(exc, (httpx.ProxyError, httpx.ConnectError, httpx.ConnectTimeout)):
        return True
    lowered = str(exc).lower()
    indicators = (
        "nodename nor servname provided",
        "name or service not known",
        "temporary failure in name resolution",
        "failed to resolve",
    )
    return any(token in lowered for token in indicators)

class StreamResponseMerger:
    """
    用于将 SSE 流式碎片智能合并为完整的 Response 对象
    """
    def __init__(self):
        self.role = "assistant"
        self.content_parts = []
        # tool_calls 需要按 index 聚合，防止乱序或分片
        self.tool_calls_map = {}
        self.finish_reason = None
        self.usage = None
        self.model = None
        self.id = None

    def add(self, chunk: dict):
        """接收一个原始的 OpenAI 格式 chunk 并累积状态"""
        if not chunk: return

        # 1. 基础元数据
        if not self.id and chunk.get("id"): self.id = chunk["id"]
        if not self.model and chunk.get("model"): self.model = chunk["model"]

        # 2. Usage 信息 (通常在最后一个 chunk)
        if chunk.get("usage"):
            self.usage = chunk["usage"]

        # 3. 处理 Choices
        if not chunk.get("choices"):
            return

        choice = chunk["choices"][0] # Agent 通常只处理 n=1
        delta = choice.get("delta", {})

        # 更新结束原因
        if choice.get("finish_reason"):
            self.finish_reason = choice["finish_reason"]

        # 更新 Role
        if delta.get("role"):
            self.role = delta["role"]

        # A. 累积文本内容
        if delta.get("content"):
            self.content_parts.append(delta["content"])

        # B. 累积工具调用 (这是最复杂的，因为 id, name, args 都会分片)
        if delta.get("tool_calls"):
            for tc in delta["tool_calls"]:
                index = tc.get("index", 0)

                if index not in self.tool_calls_map:
                    self.tool_calls_map[index] = {
                        "id": "",
                        "type": "function",
                        "function": {"name": "", "arguments": ""}
                    }

                current = self.tool_calls_map[index]

                # 累积各个字段
                if tc.get("id"):
                    current["id"] = tc["id"]

                if tc.get("type"):
                    current["type"] = tc["type"]

                if tc.get("function"):
                    fn = tc["function"]
                    if fn.get("name"):
                        current["function"]["name"] += fn["name"]
                    if fn.get("arguments"):
                        current["function"]["arguments"] += fn["arguments"]

    def get_merged_response(self) -> dict:
        """返回合并后的标准格式响应"""
        message = {
            "role": self.role,
            "content": "".join(self.content_parts) if self.content_parts else None
        }

        # 如果有工具调用，转换为列表格式
        if self.tool_calls_map:
            # 按 index 排序确保顺序正确
            sorted_calls = [self.tool_calls_map[i] for i in sorted(self.tool_calls_map.keys())]
            message["tool_calls"] = sorted_calls

        return {
            "id": self.id,
            "object": "chat.completion", # 伪装成非流式对象
            "created": 0, # 可选，填当前时间戳
            "model": self.model,
            "choices": [
                {
                    "index": 0,
                    "message": message,
                    "finish_reason": self.finish_reason
                }
            ],
            "usage": self.usage
        }

class CustomLLMClient:
    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
        endpoint_mode: str | None = None,
    ):
        self.api_key = api_key or os.getenv("LLM_API_KEY")
        self.base_url = base_url or os.getenv("LLM_BASE_URL")
        self.model = model or os.getenv("LLM_MODEL", "glm-4")
        self.endpoint_mode = endpoint_mode or os.getenv("LLM_ENDPOINT_MODE", "auto")
        self.debug = os.getenv("DEBUG_LLM", "false").lower() == "true"
        # 预读取开关，减少 I/O
        self.save_traces = os.getenv("SAVE_LLM_TRACES", "false").lower() == "true"
        self.proxy_fallback_direct = (
            os.getenv("LLM_PROXY_FALLBACK_DIRECT", "true").lower() not in {"0", "false", "no"}
        )
        # 某些网关对 /responses 强制要求 stream=true，探测后记忆，避免每次先 400 再重试。
        self._responses_requires_stream = False
        self._manual_overrides = {
            "api_key": api_key,
            "base_url": base_url,
            "model": model,
            "endpoint_mode": endpoint_mode,
        }
        self._runtime_resolved = False

        if not self.api_key:
            print("⚠️ Warning: LLM_API_KEY not found")

    def _resolve_endpoint(self) -> tuple[str, str]:
        """
        自动识别 LLM_BASE_URL:
        - .../chat/completions
        - .../responses
        - 其他（默认视为 base，追加 /chat/completions）
        """
        base = (self.base_url or "").strip().rstrip("/")
        lowered = base.lower()
        forced = (self.endpoint_mode or "auto").strip()

        def strip_known_suffix(value: str) -> str:
            lowered_value = value.lower()
            if lowered_value.endswith("/chat/completions"):
                return value[: -len("/chat/completions")]
            if lowered_value.endswith("/responses"):
                return value[: -len("/responses")]
            return value

        if forced == "chat_completions":
            root = strip_known_suffix(base)
            return "chat_completions", f"{root}/chat/completions"
        if forced == "responses":
            root = strip_known_suffix(base)
            return "responses", f"{root}/responses"

        if lowered.endswith("/chat/completions"):
            return "chat_completions", base
        if lowered.endswith("/responses"):
            return "responses", base
        return "chat_completions", f"{base}/chat/completions"

    async def _ensure_runtime_config(self) -> None:
        if self._runtime_resolved:
            return

        resolved = await resolve_runtime_llm_config()
        self.api_key = self._manual_overrides["api_key"] or resolved.get("api_key") or self.api_key
        self.base_url = self._manual_overrides["base_url"] or resolved.get("base_url") or self.base_url
        self.model = self._manual_overrides["model"] or resolved.get("model") or self.model or "glm-4"
        self.endpoint_mode = (
            self._manual_overrides["endpoint_mode"]
            or resolved.get("endpoint_mode")
            or self.endpoint_mode
            or "auto"
        )
        self._runtime_resolved = True

        if not self.api_key:
            print("⚠️ Warning: LLM_API_KEY not found")

    @staticmethod
    def _normalize_tool_arguments(arguments: Any) -> str:
        if isinstance(arguments, str):
            return arguments
        if arguments is None:
            return "{}"
        try:
            return json.dumps(arguments, ensure_ascii=False)
        except Exception:
            return "{}"

    @staticmethod
    def _serialize_payload_value(value: Any) -> str:
        if value is None:
            return ""
        if isinstance(value, str):
            return value
        try:
            return json.dumps(value, ensure_ascii=False)
        except Exception:
            return str(value)

    def _convert_tools_for_responses(self, tools: List[Dict[str, Any]] | None) -> List[Dict[str, Any]]:
        if not tools:
            return []
        converted: List[Dict[str, Any]] = []
        for tool in tools:
            if not isinstance(tool, dict):
                continue
            if tool.get("type") == "function" and isinstance(tool.get("function"), dict):
                fn = tool["function"]
                item: Dict[str, Any] = {
                    "type": "function",
                    "name": fn.get("name"),
                    "description": fn.get("description"),
                    "parameters": fn.get("parameters"),
                }
                cleaned = {k: v for k, v in item.items() if v not in (None, "")}
                if "parameters" not in cleaned:
                    cleaned["parameters"] = {"type": "object", "properties": {}}
                converted.append(cleaned)
            else:
                converted.append(tool)
        return converted

    def _convert_messages_for_responses_input(
        self, messages: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        input_items: List[Dict[str, Any]] = []

        for msg in messages or []:
            if not isinstance(msg, dict):
                continue

            role = msg.get("role")
            content = msg.get("content")

            if role == "assistant" and msg.get("tool_calls"):
                if content not in (None, ""):
                    message_content = (
                        content
                        if isinstance(content, (str, list))
                        else self._serialize_payload_value(content)
                    )
                    input_items.append(
                        {
                            "role": "assistant",
                            "content": message_content,
                        }
                    )
                for tool_call in msg.get("tool_calls") or []:
                    if not isinstance(tool_call, dict):
                        continue
                    function = tool_call.get("function") or {}
                    input_items.append(
                        {
                            "type": "function_call",
                            "call_id": tool_call.get("id") or "",
                            "name": function.get("name") or "",
                            "arguments": self._normalize_tool_arguments(function.get("arguments")),
                        }
                    )
                continue

            if role == "tool":
                output = self._serialize_payload_value(content)
                input_items.append(
                    {
                        "type": "function_call_output",
                        "call_id": msg.get("tool_call_id") or "",
                        "output": output or "",
                    }
                )
                continue

            message_content = (
                content
                if isinstance(content, (str, list))
                else self._serialize_payload_value(content)
            )
            input_items.append(
                {
                    "role": role,
                    "content": message_content if message_content is not None else "",
                }
            )

        return input_items

    def _build_payload(
        self,
        mode: str,
        messages: List[Dict[str, Any]],
        tools: List[Dict[str, Any]] | None,
        stream: bool,
    ) -> Dict[str, Any]:
        if mode == "responses":
            payload: Dict[str, Any] = {
                "model": self.model,
                "input": self._convert_messages_for_responses_input(messages),
                "stream": stream,
                "temperature": 0.7,
            }
            if tools:
                payload["tools"] = self._convert_tools_for_responses(tools)
                payload["tool_choice"] = "auto"
            return payload

        payload = {
            "model": self.model,
            "messages": messages,
            "stream": stream,
        }
        if not stream:
            payload["temperature"] = 0.7
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        return payload

    def _normalize_responses_to_chat_completion(self, resp_json: Dict[str, Any]) -> Dict[str, Any]:
        if not isinstance(resp_json, dict):
            return {}
        if self._extract_error(resp_json) is not None:
            return resp_json
        if "choices" in resp_json:
            return resp_json

        output_items = resp_json.get("output") or []
        message_role = "assistant"
        text_parts: List[str] = []
        tool_calls: List[Dict[str, Any]] = []

        for item in output_items:
            if not isinstance(item, dict):
                continue
            item_type = item.get("type")

            if item_type == "message":
                if item.get("role"):
                    message_role = item.get("role")
                content_list = item.get("content")
                if isinstance(content_list, str) and content_list:
                    text_parts.append(content_list)
                    continue
                for content_item in content_list or []:
                    if not isinstance(content_item, dict):
                        continue
                    c_type = content_item.get("type")
                    if c_type in {"output_text", "text"} and content_item.get("text"):
                        text_parts.append(content_item["text"])
                continue

            if item_type == "function_call":
                args = self._normalize_tool_arguments(item.get("arguments"))
                tool_calls.append(
                    {
                        "id": item.get("call_id") or item.get("id") or "",
                        "type": "function",
                        "function": {
                            "name": item.get("name") or "",
                            "arguments": args,
                        },
                    }
                )
                continue

            if item_type in {"output_text", "text"} and item.get("text"):
                text_parts.append(item["text"])

        if not text_parts:
            output_text = resp_json.get("output_text")
            if isinstance(output_text, str) and output_text:
                text_parts.append(output_text)

        message: Dict[str, Any] = {
            "role": message_role,
            "content": "".join(text_parts) if text_parts else None,
        }
        if tool_calls:
            message["tool_calls"] = tool_calls

        finish_reason = "tool_calls" if tool_calls else "stop"
        return {
            "id": resp_json.get("id"),
            "object": "chat.completion",
            "created": resp_json.get("created_at", 0),
            "model": resp_json.get("model") or self.model,
            "choices": [
                {
                    "index": 0,
                    "message": message,
                    "finish_reason": finish_reason,
                }
            ],
            "usage": resp_json.get("usage"),
        }

    @staticmethod
    def _extract_error(resp_json: Dict[str, Any]) -> Any:
        if not isinstance(resp_json, dict):
            return None
        if "error" not in resp_json:
            return None
        error = resp_json.get("error")
        if error is None:
            return None
        if isinstance(error, dict):
            if not error:
                return None
            # 过滤 {"message": null, ...} 这类“有字段但无实际错误”的情况
            if not any(v not in (None, "") for v in error.values()):
                return None
        return error

    @staticmethod
    def _is_responses_stream_required_error(resp_json: Dict[str, Any]) -> bool:
        if not isinstance(resp_json, dict):
            return False
        error = resp_json.get("error")
        if not isinstance(error, dict):
            return False
        message = str(error.get("message", ""))
        return "stream must be set to true" in message.lower()

    async def _fetch_responses_via_stream(
        self,
        request_url: str,
        headers: Dict[str, str],
        messages: List[Dict[str, Any]],
        tools: List[Dict[str, Any]] | None,
        timeout_config: httpx.Timeout,
        trust_env: bool,
    ) -> Dict[str, Any]:
        """
        兼容某些网关对 /responses 强制 stream=true 的场景。
        返回原生 responses 对象（非 chat.completions 格式）。
        """
        payload = self._build_payload("responses", messages, tools, stream=True)
        final_response: Dict[str, Any] | None = None
        status_code = 0

        async with httpx.AsyncClient(timeout=timeout_config, http2=False, trust_env=trust_env) as client:
            async with client.stream("POST", request_url, headers=headers, json=payload) as response:
                status_code = response.status_code
                if status_code != 200:
                    body = (await response.aread()).decode("utf-8", errors="replace").strip()
                    try:
                        parsed = json.loads(body) if body else {}
                        if isinstance(parsed, dict):
                            return parsed
                    except Exception:
                        pass
                    return {
                        "error": {
                            "message": body or f"API Error {status_code}",
                            "type": "bad_response_status_code",
                            "param": "",
                            "code": "bad_response_status_code",
                        }
                    }

                async for line in response.aiter_lines():
                    if not line:
                        continue
                    decoded = line.strip()
                    if not decoded.startswith("data: "):
                        continue
                    if decoded == "data: [DONE]":
                        break

                    try:
                        event = json.loads(decoded[6:])
                    except Exception:
                        continue

                    # OpenAI Responses SSE 常见形式：{"type":"response.completed","response":{...}}
                    if isinstance(event, dict) and isinstance(event.get("response"), dict):
                        final_response = event["response"]
                        if event.get("type") == "response.completed":
                            break
                        continue

                    # 某些代理会直接回传 response object
                    if isinstance(event, dict) and event.get("object") == "response":
                        final_response = event
                        continue

        if final_response:
            return final_response
        return {
            "error": {
                "message": "No final response object found in streaming events.",
                "type": "bad_response_payload",
                "param": "",
                "code": "bad_response_payload",
            }
        }

    async def _stream_responses_via_non_stream(
        self, messages: List[Dict[str, Any]], tools: List[Dict[str, Any]] | None
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Responses 端点优先保证兼容性：先走一次非流式，再转换为现有事件流格式。
        """
        print("⚡ [LLM] Responses endpoint detected. Using compatibility streaming mode.")
        resp = await self.chat_completion(messages, tools=tools)
        if not resp:
            yield {"type": "error", "error": "Empty response from LLM API"}
            return

        if resp.get("error"):
            yield {"type": "error", "error": str(resp.get("error"))}
            return

        choices = resp.get("choices") or []
        if not choices:
            return

        message = choices[0].get("message") or {}
        content = message.get("content")
        if content:
            yield {"type": "content", "content": content}

        for tool_call in message.get("tool_calls") or []:
            if not isinstance(tool_call, dict):
                continue
            function = tool_call.get("function") or {}
            tool_id = tool_call.get("id") or ""
            tool_name = function.get("name") or "unknown_tool"
            tool_args = self._normalize_tool_arguments(function.get("arguments"))
            yield {"type": "tool_start", "id": tool_id, "name": tool_name}
            yield {
                "type": "tool_end",
                "id": tool_id,
                "name": tool_name,
                "args": tool_args,
            }

    async def chat_completion(self, messages: List[Dict[str, Any]], tools: List[Dict] = None) -> Dict:
        """
        普通非流式请求 (用于工具调用时的思考)
        """
        await self._ensure_runtime_config()

        if not self.base_url:
            return {"error": {"message": "LLM_BASE_URL is not configured"}}
        if not self.api_key:
            return {"error": {"message": "LLM_API_KEY is not configured"}}

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }

        endpoint_mode, request_url = self._resolve_endpoint()
        payload = self._build_payload(endpoint_mode, messages, tools, stream=False)

        # 无 tools 的请求是合法场景（例如首问标题生成），仅在 debug 模式打印。
        if self.debug and tools:
            print(f"🛠️ [LLM Client] Sending {len(tools)} tools to API.")
            if len(tools) > 0:
                print(f"   First tool: {tools[0].get('function', {}).get('name', 'Unknown')}")

        print(f"⚡ [LLM] Sending Request to {self.model} (Tools: {len(tools) if tools else 0})...")

        # === DEBUG LOG ===
        if self.debug:
            print(f"\n🚀 [LLM Request] Model: {self.model}")
            print(f"📤 [LLM Request] Mode: {endpoint_mode}")
            print(f"📤 [LLM Request] URL: {request_url}")
            print(f"📤 [LLM Request] Payload size: {len(json.dumps(payload))} chars")
            # print(json.dumps(payload, indent=2, ensure_ascii=False)) # 内容太多可注释掉

        response_data = {}
        status_code = 0

        trust_env_attempts = [True]
        if self.proxy_fallback_direct:
            trust_env_attempts.append(False)

        try:
            timeout_config = httpx.Timeout(120.0, connect=10.0)
            for idx, trust_env in enumerate(trust_env_attempts):
                try:
                    if endpoint_mode == "responses" and self._responses_requires_stream:
                        route = "proxy-env" if trust_env else "direct"
                        print(f"⚡ [LLM] Using cached responses-stream mode ({route})...")
                        raw_json = await self._fetch_responses_via_stream(
                            request_url=request_url,
                            headers=headers,
                            messages=messages,
                            tools=tools,
                            timeout_config=timeout_config,
                            trust_env=trust_env,
                        )
                        resp_json = self._normalize_responses_to_chat_completion(raw_json)
                        response_data = resp_json
                        return resp_json

                    async with httpx.AsyncClient(
                        timeout=timeout_config, http2=False, trust_env=trust_env
                    ) as client:
                        response = await client.post(
                            request_url,
                            headers=headers,
                            json=payload
                        )

                    status_code = response.status_code
                    route = "proxy-env" if trust_env else "direct"
                    print(f"⚡ [LLM] Connected ({route}). Received response...")

                    if self.debug:
                        print(f"📥 [LLM Response] Status: {response.status_code}")
                        print(f"📥 [LLM Response] Headers: {dict(response.headers)}")
                        print(f"📥 [LLM Response] Content-Type: {response.headers.get('content-type', 'Unknown')}")

                    try:
                        raw_json = response.json()
                        if (
                            endpoint_mode == "responses"
                            and self._is_responses_stream_required_error(raw_json)
                        ):
                            print("⚠️ [LLM] /responses requires stream=true. Retrying with streaming fallback...")
                            self._responses_requires_stream = True
                            raw_json = await self._fetch_responses_via_stream(
                                request_url=request_url,
                                headers=headers,
                                messages=messages,
                                tools=tools,
                                timeout_config=timeout_config,
                                trust_env=trust_env,
                            )
                        resp_json = (
                            self._normalize_responses_to_chat_completion(raw_json)
                            if endpoint_mode == "responses"
                            else raw_json
                        )
                        response_data = resp_json

                        if self.debug:
                            print(f"📥 [LLM Response] Response size: {len(json.dumps(resp_json))} chars")

                        error_obj = self._extract_error(resp_json)
                        if error_obj is not None:
                            print(f"❌ [LLM API Error] {error_obj}")

                        if 'choices' in resp_json and resp_json['choices']:
                            message = resp_json['choices'][0].get('message', {})
                            if message.get('tool_calls') and self.debug:
                                print(f"🔧 [LLM Response] Tool calls detected: {len(message['tool_calls'])}")
                                for tc in message['tool_calls']:
                                    print(f"   - {tc.get('function', {}).get('name', 'Unknown')}")

                        return resp_json
                    except json.JSONDecodeError as e:
                        response_data = response.text
                        print(f"❌ [LLM JSON Parse Error] {e}")
                        if self.debug:
                            print(f"❌ [LLM Error] Raw body (first 500 chars): {response.text[:500]}")
                        return {}
                    except Exception as e:
                        response_data = {"error": str(e), "raw": response.text}
                        print(f"❌ [LLM Response Error] {e}")
                        if self.debug:
                            print(f"❌ [LLM Error] Raw body (first 500 chars): {response.text[:500]}")
                        return {}

                except httpx.ReadTimeout:
                    status_code = 408
                    response_data = {"timeout": "Read Timeout. Model took too long to respond."}
                    print("❌ [LLM] Read Timeout. Model took too long to respond.")
                    return {}
                except httpx.ConnectTimeout as e:
                    status_code = 408
                    response_data = {"timeout": "Connect Timeout. Check your network/proxy."}
                    if trust_env and idx < len(trust_env_attempts) - 1:
                        print(f"⚠️ [LLM] Connect timeout via env proxy: {e}. Retrying direct...")
                        continue
                    print("❌ [LLM] Connect Timeout. Check your network/proxy.")
                    return {}
                except Exception as e:
                    status_code = 500
                    response_data = {"client_exception": str(e)}
                    if trust_env and idx < len(trust_env_attempts) - 1 and _should_retry_without_env_proxy(e):
                        print(f"⚠️ [LLM] Env proxy path failed: {e}. Retrying direct...")
                        continue
                    print(f"❌ [LLM Connection Error] {e}")
                    if self.debug:
                        print(f"❌ [LLM Exception] Type: {type(e)}")
                    return {}
            return {}

        finally:
            # 🟢 [新增] 无论成功失败，记录日志
            if self.save_traces:
                save_llm_trace(
                    request_payload=payload,
                    response_data=response_data,
                    url=request_url,
                    model=self.model,
                    status_code=status_code
                )

    async def stream_chat_completion(self, messages: List[Dict[str, Any]], tools: List[Dict] = None) -> AsyncGenerator[Dict, None]:
        """
        异步流式请求生成器 - 修复版 (关闭 http2，增加超时)
        """
        await self._ensure_runtime_config()

        if not self.base_url:
            yield {"type": "error", "error": "LLM_BASE_URL is not configured"}
            return
        if not self.api_key:
            yield {"type": "error", "error": "LLM_API_KEY is not configured"}
            return

        endpoint_mode, request_url = self._resolve_endpoint()
        if endpoint_mode == "responses":
            async for event in self._stream_responses_via_non_stream(messages, tools):
                yield event
            return

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }

        payload = self._build_payload(endpoint_mode, messages, tools, stream=True)

        print(f"⚡ [LLM] Sending Request to {self.model} (Tools: {len(tools) if tools else 0})...")
        status_code = 0
        merger = None

        # 🟢 设置更详细的超时策略
        # connect: 连接建立时间
        # read: 等待服务器返回第一个字节的时间 (LLM 思考时间可能较长，给 120秒)
        # write: 发送数据时间
        timeout_config = httpx.Timeout(120.0, connect=10.0)
        trust_env_attempts = [True]
        if self.proxy_fallback_direct:
            trust_env_attempts.append(False)

        for idx, trust_env in enumerate(trust_env_attempts):
            merger = StreamResponseMerger() if self.save_traces else None
            try:
                async with httpx.AsyncClient(
                    timeout=timeout_config, http2=False, trust_env=trust_env
                ) as client:
                    async with client.stream("POST", request_url, headers=headers, json=payload) as response:
                        status_code = response.status_code

                        if response.status_code != 200:
                            error_body = await response.aread()
                            error_str = error_body.decode('utf-8')
                            print(f"❌ [LLM API Error] Status: {response.status_code}")

                            if self.save_traces:
                                save_llm_trace(payload, {"error": error_str}, request_url, self.model, response.status_code)

                            error_str = error_str.strip()
                            if len(error_str) > 2000:
                                error_str = f"{error_str[:2000]}...(truncated)"
                            if error_str:
                                yield {
                                    "type": "error",
                                    "error": f"API Error {response.status_code}: {error_str}",
                                }
                            else:
                                yield {"type": "error", "error": f"API Error {response.status_code}"}
                            return

                        tool_calls_state = {}
                        route = "proxy-env" if trust_env else "direct"
                        print(f"⚡ [LLM] Connected ({route}). Receiving stream...")

                        async for line in response.aiter_lines():
                            if not line:
                                continue
                            decoded = line.strip()
                            if not decoded.startswith("data: "):
                                continue
                            if decoded == "data: [DONE]":
                                break

                            try:
                                chunk = json.loads(decoded[6:])

                                if merger:
                                    merger.add(chunk)

                                chunk_error = self._extract_error(chunk)
                                if chunk_error is not None:
                                    yield {
                                        "type": "error",
                                        "error": f"API Stream Error: {chunk_error}",
                                    }
                                    return

                                if not chunk.get('choices'):
                                    continue

                                delta = chunk['choices'][0].get('delta', {})
                                finish_reason = chunk['choices'][0].get('finish_reason')

                                if delta.get('content'):
                                    yield {"type": "content", "content": delta['content']}

                                if delta.get('tool_calls'):
                                    for tc in delta['tool_calls']:
                                        index = tc.get("index", 0)
                                        if index not in tool_calls_state:
                                            tool_calls_state[index] = {
                                                "id": "",
                                                "name": "",
                                                "args": "",
                                                "started": False
                                            }

                                        current = tool_calls_state[index]

                                        if tc.get("id"):
                                            current["id"] = tc["id"]

                                        if tc.get("function"):
                                            fn = tc["function"]
                                            if fn.get("name"):
                                                current["name"] += fn["name"]
                                            if fn.get("arguments"):
                                                current["args"] += fn["arguments"]

                                        if (not current["started"]) and current["id"] and current["name"]:
                                            current["started"] = True
                                            yield {"type": "tool_start", "id": current["id"], "name": current["name"]}

                                if finish_reason == 'tool_calls' and tool_calls_state:
                                    for index in sorted(tool_calls_state.keys()):
                                        current = tool_calls_state[index]
                                        if not current["started"]:
                                            current["started"] = True
                                            name = current["name"] or "unknown_tool"
                                            yield {"type": "tool_start", "id": current["id"], "name": name}
                                        yield {
                                            "type": "tool_end",
                                            "id": current["id"],
                                            "name": current["name"],
                                            "args": current["args"],
                                        }
                                    tool_calls_state = {}

                            except Exception as e:
                                print(f"⚠️ [LLM Parser] Skip chunk error: {e}")
                                continue

                if self.save_traces and merger and status_code == 200:
                    final_response = merger.get_merged_response()
                    save_llm_trace(
                        request_payload=payload,
                        response_data=final_response,
                        url=request_url,
                        model=self.model,
                        status_code=status_code
                    )
                return

            except Exception as e:
                if self.save_traces and merger:
                    partial_resp = merger.get_merged_response()
                    partial_resp["_client_error"] = str(e)
                    save_llm_trace(payload, partial_resp, request_url, self.model, status_code)

                if trust_env and idx < len(trust_env_attempts) - 1 and _should_retry_without_env_proxy(e):
                    print(f"⚠️ [LLM] Stream via env proxy failed: {e}. Retrying direct...")
                    continue

                print(f"❌ [LLM Stream Error] {e}")
                yield {"type": "error", "error": str(e)}
                return
