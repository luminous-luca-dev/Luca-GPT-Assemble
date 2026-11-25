import asyncio
import json
import logging
import os
import re
from contextlib import asynccontextmanager
from functools import partial
from pathlib import Path
from threading import Lock
from typing import Literal
from uuid import UUID, uuid4

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field
from starlette.concurrency import iterate_in_threadpool


APP_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = APP_ROOT.parent
MODELS_ROOT = PROJECT_ROOT / "models"
DEFAULT_MODEL = (
    MODELS_ROOT
    / "luca_gpt_05_single_4B_gguf_gguf"
    / "Qwen3-4B.Q4_K_M.gguf"
)
MODEL_PATH = Path(os.environ.get("LUCA_GGUF_PATH", str(DEFAULT_MODEL)))
if not MODEL_PATH.is_absolute():
    MODEL_PATH = PROJECT_ROOT / MODEL_PATH
MODEL_PATH = MODEL_PATH.resolve()


def model_display_name(path: Path) -> str:
    return re.sub(r"(?:_gguf)+$", "", path.parent.name)


def model_id(path: Path) -> str | None:
    try:
        return path.resolve().relative_to(MODELS_ROOT.resolve()).as_posix()
    except ValueError:
        return None


def available_model_paths() -> list[Path]:
    if not MODELS_ROOT.is_dir():
        return []
    root = MODELS_ROOT.resolve()
    paths = []
    for path in MODELS_ROOT.rglob("*.gguf"):
        if not path.is_file():
            continue
        resolved_path = path.resolve()
        try:
            resolved_path.relative_to(root)
        except ValueError:
            continue
        paths.append(resolved_path)
    return sorted(paths, key=lambda path: path.as_posix().casefold())


def create_model(path: Path):
    if not path.is_file():
        raise FileNotFoundError(f"GGUF model not found: {path}")

    from llama_cpp import Llama, llama_supports_gpu_offload

    gpu_offload = llama_supports_gpu_offload()
    llm = Llama(
        model_path=str(path),
        n_ctx=int(os.environ.get("LUCA_CONTEXT_LENGTH", "4096")),
        n_gpu_layers=-1 if gpu_offload else 0,
        verbose=False,
    )
    try:
        template = llm.metadata.get("tokenizer.chat_template", "")
        if "enable_thinking is defined" in template:
            handler = llm._chat_handlers.get(llm.chat_format)
            if handler is None:
                raise RuntimeError("The GGUF chat template handler was not initialized.")
            # llama-cpp-python 0.3.x has no public per-request template-kwargs parameter.
            llm.chat_handler = partial(handler, enable_thinking=False)
    except Exception:
        llm.close()
        raise

    return llm, "GPU" if gpu_offload else "CPU"


SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_SECRET_KEY = (
    os.environ.get("SUPABASE_SECRET_KEY")
    or os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
)
def read_chat_context_mode() -> Literal["single-turn", "conversation"]:
    mode = os.environ.get("LUCA_CHAT_CONTEXT_MODE", "single-turn").strip().lower()
    if mode == "single-turn":
        return "single-turn"
    if mode == "conversation":
        return "conversation"
    raise ValueError(
        "LUCA_CHAT_CONTEXT_MODE must be 'single-turn' or 'conversation'."
    )


CHAT_CONTEXT_MODE = read_chat_context_mode()


def allowed_hosts() -> list[str]:
    hosts = ["localhost", "127.0.0.1"]
    hosts.extend(
        host.strip()
        for host in os.environ.get("LUCA_ALLOWED_HOSTS", "").split(",")
        if host.strip()
    )
    return hosts


logger = logging.getLogger("local_chat")
model_lock = Lock()
room_creation_lock = asyncio.Lock()


class ChatRequest(BaseModel):
    owner_id: UUID
    room_number: int = Field(ge=1)
    message: str = Field(min_length=1, max_length=4000)
    use_context: bool | None = None


class ConversationCreationRequest(BaseModel):
    owner_id: UUID | None = None


class ModelSelectionRequest(BaseModel):
    model_id: str = Field(min_length=1, max_length=512)


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.llm = None
    app.state.model_error = None
    app.state.model_device = None
    app.state.model_path = MODEL_PATH

    try:
        app.state.llm, app.state.model_device = create_model(MODEL_PATH)
        logger.info("Loaded GGUF model from %s", app.state.model_path)
    except Exception as exc:
        app.state.model_error = str(exc)
        logger.exception("Could not load the local GGUF model")

    yield


app = FastAPI(title="Luca local chat", lifespan=lifespan)
app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=allowed_hosts(),
)


@app.get("/")
async def home():
    return FileResponse(
        APP_ROOT / "local-chat.html",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/local-chat.css")
async def local_chat_css():
    return FileResponse(APP_ROOT / "local-chat.css", media_type="text/css")


@app.get("/local-chat.js")
async def local_chat_js():
    return FileResponse(
        APP_ROOT / "local-chat.js",
        media_type="application/javascript",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/health")
async def health():
    return {
        "model_ready": app.state.llm is not None,
        "model_error": app.state.model_error,
        "model": model_display_name(app.state.model_path),
        "device": app.state.model_device,
        "storage_ready": bool(SUPABASE_URL and SUPABASE_SECRET_KEY),
    }


@app.post("/api/conversations")
async def create_conversation(request: ConversationCreationRequest):
    async with room_creation_lock:
        owner_id = request.owner_id or uuid4()
        existing_rooms = await supabase_request(
            "GET",
            table="aichat_rooms",
            params={
                "select": "room_number",
                "owner_id": f"eq.{owner_id}",
                "order": "room_number.desc",
                "limit": "1",
            },
        )
        if not isinstance(existing_rooms, list):
            raise HTTPException(
                status_code=502,
                detail="トークルーム一覧を読み込めませんでした。",
            )
        room_number = 1
        if existing_rooms:
            latest_room = existing_rooms[0]
            if (
                not isinstance(latest_room, dict)
                or not isinstance(latest_room.get("room_number"), int)
                or latest_room["room_number"] < 1
            ):
                raise HTTPException(
                    status_code=502,
                    detail="トークルーム番号を読み込めませんでした。",
                )
            room_number = latest_room["room_number"] + 1

        rows = await supabase_request(
            "POST",
            table="aichat_rooms",
            payload=[
                {
                    "id": str(uuid4()),
                    "owner_id": str(owner_id),
                    "room_number": room_number,
                }
            ],
        )
        if (
            not isinstance(rows, list)
            or not rows
            or not isinstance(rows[0], dict)
            or rows[0].get("owner_id") != str(owner_id)
            or rows[0].get("room_number") != room_number
        ):
            raise HTTPException(
                status_code=502,
                detail="トークルームを作成できませんでした。",
            )

    return {
        "owner_id": str(owner_id),
        "room_number": room_number,
    }


@app.get("/api/conversations")
async def list_conversations(owner_id: UUID):
    rows = await supabase_request(
        "GET",
        table="aichat_rooms",
        params={
            "select": "room_number,updated_at",
            "owner_id": f"eq.{owner_id}",
            "order": "room_number.asc",
        },
    )
    if not isinstance(rows, list) or any(
        not isinstance(row, dict)
        or not all(key in row for key in ("room_number", "updated_at"))
        or not isinstance(row["room_number"], int)
        or row["room_number"] < 1
        for row in rows
    ):
        raise HTTPException(
            status_code=502,
            detail="トークルーム一覧を読み込めませんでした。",
        )
    return [
        {
            "room_number": row["room_number"],
            "updated_at": row["updated_at"],
        }
        for row in rows
    ]


@app.get("/api/settings")
async def get_settings():
    return {"default_context_enabled": CHAT_CONTEXT_MODE == "conversation"}


@app.get("/api/models")
async def list_models():
    paths = available_model_paths()
    models = [
        {
            "id": model_id(path),
            "name": model_display_name(path),
        }
        for path in paths
    ]
    active_model_id = model_id(app.state.model_path)
    if active_model_id is None:
        active_model_id = "__configured_model__"
        models.insert(
            0,
            {
                "id": active_model_id,
                "name": model_display_name(app.state.model_path),
            },
        )
    return {"models": models, "active_model_id": active_model_id}


def resolve_model_id(requested_id: str) -> Path:
    if requested_id == "__configured_model__" and model_id(app.state.model_path) is None:
        return app.state.model_path

    for path in available_model_paths():
        if model_id(path) == requested_id:
            return path
    raise HTTPException(status_code=404, detail="選択されたモデルが見つかりません。")


def switch_model(path: Path) -> None:
    path = path.resolve()
    with model_lock:
        if path == app.state.model_path and app.state.llm is not None:
            return

        previous_model = app.state.llm
        app.state.llm = None
        app.state.model_path = path
        app.state.model_device = None
        app.state.model_error = None

        try:
            if previous_model is not None:
                previous_model.close()
            app.state.llm, app.state.model_device = create_model(path)
        except Exception as exc:
            app.state.model_error = str(exc)
            logger.exception("Could not switch to GGUF model at %s", path)
            raise

        logger.info("Switched to GGUF model at %s", path)


@app.post("/api/models/select")
async def select_model(request: ModelSelectionRequest):
    path = resolve_model_id(request.model_id)
    try:
        await run_in_threadpool(switch_model, path)
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"モデルを読み込めませんでした: {exc}",
        ) from exc

    return {
        "model": model_display_name(app.state.model_path),
        "device": app.state.model_device,
        "model_ready": app.state.llm is not None,
    }


async def supabase_request(
    method: str,
    *,
    table: Literal["aichat_messages", "aichat_rooms"] = "aichat_messages",
    params: dict[str, str] | None = None,
    payload: list[dict[str, str | int]] | None = None,
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
                f"{SUPABASE_URL}/rest/v1/{table}",
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


async def get_conversation_messages(
    conversation_id: UUID,
    owner_id: UUID,
    room_number: int,
):
    messages = await supabase_request(
        "GET",
        params={
            "select": "sender,content,created_at",
            "conversation_id": f"eq.{conversation_id}",
            "owner_id": f"eq.{owner_id}",
            "room_number": f"eq.{room_number}",
            "order": "created_at.asc,id.asc",
        },
    )
    if not isinstance(messages, list):
        raise HTTPException(
            status_code=502,
            detail="Supabaseから会話履歴を読み込めませんでした。",
        )
    return messages


async def get_conversation_id(owner_id: UUID, room_number: int) -> UUID:
    rows = await supabase_request(
        "GET",
        table="aichat_rooms",
        params={
            "select": "id",
            "owner_id": f"eq.{owner_id}",
            "room_number": f"eq.{room_number}",
            "limit": "1",
        },
    )
    if not isinstance(rows, list):
        raise HTTPException(
            status_code=502,
            detail="トークルームを確認できませんでした。",
        )
    if not rows:
        raise HTTPException(status_code=404, detail="トークルームが見つかりません。")
    if not isinstance(rows[0], dict) or not isinstance(rows[0].get("id"), str):
        raise HTTPException(
            status_code=502,
            detail="トークルームの情報を読み込めませんでした。",
        )
    try:
        return UUID(rows[0]["id"])
    except ValueError as exc:
        raise HTTPException(
            status_code=502,
            detail="トークルームのIDが不正です。",
        ) from exc


async def insert_conversation_message(
    conversation_id: UUID,
    owner_id: UUID,
    room_number: int,
    sender: Literal["user", "assistant"],
    content: str,
):
    rows = await supabase_request(
        "POST",
        payload=[
            {
                "conversation_id": str(conversation_id),
                "owner_id": str(owner_id),
                "room_number": room_number,
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


@app.get("/api/conversations/{room_number}/messages")
async def load_conversation(room_number: int, owner_id: UUID):
    if room_number < 1:
        raise HTTPException(status_code=404, detail="トークルームが見つかりません。")
    conversation_id = await get_conversation_id(owner_id, room_number)
    return await get_conversation_messages(conversation_id, owner_id, room_number)


async def stream_model_reply(messages: list[dict[str, str]]):
    while not model_lock.acquire(blocking=False):
        await asyncio.sleep(0.01)

    stream = None
    try:
        llm = app.state.llm
        if llm is None:
            raise RuntimeError("No model is currently loaded.")

        stream = await run_in_threadpool(
            llm.create_chat_completion,
            messages=messages,
            max_tokens=512,
            temperature=0.7,
            top_p=0.8,
            stream=True,
        )
        async for chunk in iterate_in_threadpool(stream):
            delta = chunk["choices"][0].get("delta", {}).get("content")
            if delta is not None:
                if not isinstance(delta, str):
                    raise ValueError("The model returned an invalid content chunk.")
                if delta:
                    yield delta
    finally:
        try:
            close = getattr(stream, "close", None)
            if callable(close):
                await run_in_threadpool(close)
        finally:
            model_lock.release()


def generate_reply(messages: list[dict[str, str]]) -> str:
    with model_lock:
        llm = app.state.llm
        if llm is None:
            raise RuntimeError("No model is currently loaded.")
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


async def prepare_chat(
    request: ChatRequest,
) -> tuple[list[dict[str, str]], str, UUID]:
    conversation_id = await get_conversation_id(
        request.owner_id,
        request.room_number,
    )
    messages = [
        {
            "role": "system",
            "content": "あなたは永田です。親しみやすく自然なチャット口調でユーザーと会話してください。",
        }
    ]
    use_context = request.use_context
    if use_context is None:
        use_context = CHAT_CONTEXT_MODE == "conversation"
    if use_context:
        history = await get_conversation_messages(
            conversation_id,
            request.owner_id,
            request.room_number,
        )
        messages.extend(
            {
                "role": "user" if message["sender"] == "user" else "assistant",
                "content": message["content"],
            }
            for message in history[-40:]
        )

    user_created_at = await insert_conversation_message(
        conversation_id,
        request.owner_id,
        request.room_number,
        "user",
        request.message,
    )
    messages.append({"role": "user", "content": request.message})
    return messages, user_created_at, conversation_id


def sse_event(event: dict[str, str]) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


@app.post("/api/chat")
async def chat(request: ChatRequest):
    llm = app.state.llm
    if llm is None:
        raise HTTPException(
            status_code=503,
            detail=app.state.model_error or "モデルを読み込めませんでした。",
        )

    messages, user_created_at, conversation_id = await prepare_chat(request)

    try:
        reply = await run_in_threadpool(generate_reply, messages)
    except Exception as exc:
        logger.exception("Local model generation failed")
        raise HTTPException(
            status_code=500,
            detail="メッセージは保存されましたが、モデルの応答生成に失敗しました。",
        ) from exc

    try:
        assistant_created_at = await insert_conversation_message(
            conversation_id,
            request.owner_id,
            request.room_number,
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


@app.post("/api/chat/stream")
async def chat_stream(request: ChatRequest):
    if app.state.llm is None:
        raise HTTPException(
            status_code=503,
            detail=app.state.model_error or "モデルを読み込めませんでした。",
        )

    messages, _, conversation_id = await prepare_chat(request)

    async def events():
        reply_parts = []
        try:
            async for text in stream_model_reply(messages):
                reply_parts.append(text)
                yield sse_event({"type": "token", "text": text})
            reply = "".join(reply_parts).strip()
            if not reply:
                raise ValueError("The model returned an empty response.")
        except Exception:
            logger.exception("Local model streaming failed")
            yield sse_event(
                {
                    "type": "error",
                    "detail": "メッセージは保存されましたが、モデルの応答生成に失敗しました。",
                }
            )
            return

        try:
            assistant_created_at = await insert_conversation_message(
                conversation_id,
                request.owner_id,
                request.room_number,
                "assistant",
                reply,
            )
        except HTTPException:
            logger.exception("Could not save streamed assistant response")
            yield sse_event(
                {
                    "type": "error",
                    "detail": "応答は生成されましたが、Supabaseへの保存に失敗しました。",
                }
            )
            return

        yield sse_event(
            {
                "type": "done",
                "assistant_created_at": assistant_created_at,
            }
        )

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )
