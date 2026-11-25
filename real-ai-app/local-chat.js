const timeline = document.getElementById('chat-timeline');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const modelStatus = document.getElementById('model-status');
const errorBox = document.getElementById('chat-error');
const conversationParam = new URLSearchParams(window.location.search).get('id');

let conversationId = conversationParam;
let chatReady = false;

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
            throw new Error(result.detail || '状態を確認できませんでした。');
        }
        modelStatus.textContent = `ローカルモデル: ${result.model} (${result.device})`;
        const issues = [];
        if (!result.model_ready) {
            issues.push(`モデルを読み込めません: ${result.model_error || '詳細はサーバーログを確認してください。'}`);
        }
        if (!result.storage_ready) {
            issues.push('.envにSUPABASE_URLとSUPABASE_SECRET_KEYを設定してください。');
        }
        if (issues.length) {
            showError(issues.join(' '));
            return;
        }
        chatReady = true;
        sendBtn.disabled = false;
    } catch (error) {
        modelStatus.textContent = 'ローカルサーバーに接続できません';
        showError(error.message);
    }
}

function ensureConversationId() {
    if (!conversationId) {
        if (!window.crypto || !window.crypto.randomUUID) {
            throw new Error('このブラウザーでは安全な会話IDを作成できません。');
        }
        conversationId = window.crypto.randomUUID();
        const url = new URL(window.location.href);
        url.searchParams.set('id', conversationId);
        window.history.replaceState(null, '', url);
    }
}

async function loadHistory() {
    if (!conversationId) return;

    const response = await fetch(
        `/api/conversations/${encodeURIComponent(conversationId)}/messages`
    );
    const messages = await response.json();
    if (!response.ok) {
        throw new Error(messages.detail || '会話履歴を読み込めませんでした。');
    }

    messages.forEach((message) => {
        appendMessage(message.sender, message.content, message.created_at);
    });
}

async function sendMessage(event) {
    event.preventDefault();
    const text = messageInput.value.trim();
    if (!text || sendBtn.disabled) return;
    if (!chatReady) {
        showError('モデルとSupabaseの準備ができていません。サーバーの状態を確認してください。');
        return;
    }

    clearError();
    sendBtn.disabled = true;
    messageInput.disabled = true;
    messageInput.value = '';

    try {
        ensureConversationId();
        appendMessage('user', text, new Date().toISOString());

        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ conversation_id: conversationId, message: text }),
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.detail || 'メッセージを送信できませんでした。');
        }
        appendMessage('assistant', result.reply, result.assistant_created_at);
    } catch (error) {
        showError(error.message);
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
    await Promise.all([
        checkModel(),
        loadHistory().catch((error) => showError(error.message)),
    ]);
}

init();
