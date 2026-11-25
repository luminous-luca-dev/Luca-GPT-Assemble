import logging
import os
import re
from contextlib import asynccontextmanager
from functools import partial
from pathlib import Path
from threading import Lock
from typing import Literal
from uuid import UUID

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field


APP_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = APP_ROOT.parent
DEFAULT_MODEL = (
    PROJECT_ROOT
    / "models"
    / "luca_gpt_05_single_4B_gguf_gguf"
    / "Qwen3-4B.Q4_K_M.gguf"
)
MODEL_PATH = Path(os.environ.get("LUCA_GGUF_PATH", str(DEFAULT_MODEL)))
if not MODEL_PATH.is_absolute():
    MODEL_PATH = PROJECT_ROOT / MODEL_PATH
MODEL_DISPLAY_NAME = re.sub(r"(?:_gguf)+$", "", MODEL_PATH.parent.name)
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_SECRET_KEY = (
    os.environ.get("SUPABASE_SECRET_KEY")
    or os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
)

logger = logging.getLogger("local_chat")
generation_lock = Lock()


class ChatRequest(BaseModel):
    conversation_id: UUID
    message: str = Field(min_length=1, max_length=4000)


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.llm = None
    app.state.model_error = None
    app.state.model_device = None

    try:
        if not MODEL_PATH.is_file():
            raise FileNotFoundError(f"GGUF model not found: {MODEL_PATH}")

        from llama_cpp import Llama, llama_supports_gpu_offload

        gpu_offload = llama_supports_gpu_offload()
        app.state.llm = Llama(
            model_path=str(MODEL_PATH),
            n_ctx=int(os.environ.get("LUCA_CONTEXT_LENGTH", "4096")),
            n_gpu_layers=-1 if gpu_offload else 0,
            verbose=False,
        )
        template = app.state.llm.metadata.get("tokenizer.chat_template", "")
        if "enable_thinking is defined" in template:
            handler = app.state.llm._chat_handlers.get(app.state.llm.chat_format)
            if handler is None:
                raise RuntimeError("The GGUF chat template handler was not initialized.")
            # llama-cpp-python 0.3.x has no public per-request template-kwargs parameter.
            app.state.llm.chat_handler = partial(handler, enable_thinking=False)
        app.state.model_device = "GPU" if gpu_offload else "CPU"
        logger.info("Loaded GGUF model from %s", MODEL_PATH)
    except Exception as exc:
        app.state.model_error = str(exc)
        logger.exception("Could not load the local GGUF model")

    yield


app = FastAPI(title="Luca local chat", lifespan=lifespan)
app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=["localhost", "127.0.0.1"],
)


@app.get("/")
async def home():
    return FileResponse(APP_ROOT / "local-chat.html")


@app.get("/local-chat.css")
async def local_chat_css():
    return FileResponse(APP_ROOT / "local-chat.css", media_type="text/css")


@app.get("/local-chat.js")
async def local_chat_js():
    return FileResponse(
        APP_ROOT / "local-chat.js",
        media_type="application/javascript",
    )


@app.get("/api/health")
async def health():
    return {
        "model_ready": app.state.llm is not None,
        "model_error": app.state.model_error,
        "model": MODEL_DISPLAY_NAME,
        "device": app.state.model_device,
        "storage_ready": bool(SUPABASE_URL and SUPABASE_SECRET_KEY),
    }


async def supabase_request(
    method: str,
    *,
    params: dict[str, str] | None = None,
    payload: list[dict[str, str]] | None = None,
):
    if not SUPABASE_URL or not SUPABASE_SECRET_KEY:
        raise HTTPException(
            status_code=503,
            detail="Supabaseの設定がありません。.envにURLとsecret keyを設定してください。",
        )

    headers = {
        "apikey": SUPABASE_SECRET_KEY,
        "Authorization": f"Bearer {SUPABASE_SECRET_KEY}",
        "Prefer": "return=representation",
    }
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.request(
                method,
                f"{SUPABASE_URL}/rest/v1/aichat_messages",
                headers=headers,
                params=params,
                json=payload,
            )
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        logger.error("Supabase REST request failed with status %s", exc.response.status_code)
        raise HTTPException(
            status_code=502,
            detail="Supabaseへのアクセスに失敗しました。テーブルと権限を確認してください。",
        ) from exc
    except httpx.RequestError as exc:
        logger.exception("Could not connect to Supabase")
        raise HTTPException(
            status_code=502,
            detail="Supabaseに接続できませんでした。",
        ) from exc

    return response.json() if response.content else None


async def get_conversation_messages(conversation_id: UUID):
    messages = await supabase_request(
        "GET",
        params={
            "select": "sender,content,created_at",
            "conversation_id": f"eq.{conversation_id}",
            "order": "created_at.asc,id.asc",
        },
    )
    if not isinstance(messages, list):
        raise HTTPException(
            status_code=502,
            detail="Supabaseから会話履歴を読み込めませんでした。",
        )
    return messages


async def insert_conversation_message(
    conversation_id: UUID,
    sender: Literal["user", "assistant"],
    content: str,
):
    rows = await supabase_request(
        "POST",
        payload=[
            {
                "conversation_id": str(conversation_id),
                "sender": sender,
                "content": content,
            }
        ],
    )
    if not isinstance(rows, list) or not rows or "created_at" not in rows[0]:
        raise HTTPException(
            status_code=502,
            detail="Supabaseにメッセージを保存できませんでした。",
        )
    return rows[0]["created_at"]


@app.get("/api/conversations/{conversation_id}/messages")
async def load_conversation(conversation_id: UUID):
    return await get_conversation_messages(conversation_id)


def generate_reply(llm, messages: list[dict[str, str]]) -> str:
    with generation_lock:
        result = llm.create_chat_completion(
            messages=messages,
            max_tokens=512,
            temperature=0.7,
            top_p=0.8,
        )
    content = result["choices"][0]["message"]["content"]
    if not isinstance(content, str) or not content.strip():
        raise ValueError("The model returned an empty response.")
    return content.strip()


@app.post("/api/chat")
async def chat(request: ChatRequest):
    llm = app.state.llm
    if llm is None:
        raise HTTPException(
            status_code=503,
            detail=app.state.model_error or "モデルを読み込めませんでした。",
        )

    history = await get_conversation_messages(request.conversation_id)
    user_created_at = await insert_conversation_message(
        request.conversation_id,
        "user",
        request.message,
    )
    messages = [
        {
            "role": "system",
            "content": "あなたは永田です。親しみやすく自然なチャット口調でユーザーと会話してください。",
        }
    ]
    messages.extend(
        {
            "role": "user" if message["sender"] == "user" else "assistant",
            "content": message["content"],
        }
        for message in history[-40:]
    )
    messages.append({"role": "user", "content": request.message})

    try:
        reply = await run_in_threadpool(generate_reply, llm, messages)
    except Exception as exc:
        logger.exception("Local model generation failed")
        raise HTTPException(
            status_code=500,
            detail="メッセージは保存されましたが、モデルの応答生成に失敗しました。",
        ) from exc

    try:
        assistant_created_at = await insert_conversation_message(
            request.conversation_id,
            "assistant",
            reply,
        )
    except HTTPException as exc:
        raise HTTPException(
            status_code=502,
            detail="応答は生成されましたが、Supabaseへの保存に失敗しました。",
        ) from exc

    return {
        "reply": reply,
        "user_created_at": user_created_at,
        "assistant_created_at": assistant_created_at,
    }
