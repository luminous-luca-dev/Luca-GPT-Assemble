const SUPABASE_URL = 'https://kslcxmfmzwgmuxsrnjrb.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_HzbTleN2spmfwE8neINPKw_TxHP80ob';
const supabaseClient = window.supabase
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY)
    : null;

const timeline = document.getElementById('chat-timeline');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const modelStatus = document.getElementById('model-status');
const errorBox = document.getElementById('chat-error');
const threadParam = new URLSearchParams(window.location.search).get('id');

let threadId = threadParam;
let history = [];
let modelReady = false;

function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.remove('hidden');
}

function clearError() {
    errorBox.textContent = '';
    errorBox.classList.add('hidden');
}

function formatTime(dateString) {
    if (!dateString) return '';
    return new Date(dateString).toLocaleTimeString('ja-JP', {
        hour: '2-digit',
        minute: '2-digit',
    });
}

function appendMessage(sender, text, createdAt) {
    const row = document.createElement('div');
    row.className = `msg-row ${sender === 'user' ? 'user' : 'luca'}`;

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.textContent = text;
    row.appendChild(bubble);

    if (createdAt) {
        const time = document.createElement('div');
        time.className = 'msg-time';
        time.textContent = formatTime(createdAt);
        row.appendChild(time);
    }

    timeline.appendChild(row);
    timeline.scrollTop = timeline.scrollHeight;
}

async function checkModel() {
    try {
        const response = await fetch('/api/health');
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.detail || 'モデルを読み込めませんでした。');
        }
        modelStatus.textContent = `ローカルモデル: ${result.model}`;
        modelReady = true;
        sendBtn.disabled = false;
    } catch (error) {
        modelStatus.textContent = 'モデルに接続できません';
        showError(`モデルを利用できません。${error.message}`);
    }
}

async function createThread() {
    if (!supabaseClient) {
        throw new Error('Supabaseクライアントを読み込めませんでした。ネット接続を確認してください。');
    }

    const { data, error } = await supabaseClient
        .from('threads')
        .insert([{}])
        .select('id')
        .single();

    if (error) throw new Error(`会話を作成できませんでした: ${error.message}`);

    threadId = data.id;
    const url = new URL(window.location.href);
    url.searchParams.set('id', threadId);
    window.history.replaceState(null, '', url);
}

async function loadHistory() {
    if (!threadId) return;
    if (!supabaseClient) {
        throw new Error('Supabaseクライアントを読み込めませんでした。ネット接続を確認してください。');
    }

    const { data, error } = await supabaseClient
        .from('chat_messages')
        .select('sender, text, created_at')
        .eq('thread_id', threadId)
        .order('created_at', { ascending: true });

    if (error) throw new Error(`会話履歴を読み込めませんでした: ${error.message}`);

    history = [];
    data.forEach((message) => {
        const role = message.sender === 'user' ? 'user' : 'assistant';
        history.push({ role, content: message.text });
        appendMessage(message.sender, message.text, message.created_at);
    });
}

async function saveMessage(sender, text) {
    if (!supabaseClient) {
        throw new Error('Supabaseクライアントを読み込めませんでした。ネット接続を確認してください。');
    }

    const { error } = await supabaseClient
        .from('chat_messages')
        .insert([{ thread_id: threadId, sender, text }]);

    if (error) throw new Error(`メッセージを保存できませんでした: ${error.message}`);
    return new Date().toISOString();
}

async function sendMessage(event) {
    event.preventDefault();
    const text = messageInput.value.trim();
    if (!text || sendBtn.disabled) return;
    if (!modelReady) {
        showError('ローカルモデルの準備ができていません。サーバーの状態を確認してください。');
        return;
    }

    clearError();
    sendBtn.disabled = true;
    messageInput.disabled = true;
    messageInput.value = '';

    try {
        if (!threadId) await createThread();

        const userCreatedAt = await saveMessage('user', text);
        appendMessage('user', text, userCreatedAt);
        history.push({ role: 'user', content: text });

        let reply;
        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    history: history.slice(0, -1).slice(-40),
                    message: text,
                }),
            });
            const result = await response.json();
            if (!response.ok) {
                throw new Error(result.detail || 'モデルの応答生成に失敗しました。');
            }
            reply = result.reply;
        } catch (error) {
            showError(`メッセージは保存されましたが、モデルが応答できませんでした。${error.message}`);
            return;
        }

        try {
            const assistantCreatedAt = await saveMessage('luca', reply);
            appendMessage('luca', reply, assistantCreatedAt);
        } catch (error) {
            appendMessage('luca', reply, new Date().toISOString());
            showError(`応答は生成されましたが、Supabaseへの保存に失敗しました。${error.message}`);
            return;
        }
        history.push({ role: 'assistant', content: reply });
    } catch (error) {
        showError(error.message);
        messageInput.value = text;
    } finally {
        sendBtn.disabled = false;
        messageInput.disabled = false;
        messageInput.focus();
    }
}

messageForm.addEventListener('submit', sendMessage);

messageInput.addEventListener('input', () => {
    messageInput.style.height = 'auto';
    messageInput.style.height = `${Math.min(messageInput.scrollHeight, 120)}px`;
});

messageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        messageForm.requestSubmit();
    }
});

async function init() {
    if (!supabaseClient) {
        showError('Supabaseクライアントを読み込めませんでした。ネット接続を確認してください。');
    }
    await Promise.all([
        checkModel(),
        loadHistory().catch((error) => showError(error.message)),
    ]);
}

init();
