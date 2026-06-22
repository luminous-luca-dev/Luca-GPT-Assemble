// Supabaseの接続情報（メモした情報に書き換えてください）
const SUPABASE_URL = 'https://kslcxmfmzwgmuxsrnjrb.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_HzbTleN2spmfwE8neINPKw_TxHP80ob';
// 名前が衝突しないように修正
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const timeline = document.getElementById('chat-timeline');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const urlBanner = document.getElementById('url-banner');
const shareUrlInput = document.getElementById('share-url');
const copyBtn = document.getElementById('copy-btn');
const roomNameLabel = document.querySelector('.room-name');

const urlParams = new URLSearchParams(window.location.search);
let currentThreadId = urlParams.get('id');
const isAdmin = urlParams.get('admin') === 'true';

// 起動時の初期化
async function init() {
    if (isAdmin) {
        renderAdminScreen();
    } else if (currentThreadId) {
        // すでにURL（トーク部屋）を持っている場合
        showURLBanner(currentThreadId);
        await loadChatHistory(currentThreadId);
        setupActiveChat();
    } else {
        // 初めてアクセスした状態（最初の1通目を待つ）
        setupInitialChat();
    }
}

// タイムラインの最下部へスクロール
function scrollToBottom() {
    timeline.scrollTop = timeline.scrollHeight;
}

// メッセージを画面に描画する
function appendMessageToTimeline(sender, text) {
    const row = document.createElement('div');
    row.className = `msg-row ${sender}`;
    row.innerHTML = `<div class="msg-bubble">${escapeHTML(text)}</div>`;
    timeline.appendChild(row);
    scrollToBottom();
}

// URLバナーを表示する関数
function showURLBanner(id) {
    const baseUrl = window.location.href.split('?')[0];
    shareUrlInput.value = `${baseUrl}?id=${id}`;
    urlBanner.classList.remove('hidden');
}

// コピーボタンの制御
copyBtn.addEventListener('click', () => {
    shareUrlInput.select();
    document.execCommand('copy');
    copyBtn.innerHTML = `<i class="fa-solid fa-check"></i> 完了`;
    setTimeout(() => {
        copyBtn.innerHTML = `<i class="fa-regular fa-copy"></i> コピー`;
    }, 2000);
});

/* -----------------------------------------
   A. はじめて送る時の設定
----------------------------------------- */
function setupInitialChat() {
    sendBtn.addEventListener('click', async () => {
        const text = messageInput.value.trim();
        if (!text) return;

        messageInput.value = '';
        sendBtn.disabled = true;

        // 1. トークルーム（スレッド）を新規作成
        const { data: threadData, error: tError } = await supabaseClient
            .from('threads')
            .insert([{}])
            .select();

        if (tError || !threadData) {
            alert('接続に失敗しました。');
            sendBtn.disabled = false;
            return;
        }

        currentThreadId = threadData[0].id;

        // 2. ユーザーのメッセージを保存
        await supabaseClient.from('chat_messages').insert([
            { thread_id: currentThreadId, sender: 'user', text: text }
        ]);

        // 3. 画面上の演出
        showURLBanner(currentThreadId);
        appendMessageToTimeline('user', text);

        // 4. Lucaからの自動返信演出（1秒後にシュッと登場）
        setTimeout(async () => {
            const lucaGreeting = "メッセージありがとう！！助かる～\n返事するからURLコピーしておいて";
            
            // Lucaのセリフもデータベースに永続化する
            await supabaseClient.from('chat_messages').insert([
                { thread_id: currentThreadId, sender: 'luca', text: lucaGreeting }
            ]);
            
            appendMessageToTimeline('luca', lucaGreeting);
            
            // 以降は重ねて送れるモードに移行
            setupActiveChat();
        }, 1000);
    });
}

/* -----------------------------------------
   B. 2回目以降、またはURLから開いた時の設定
----------------------------------------- */
async function loadChatHistory(id) {
    timeline.innerHTML = '';
    const { data, error } = await supabaseClient
        .from('chat_messages')
        .select('*')
        .eq('thread_id', id)
        .order('created_at', { ascending: true });

    if (error) return;

    data.forEach(msg => {
        appendMessageToTimeline(msg.sender, msg.text);
    });
}

function setupActiveChat() {
    sendBtn.disabled = false;
    
    // 古いイベントリスナーをクリアするために新しくボタンを置き換え
    const newSendBtn = sendBtn.cloneNode(true);
    sendBtn.parentNode.replaceChild(newSendBtn, sendBtn);

    newSendBtn.addEventListener('click', async () => {
        const text = messageInput.value.trim();
        if (!text) return;

        messageInput.value = '';
        appendMessageToTimeline('user', text);

        await supabaseClient.from('chat_messages').insert([
            { thread_id: currentThreadId, sender: 'user', text: text }
        ]);
    });
}

/* -----------------------------------------
   C. 管理者画面の制御 (?admin=true)
----------------------------------------- */
async function renderAdminScreen() {
    roomNameLabel.textContent = '管理者用ダッシュボード';
    urlBanner.style.display = 'none';
    document.getElementById('chat-footer').style.display = 'none';
    timeline.innerHTML = '<p style="text-align:center; color:#666;">会話スレッドを読み込み中...</p>';

    // 全メッセージを取得
    const { data: allMessages, error } = await supabaseClient
        .from('chat_messages')
        .select('*')
        .order('created_at', { ascending: true });

    if (error) {
        timeline.innerHTML = '<p>データの取得に失敗しました。</p>';
        return;
    }

    // スレッドごとに発言をグループ化
    const threadsMap = {};
    allMessages.forEach(msg => {
        if (!threadsMap[msg.thread_id]) {
            threadsMap[msg.thread_id] = [];
        }
        threadsMap[msg.thread_id].push(msg);
    });

    timeline.innerHTML = '';

    // 各スレッドをカード形式で表示
    Object.keys(threadsMap).forEach(threadId => {
        const msgs = threadsMap[threadId];
        
        const card = document.createElement('div');
        card.className = 'admin-thread-card';
        card.id = `thread-card-${threadId}`;

        let historyHtml = '';
        msgs.forEach(m => {
            const name = m.sender === 'user' ? '相手' : 'Luca';
            historyHtml += `<div><strong>${name}:</strong> ${escapeHTML(m.text)}</div>`;
        });

        card.innerHTML = `
            <div class="admin-history">${historyHtml}</div>
            <div class="admin-reply-box">
                <textarea id="admin-input-${threadId}" placeholder="Lucaとして返信を入力..."></textarea>
                <button onclick="sendAdminReply('${threadId}')" style="background:#273246; color:white; border:none; border-radius:6px; padding:0 15px; cursor:pointer;">返信</button>
            </div>
        `;
        timeline.appendChild(card);
    });
    
    if (Object.keys(threadsMap).length === 0) {
        timeline.innerHTML = '<p style="text-align:center; color:#666;">まだメッセージはありません。</p>';
    }
}

// 管理者からの返信処理
window.sendAdminReply = async function(threadId) {
    const input = document.getElementById(`admin-input-${threadId}`);
    const text = input.value.trim();
    if (!text) return;

    input.value = '';

    const { error } = await supabaseClient
        .from('chat_messages')
        .insert([
            { thread_id: threadId, sender: 'luca', text: text }
        ]);

    if (error) {
        alert('返信の送信に失敗しました。');
    } else {
        // カード内の表示を即時更新して再確認できるようにする
        renderAdminScreen();
    }
};

function escapeHTML(str) {
    return str.replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag));
}

init();