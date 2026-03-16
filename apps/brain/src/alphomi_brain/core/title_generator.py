from __future__ import annotations

import re
from typing import Optional

from .llm_client import CustomLLMClient


THINK_BLOCK_RE = re.compile(r"<think>.*?</think>", re.IGNORECASE | re.DOTALL)


def _strip_think_tags(text: str) -> str:
    if not text:
        return ""
    cleaned = THINK_BLOCK_RE.sub("", text)
    cleaned = cleaned.replace("<think>", "").replace("</think>", "")
    return cleaned


def _clean_text(text: str) -> str:
    text = _strip_think_tags((text or "").strip())
    text = re.sub(r"\s+", " ", text)
    text = text.strip("\"'`“”‘’")
    return text


def _truncate_title(text: str, max_chars: int = 18) -> str:
    text = _clean_text(text)
    if len(text) <= max_chars:
        return text
    return text[:max_chars].rstrip()


def _heuristic_title(question: str) -> str:
    text = _clean_text(question)
    if not text:
        return "新对话"
    # 去掉常见口语前缀，尽量保留任务主体
    text = re.sub(r"^(请|请你|麻烦|帮我|能否|可以|我想|我需要)+", "", text)
    text = text.strip("，。！？,.!? ")
    if not text:
        text = _clean_text(question)
    return _truncate_title(text)


TITLE_SYSTEM_PROMPT = (
    "你是一个对话标题生成助手。请根据用户的首个问题生成一个简短、具体的中文标题。"
    "要求：1) 仅输出标题本身；2) 不要标点和引号；3) 8-16个汉字优先；"
    "4) 标题应是对问题的总结，不要使用泛化词如‘问题’‘请求’。"
)


async def generate_title_from_first_question(first_question: str) -> str:
    question = _clean_text(first_question)
    if not question:
        return "新对话"

    client = CustomLLMClient()
    try:
        response = await client.chat_completion(
            messages=[
                {"role": "system", "content": TITLE_SYSTEM_PROMPT},
                {"role": "user", "content": question},
            ],
            tools=None,
        )
        choices = response.get("choices") or []
        if choices:
            message = choices[0].get("message") or {}
            content = message.get("content")
            if isinstance(content, str):
                title = _truncate_title(content)
                if title:
                    return title
    except Exception:
        pass

    return _heuristic_title(question)
