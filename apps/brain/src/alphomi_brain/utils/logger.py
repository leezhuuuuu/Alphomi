import os
import json
import datetime
import uuid
from pathlib import Path
from typing import Any, Dict

def save_session_log(session_id: str, messages: list):
    """
    将会话历史保存为 JSON 文件
    """
    # 1. 检查开关
    should_save = os.getenv("SAVE_SESSION_LOGS", "false").lower() == "true"
    if not should_save:
        return

    # 2. 准备目录
    log_dir = os.getenv("SESSION_LOGS_DIR", "logs")
    # 获取 brain 的根目录路径 (假设当前运行在 apps/brain)
    base_path = Path(os.getcwd()) 
    full_log_dir = base_path / log_dir
    
    try:
        full_log_dir.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        print(f"❌ [Logger] Failed to create log directory: {e}")
        return

    # 3. 生成文件名 (时间戳 + SessionID)
    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    # 如果没有 session_id (比如连接初期就断了)，用 'unknown'
    safe_sid = session_id if session_id else "unknown"
    filename = f"session_{timestamp}_{safe_sid}.json"
    file_path = full_log_dir / filename

    # 4. 构造完整数据结构
    log_data = {
        "sessionId": safe_sid,
        "timestamp": timestamp,
        "messageCount": len(messages),
        "messages": messages
    }

    # 5. 写入文件
    try:
        with open(file_path, "w", encoding="utf-8") as f:
            # ensure_ascii=False 保证中文正常显示
            # indent=2 保证换行和缩进，方便调试
            json.dump(log_data, f, ensure_ascii=False, indent=2)
        print(f"💾 [Logger] Session log saved to: {file_path}")
    except Exception as e:
        print(f"❌ [Logger] Failed to write log file: {e}")


def save_llm_trace(request_payload: Dict, response_data: Any, url: str, model: str, status_code: int = 200):
    """
    保存单次 LLM 请求的详细 Trace (Request + Response)
    """
    # 1. 检查开关
    should_save = os.getenv("SAVE_LLM_TRACES", "false").lower() == "true"
    if not should_save:
        return

    # 2. 准备目录
    log_dir = os.getenv("LLM_TRACES_DIR", "logs/traces")
    base_path = Path(os.getcwd())
    full_log_dir = base_path / log_dir

    try:
        full_log_dir.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        print(f"❌ [Logger] Failed to create trace directory: {e}")
        return

    # 3. 生成文件名 (时间戳 + UUID 前缀，保证毫秒级并发不冲突)
    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    short_id = str(uuid.uuid4())[:8]
    filename = f"trace_{timestamp}_{short_id}.json"
    file_path = full_log_dir / filename

    # 4. 处理响应数据 (可能是 JSON 对象，也可能是字符串流)
    final_response = response_data
    # 如果是字符串且看起来像 JSON，尝试解析以便美化显示
    if isinstance(response_data, str):
        try:
            if response_data.strip().startswith("{") or response_data.strip().startswith("["):
                final_response = json.loads(response_data)
        except:
            pass # 解析失败就存原始字符串

    # 5. 构造完整数据结构
    trace_data = {
        "timestamp": datetime.datetime.now().isoformat(),
        "meta": {
            "url": url,
            "model": model,
            "status_code": status_code
        },
        "request": request_payload,
        "response": final_response
    }

    # 6. 写入文件
    try:
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(trace_data, f, ensure_ascii=False, indent=2)
        # 仅在调试模式下打印，避免刷屏
        # print(f"📝 [Logger] LLM trace saved: {filename}")
    except Exception as e:
        print(f"❌ [Logger] Failed to write trace file: {e}")
