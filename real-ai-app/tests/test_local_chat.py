import os
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from httpx import Request, Response

import local_chat


class FakeModel:
    def __init__(self, fail=False):
        self.fail = fail
        self.messages = None
        self.closed = False

    def create_chat_completion(self, messages, **kwargs):
        self.messages = messages
        if self.fail:
            raise RuntimeError("model failure")
        if kwargs.get("stream"):
            return iter(
                [
                    {"choices": [{"delta": {"content": "こん"}}]},
                    {"choices": [{"delta": {"content": "にちは！"}}]},
                ]
            )
        return {"choices": [{"message": {"content": "こんにちは！"}}]}

    def close(self):
        self.closed = True


class LocalChatTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.original_request = local_chat.supabase_request
        self.original_llm = getattr(local_chat.app.state, "llm", None)
        self.original_url = local_chat.SUPABASE_URL
        self.original_key = local_chat.SUPABASE_SECRET_KEY
        self.original_model_path = getattr(
            local_chat.app.state,
            "model_path",
            local_chat.MODEL_PATH,
        )
        self.original_model_device = getattr(
            local_chat.app.state,
            "model_device",
            None,
        )
        self.original_model_error = getattr(
            local_chat.app.state,
            "model_error",
            None,
        )
        self.original_context_mode = local_chat.CHAT_CONTEXT_MODE
        local_chat.app.state.model_path = local_chat.MODEL_PATH
        local_chat.CHAT_CONTEXT_MODE = "single-turn"
        local_chat.SUPABASE_URL = "https://example.supabase.co"
        local_chat.SUPABASE_SECRET_KEY = "test-key"

    async def asyncTearDown(self):
        local_chat.supabase_request = self.original_request
        local_chat.app.state.llm = self.original_llm
        local_chat.SUPABASE_URL = self.original_url
        local_chat.SUPABASE_SECRET_KEY = self.original_key
        local_chat.app.state.model_path = self.original_model_path
        local_chat.app.state.model_device = self.original_model_device
        local_chat.app.state.model_error = self.original_model_error
        local_chat.CHAT_CONTEXT_MODE = self.original_context_mode

    async def test_chat_loads_history_and_persists_both_messages(self):
        conversation_id = uuid.uuid4()
        stored = []

        async def fake_request(method, *, params=None, payload=None):
            if method == "GET":
                return [
                    {"sender": "user", "content": "前の発言"},
                    {"sender": "assistant", "content": "前の返事"},
                ]
            stored.extend(payload)
            return [{"created_at": "2026-11-25T00:00:00+00:00"}]

        model = FakeModel()
        local_chat.supabase_request = fake_request
        local_chat.app.state.llm = model
        local_chat.CHAT_CONTEXT_MODE = "conversation"

        result = await local_chat.chat(
            local_chat.ChatRequest(
                conversation_id=conversation_id,
                message="今の発言",
            )
        )

        self.assertEqual(result["reply"], "こんにちは！")
        self.assertEqual([row["sender"] for row in stored], ["user", "assistant"])
        self.assertEqual(
            model.messages[-3:],
            [
                {"role": "user", "content": "前の発言"},
                {"role": "assistant", "content": "前の返事"},
                {"role": "user", "content": "今の発言"},
            ],
        )

    async def test_single_turn_chat_does_not_read_or_send_previous_messages(self):
        requests = []

        async def fake_request(method, *, params=None, payload=None):
            requests.append(method)
            if method == "GET":
                return [
                    {"sender": "user", "content": "無視する過去の質問"},
                    {"sender": "assistant", "content": "無視する過去の回答"},
                ]
            return [{"created_at": "2026-11-25T00:00:00+00:00"}]

        model = FakeModel()
        local_chat.supabase_request = fake_request
        local_chat.app.state.llm = model

        await local_chat.chat(
            local_chat.ChatRequest(
                conversation_id=uuid.uuid4(),
                message="今回の質問",
            )
        )

        self.assertEqual(requests, ["POST", "POST"])
        self.assertEqual(
            model.messages,
            [
                {
                    "role": "system",
                    "content": "あなたは永田です。親しみやすく自然なチャット口調でユーザーと会話してください。",
                },
                {"role": "user", "content": "今回の質問"},
            ],
        )

    async def test_chat_can_enable_context_per_request(self):
        async def fake_request(method, *, params=None, payload=None):
            if method == "GET":
                return [
                    {"sender": "user", "content": "前の質問"},
                    {"sender": "assistant", "content": "前の回答"},
                ]
            return [{"created_at": "2026-11-25T00:00:00+00:00"}]

        model = FakeModel()
        local_chat.supabase_request = fake_request
        local_chat.app.state.llm = model

        await local_chat.chat(
            local_chat.ChatRequest(
                conversation_id=uuid.uuid4(),
                message="今回の質問",
                use_context=True,
            )
        )

        self.assertEqual(
            model.messages[-3:],
            [
                {"role": "user", "content": "前の質問"},
                {"role": "assistant", "content": "前の回答"},
                {"role": "user", "content": "今回の質問"},
            ],
        )

    async def test_model_failure_leaves_the_user_message_saved(self):
        stored = []

        async def fake_request(method, *, params=None, payload=None):
            if method == "GET":
                return []
            stored.extend(payload)
            return [{"created_at": "2026-11-25T00:00:00+00:00"}]

        local_chat.supabase_request = fake_request
        local_chat.app.state.llm = FakeModel(fail=True)

        with self.assertLogs(local_chat.logger, level="ERROR"):
            with self.assertRaises(HTTPException) as raised:
                await local_chat.chat(
                    local_chat.ChatRequest(
                        conversation_id=uuid.uuid4(),
                        message="今の発言",
                    )
                )

        self.assertEqual(raised.exception.status_code, 500)
        self.assertEqual([row["sender"] for row in stored], ["user"])

    async def test_stream_chat_sends_incremental_chunks_and_persists_reply(self):
        stored = []

        async def fake_request(method, *, params=None, payload=None):
            if method == "GET":
                return []
            stored.extend(payload)
            return [{"created_at": "2026-11-25T00:00:00+00:00"}]

        local_chat.supabase_request = fake_request
        local_chat.app.state.llm = FakeModel()
        response = await local_chat.chat_stream(
            local_chat.ChatRequest(
                conversation_id=uuid.uuid4(),
                message="こんにちは",
            )
        )

        events = []
        async for chunk in response.body_iterator:
            events.append(chunk.decode() if isinstance(chunk, bytes) else chunk)
        body = "".join(events)

        self.assertIn('"type": "token", "text": "こん"', body)
        self.assertIn('"type": "token", "text": "にちは！"', body)
        self.assertIn('"type": "done"', body)
        self.assertEqual(
            [(row["sender"], row["content"]) for row in stored],
            [("user", "こんにちは"), ("assistant", "こんにちは！")],
        )

    async def test_storage_requires_server_secret(self):
        local_chat.SUPABASE_SECRET_KEY = ""

        with self.assertRaises(HTTPException) as raised:
            await local_chat.supabase_request("GET")

        self.assertEqual(raised.exception.status_code, 503)

    async def test_supabase_request_sends_server_key_only_to_rest_api(self):
        requests = []

        class FakeClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return None

            async def request(self, method, url, *, headers, params, json):
                requests.append((method, url, headers, params, json))
                request = Request(method, url)
                return Response(200, json=[{"ok": True}], request=request)

        with patch.object(
            local_chat.httpx,
            "AsyncClient",
            return_value=FakeClient(),
        ):
            result = await local_chat.supabase_request(
                "GET",
                params={"conversation_id": "eq.test"},
            )

        self.assertEqual(result, [{"ok": True}])
        method, url, headers, params, _ = requests[0]
        self.assertEqual(method, "GET")
        self.assertEqual(url, "https://example.supabase.co/rest/v1/aichat_messages")
        self.assertEqual(headers["apikey"], "test-key")
        self.assertEqual(headers["Authorization"], "Bearer test-key")
        self.assertEqual(params, {"conversation_id": "eq.test"})

    async def test_model_label_uses_parent_directory_not_file_name(self):
        self.assertEqual(
            local_chat.model_display_name(local_chat.MODEL_PATH),
            "luca_gpt_05_single_4B",
        )

    async def test_create_conversation_returns_uuid4(self):
        result = await local_chat.create_conversation()

        self.assertEqual(uuid.UUID(result["conversation_id"]).version, 4)

    async def test_model_list_uses_gguf_parent_directory_as_label(self):
        with tempfile.TemporaryDirectory() as directory:
            model_path = Path(directory) / "luca_gpt_test_4B_gguf" / "model.gguf"
            model_path.parent.mkdir()
            model_path.touch()
            (model_path.parent / "weights.safetensors").touch()
            with patch.object(local_chat, "MODELS_ROOT", Path(directory)):
                local_chat.app.state.model_path = model_path
                result = await local_chat.list_models()

        self.assertEqual(
            result["models"],
            [{"id": "luca_gpt_test_4B_gguf/model.gguf", "name": "luca_gpt_test_4B"}],
        )
        self.assertEqual(
            result["active_model_id"],
            "luca_gpt_test_4B_gguf/model.gguf",
        )

    async def test_model_switch_closes_previous_model_and_loads_selected_model(self):
        with tempfile.TemporaryDirectory() as directory:
            model_path = Path(directory) / "luca_gpt_test_4B_gguf" / "model.gguf"
            model_path.parent.mkdir()
            model_path.touch()
            previous_model = FakeModel()
            selected_model = FakeModel()
            local_chat.app.state.llm = previous_model
            local_chat.app.state.model_path = Path(directory) / "old.gguf"
            with (
                patch.object(local_chat, "MODELS_ROOT", Path(directory)),
                patch.object(
                    local_chat,
                    "create_model",
                    return_value=(selected_model, "CPU"),
                ),
            ):
                result = await local_chat.select_model(
                    local_chat.ModelSelectionRequest(
                        model_id="luca_gpt_test_4B_gguf/model.gguf",
                    )
                )

        self.assertTrue(previous_model.closed)
        self.assertIs(local_chat.app.state.llm, selected_model)
        self.assertEqual(result["model"], "luca_gpt_test_4B")
        self.assertTrue(result["model_ready"])

    async def test_model_switch_rejects_paths_outside_models_directory(self):
        with self.assertRaises(HTTPException) as raised:
            await local_chat.select_model(
                local_chat.ModelSelectionRequest(model_id="../outside.gguf")
            )

        self.assertEqual(raised.exception.status_code, 404)

    async def test_allowed_hosts_can_include_configured_lan_address(self):
        with patch.dict(
            os.environ,
            {"LUCA_ALLOWED_HOSTS": "192.168.1.20, chat.local"},
        ):
            self.assertEqual(
                local_chat.allowed_hosts(),
                ["localhost", "127.0.0.1", "192.168.1.20", "chat.local"],
            )


if __name__ == "__main__":
    unittest.main()
