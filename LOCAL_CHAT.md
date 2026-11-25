# Local Luca GPT chat

The local chat uses the latest GGUF export at
`models/luca_gpt_05_single_4B_gguf_gguf/Qwen3-4B.Q4_K_M.gguf` by default.
It serves a separate chat page and leaves the existing public chat app unchanged.

## Setup on Windows

The included `llama-cpp-python` wheel index targets CUDA 13.0 and the RTX 4060.
Use Python 3.10 for the prebuilt Windows CUDA wheel:

```powershell
py -3.10 -m pip install -r requirements-local.txt
```

Start the chat server from the repository root:

```powershell
py -3.10 -m uvicorn local_chat:app --host 127.0.0.1 --port 8000
```

Then open <http://127.0.0.1:8000/>. The server binds to loopback only; do not
change the host to `0.0.0.0` to expose it. The model loads when the server
starts. If `llama-cpp-python` cannot be installed or the GGUF file is missing,
the chat page will show the error and the server log will contain details.
For a CPU-only setup or a different Python/CUDA version, replace the `cu130`
wheel index in `requirements-local.txt` with the matching index documented by
llama-cpp-python.

To select another GGUF file, set `LUCA_GGUF_PATH` before starting the server.
`LUCA_CONTEXT_LENGTH` optionally changes the context length (default `4096`).

## Message storage

The page reuses the existing Supabase `threads` and `chat_messages` tables and
the project's publishable key. Both user messages and model replies are saved;
conversation history is loaded by the `?id=` URL parameter. Supabase Row Level
Security policies must permit the same anonymous inserts and reads used by the
existing chat app. Do not put a Supabase service-role key in the browser.

## Remote access later

Remote access is intentionally not enabled. Before using Tailscale or publishing
the app, add authentication and authorization for conversations, review the
Supabase access policies, and explicitly configure the network-facing server.
