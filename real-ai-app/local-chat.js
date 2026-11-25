const timeline = document.getElementById('chat-timeline');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const modelStatus = document.getElementById('model-status');
const modelSelect = document.getElementById('model-select');
const errorBox = document.getElementById('chat-error');
const conversationParam = new URLSearchParams(window.location.search).get('id');

let conversationId = conversationParam;
let chatReady = false;
let modelCount = 0;
let isSending = false;
let isSwitchingModel = false;

function updateControls() {
    sendBtn.disabled = !chatReady || isSending || isSwitchingModel;
    messageInput.disabled = isSending || isSwitchingModel;
    modelSelect.disabled = modelCount === 0 || isSending || isSwitchingModel;
}

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
        modelStatus.textContent = result.model_ready
            ? `${result.model} (${result.device})`
            : `${result.model} (読み込み失敗)`;
        const issues = [];
        if (!result.model_ready) {
            issues.push(`モデルを読み込めません: ${result.model_error || '詳細はサーバーログを確認してください。'}`);
        }
        if (!result.storage_ready) {
            issues.push('.envにSUPABASE_URLとSUPABASE_SECRET_KEYを設定してください。');
        }
        chatReady = result.model_ready && result.storage_ready;
        if (issues.length) {
            showError(issues.join(' '));
        } else {
            clearError();
        }
        updateControls();
    } catch (error) {
        chatReady = false;
        modelStatus.textContent = 'ローカルサーバーに接続できません';
        showError(error.message);
        updateControls();
    }
}

async function loadModels() {
    const response = await fetch('/api/models');
    const result = await response.json();
    if (!response.ok) {
        throw new Error(result.detail || 'モデル一覧を読み込めませんでした。');
    }

    modelSelect.replaceChildren();
    result.models.forEach((model) => {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = model.name;
        modelSelect.appendChild(option);
    });
    modelCount = result.models.length;
    modelSelect.value = result.active_model_id;
    if (modelCount === 0) {
        showError('modelsフォルダーにGGUFモデルがありません。');
    }
    updateControls();
}

async function switchModel() {
    if (!modelSelect.value || isSwitchingModel || isSending) return;

    clearError();
    isSwitchingModel = true;
    modelStatus.textContent = 'モデルを切り替えています...';
    updateControls();

    try {
        const response = await fetch('/api/models/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model_id: modelSelect.value }),
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.detail || 'モデルを切り替えられませんでした。');
        }
        await checkModel();
    } catch (error) {
        showError(error.message);
        try {
            await loadModels();
            await checkModel();
        } catch (refreshError) {
            showError(refreshError.message);
        }
    } finally {
        isSwitchingModel = false;
        updateControls();
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
    isSending = true;
    updateControls();
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
        isSending = false;
        updateControls();
        messageInput.focus();
    }
}

messageForm.addEventListener('submit', sendMessage);
modelSelect.addEventListener('change', switchModel);

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
        loadModels().catch((error) => showError(error.message)),
        loadHistory().catch((error) => showError(error.message)),
    ]);
}

init();
