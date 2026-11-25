# Local Luca GPT chat

The local chat uses the latest GGUF export at
`../models/luca_gpt_05_single_4B_gguf_gguf/Qwen3-4B.Q4_K_M.gguf` by default.
It serves a separate chat page and leaves the existing public chat app unchanged.

## Setup on Windows

The included `llama-cpp-python` wheel index targets CUDA 13.0 and the RTX 4060.
Use Python 3.10 for the prebuilt Windows CUDA wheel:

```powershell
Set-Location real-ai-app
py -3.10 -m pip install -r requirements-local.txt
```

Set the Supabase project URL and its server-side secret key (`sb_secret_...`)
in `real-ai-app/.env` (ignored by Git). Copy it from the project's Settings > API Keys.
Never put this key in browser code or commit it. The legacy
`SUPABASE_SERVICE_ROLE_KEY` environment variable is also accepted.

Run the SQL in
`../supabase/migrations/20261125145000_create_local_chat_messages.sql` in the
Supabase SQL Editor to create the dedicated message table. If the equivalent
SQL for `aichat_messages` has already been applied, no additional SQL is needed.

Start the chat server from `real-ai-app`:

```powershell
py -3.10 -m uvicorn local_chat:app --host 127.0.0.1 --port 8000 --env-file .env
```

Then open <http://127.0.0.1:8000/>. By default, the server binds to loopback
only. The model loads when the server starts. If `llama-cpp-python` cannot be
installed or the GGUF file is missing, the chat page will show the error and
the server log will contain details.
For a CPU-only setup or a different Python/CUDA version, replace the `cu130`
wheel index in `real-ai-app/requirements-local.txt` with the matching index documented by
llama-cpp-python.

## Access from a phone on the same Wi-Fi

LAN access is opt-in. Find the PC's Wi-Fi IPv4 address with `ipconfig`, then
add that address to `LUCA_ALLOWED_HOSTS` in `real-ai-app/.env` (for example,
`LUCA_ALLOWED_HOSTS=192.168.1.20`). Start the server bound to that exact
address, replacing the example with the PC's address:

```powershell
py -3.10 -m uvicorn local_chat:app --host 192.168.1.20 --port 8000 --env-file .env
```

On the phone, open `http://192.168.1.20:8000/`. If it still cannot connect,
allow inbound TCP port 8000 for the Windows Private network profile and check
that the Wi-Fi network does not isolate wireless clients. This app currently
has no user authentication, so use this only on a trusted private network and
do not configure router port forwarding.

To select another GGUF file, set `LUCA_GGUF_PATH` before starting the server.
Relative model paths are resolved from the repository root.
`LUCA_CONTEXT_LENGTH` optionally changes the context length (default `4096`).

## Switching models

Open the gear button in the chat header to access settings. There you can
switch between GGUF files under the repository's `models/` directory; the
displayed model name comes from its parent directory. Only one model is kept
loaded, and switching models affects all clients connected to this server.
Refresh the page after adding new GGUF files so they appear in the selector.
Assistant replies stream into the message bubble as the model generates them;
the bubble shows `考え中...` until the first text arrives.

The settings dialog also lets each browser choose whether earlier messages in
the current conversation are included in the model prompt. This choice is
saved in that browser; messages remain visible and stored either way. By
default, only the current message and system prompt are sent. The server
default can be changed to conversation mode with
`LUCA_CHAT_CONTEXT_MODE=conversation` in `.env`.

## Message storage

Messages use the dedicated `aichat_messages` table. The local FastAPI server
reads and writes user messages, model replies, and conversation history using
the service role key from `real-ai-app/.env`; the browser never receives this key. Each
conversation is identified by the `?id=` URL parameter.

The chat header shows whether inference is running on CPU or GPU. If a CUDA
machine shows `CPU`, reinstall the CUDA wheel:

```powershell
py -3.10 -m pip install --force-reinstall --no-deps --only-binary=llama-cpp-python "llama-cpp-python>=0.3,<1" --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu130
```

## Remote access later

Remote access is intentionally not enabled. Before using Tailscale or publishing
the app, add authentication and authorization for conversations, review the
Supabase access policies, and explicitly configure the network-facing server.
