import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Lock
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field


ROOT = Path(__file__).resolve().parent
DEFAULT_MODEL = (
    ROOT
    / "models"
    / "luca_gpt_05_single_4B_gguf_gguf"
    / "Qwen3-4B.Q4_K_M.gguf"
)
MODEL_PATH = Path(os.environ.get("LUCA_GGUF_PATH", str(DEFAULT_MODEL)))
if not MODEL_PATH.is_absolute():
    MODEL_PATH = ROOT / MODEL_PATH

logger = logging.getLogger("local_chat")
generation_lock = Lock()


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=4000)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    history: list[ChatMessage] = Field(default_factory=list, max_length=40)


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.llm = None
    app.state.model_error = None

    try:
        if not MODEL_PATH.is_file():
            raise FileNotFoundError(f"GGUF model not found: {MODEL_PATH}")

        from llama_cpp import Llama, llama_supports_gpu_offload

        n_gpu_layers = -1 if llama_supports_gpu_offload() else 0
        app.state.llm = Llama(
            model_path=str(MODEL_PATH),
            n_ctx=int(os.environ.get("LUCA_CONTEXT_LENGTH", "4096")),
            n_gpu_layers=n_gpu_layers,
            verbose=False,
        )
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
    return FileResponse(ROOT / "local-chat.html")


@app.get("/local-chat.css")
async def local_chat_css():
    return FileResponse(ROOT / "local-chat.css", media_type="text/css")


@app.get("/local-chat.js")
async def local_chat_js():
    return FileResponse(
        ROOT / "local-chat.js",
        media_type="application/javascript",
    )


@app.get("/api/health")
async def health():
    if app.state.llm is None:
        raise HTTPException(
            status_code=503,
            detail=app.state.model_error or "モデルを読み込めませんでした。",
        )
    return {"ready": True, "model": MODEL_PATH.name}


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

    messages = [
        {
            "role": "system",
            "content": "あなたは永田です。親しみやすく自然なチャット口調でユーザーと会話してください。",
        }
    ]
    messages.extend(
        {"role": message.role, "content": message.content}
        for message in request.history
    )
    messages.append({"role": "user", "content": request.message})

    try:
        reply = await run_in_threadpool(generate_reply, llm, messages)
    except Exception as exc:
        logger.exception("Local model generation failed")
        raise HTTPException(
            status_code=500,
            detail="モデルの応答生成に失敗しました。サーバーログを確認してください。",
        ) from exc

    return {"reply": reply}
