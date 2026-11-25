const timeline = document.getElementById('chat-timeline');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const modelStatus = document.getElementById('model-status');
const modelSelect = document.getElementById('model-select');
const settingsButton = document.getElementById('settings-button');
const settingsDialog = document.getElementById('settings-dialog');
const settingsClose = document.getElementById('settings-close');
const contextToggle = document.getElementById('context-toggle');
const settingsStatus = document.getElementById('settings-status');
const errorBox = document.getElementById('chat-error');
const conversationParam = new URLSearchParams(window.location.search).get('id');

let conversationId = conversationParam;
let chatReady = false;
let settingsLoaded = false;
let modelCount = 0;
let isSending = false;
let isSwitchingModel = false;

function updateControls() {
    sendBtn.disabled = !chatReady || !settingsLoaded || isSending || isSwitchingModel;
    messageInput.disabled = isSending || isSwitchingModel;
    modelSelect.disabled = modelCount === 0 || isSending || isSwitchingModel;
    contextToggle.disabled = !settingsLoaded || isSending || isSwitchingModel;
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

    let time = null;
    if (createdAt) {
        time = document.createElement('div');
        time.className = 'msg-time';
        time.textContent = formatTime(createdAt);
        row.appendChild(time);
    }

    timeline.appendChild(row);
    timeline.scrollTop = timeline.scrollHeight;
    return { row, bubble, time };
}

function setMessageTime(message, createdAt) {
    if (!createdAt || message.time) return;
    message.time = document.createElement('div');
    message.time.className = 'msg-time';
    message.time.textContent = formatTime(createdAt);
    message.row.appendChild(message.time);
}

async function readChatStream(response, assistantMessage, state) {
    if (!response.body) {
        throw new Error('ストリーミング応答を読み取れません。');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    function processFrame(frame) {
        const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
        if (!data) return;

        const event = JSON.parse(data);
        if (event.type === 'token') {
            if (!state.hasContent) {
                assistantMessage.bubble.textContent = '';
                assistantMessage.bubble.classList.remove('thinking');
                state.hasContent = true;
            }
            assistantMessage.bubble.textContent += event.text;
            timeline.scrollTop = timeline.scrollHeight;
        } else if (event.type === 'done') {
            state.done = true;
            setMessageTime(assistantMessage, event.assistant_created_at);
        } else if (event.type === 'error') {
            throw new Error(event.detail || '応答を生成できませんでした。');
        }
    }

    while (true) {
        const { done, value } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });
        if (done) buffer += decoder.decode();

        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop();
        frames.forEach(processFrame);
        if (done) break;
    }

    if (buffer.trim()) processFrame(buffer);
    if (!state.done) {
        throw new Error('応答ストリームが途中で終了しました。');
    }
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

async function loadSettings() {
    const response = await fetch('/api/settings');
    const result = await response.json();
    if (!response.ok) {
        throw new Error(result.detail || '設定を読み込めませんでした。');
    }

    let useContext = result.default_context_enabled === true;
    try {
        const savedSetting = window.localStorage.getItem('luca-chat-use-context');
        if (savedSetting === 'true' || savedSetting === 'false') {
            useContext = savedSetting === 'true';
        }
        settingsStatus.textContent = '設定はこのブラウザーに保存されます。';
    } catch (error) {
        settingsStatus.textContent = 'このブラウザーでは設定を保存できません。';
    }
    contextToggle.checked = useContext;
    settingsLoaded = true;
    updateControls();
}

function saveContextSetting() {
    try {
        window.localStorage.setItem(
            'luca-chat-use-context',
            String(contextToggle.checked),
        );
        settingsStatus.textContent = '設定をこのブラウザーに保存しました。';
    } catch (error) {
        settingsStatus.textContent = '設定を保存できませんでした。';
        showError('コンテキスト設定を保存できませんでした。');
    }
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
        settingsStatus.textContent = `${result.model} に切り替えました。`;
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

async function ensureConversationId() {
    if (!conversationId) {
        const response = await fetch('/api/conversations', { method: 'POST' });
        const result = await response.json();
        if (!response.ok || typeof result.conversation_id !== 'string') {
            throw new Error(result.detail || '会話IDを作成できませんでした。');
        }
        conversationId = result.conversation_id;
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
    let assistantMessage = null;
    const streamState = { hasContent: false, done: false };

    try {
        await ensureConversationId();
        appendMessage('user', text, new Date().toISOString());
        assistantMessage = appendMessage('assistant', '考え中...', null);
        assistantMessage.bubble.classList.add('thinking');

        const response = await fetch('/api/chat/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                conversation_id: conversationId,
                message: text,
                use_context: contextToggle.checked,
            }),
        });
        if (!response.ok) {
            const result = await response.json();
            throw new Error(result.detail || 'メッセージを送信できませんでした。');
        }
        await readChatStream(response, assistantMessage, streamState);
    } catch (error) {
        if (assistantMessage && !streamState.hasContent) {
            assistantMessage.bubble.textContent = '応答を生成できませんでした。';
            assistantMessage.bubble.classList.remove('thinking');
        }
        showError(error.message);
    } finally {
        isSending = false;
        updateControls();
        messageInput.focus();
    }
}

messageForm.addEventListener('submit', sendMessage);
modelSelect.addEventListener('change', switchModel);
settingsButton.addEventListener('click', () => settingsDialog.showModal());
settingsClose.addEventListener('click', () => settingsDialog.close());
contextToggle.addEventListener('change', saveContextSetting);
settingsDialog.addEventListener('click', (event) => {
    if (event.target === settingsDialog) settingsDialog.close();
});

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
        loadSettings().catch((error) => {
            settingsStatus.textContent = error.message;
            showError(error.message);
        }),
        loadHistory().catch((error) => showError(error.message)),
    ]);
}

init();
