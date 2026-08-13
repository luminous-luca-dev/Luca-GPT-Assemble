/* -----------------------------------------
   E. iOSアプリ内ブラウザ（In-App Browser）対策
   （※一番上に配置して、ページ読み込み直後に即チェックする）
----------------------------------------- */
function checkAndRedirectSafari() {
    const ua = navigator.userAgent.toLowerCase();
    const isIOS = /iphone|ipad|ipod/.test(ua);
    if (!isIOS) return; 

    const isLine = ua.includes('line');
    const isTwitter = ua.includes('twitter');
    const isInstagram = ua.includes('instagram');
    const isFacebook = ua.includes('fbav') || ua.includes('fban');

    if (isLine || isTwitter || isInstagram || isFacebook) {
        if (isLine) {
            if (!window.location.search.includes('openExternalBrowser=1')) {
                const newUrl = new URL(window.location.href);
                newUrl.searchParams.set('openExternalBrowser', '1');
                window.location.href = newUrl.href;
                return;
            }
        } else {
            document.getElementById('iab-warning').classList.remove('hidden');
        }
    }
}
checkAndRedirectSafari();

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

/* -----------------------------------------
   Service Worker の登録
----------------------------------------- */
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(err => {
        console.log('Service Workerの登録に失敗しました:', err);
    });
}

// 起動時の初期化
async function init() {
    if (isAdmin) {
        renderAdminScreen();
    } else if (currentThreadId) {
        // すでにURL（トーク部屋）を持っている場合
        showURLBanner(currentThreadId);
        await loadChatHistory(currentThreadId);
        setupActiveChat();
        
        // ★ 既にIDがあるので、ここでPWAをセットアップ
        setupPWA(currentThreadId);

        // ★追加：すでにURLを持っているユーザーにも通知設定を走らせる
        setupPushNotifications(currentThreadId);
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

        // ★【追加】ブラウザのアドレスバーを専用URL(?id=xxx)に書き換える（iOS対策）
        window.history.replaceState(null, '', `?id=${currentThreadId}`);

        // ★ IDが新規発行された直後のこのタイミングでPWAをセットアップ！
        setupPWA(currentThreadId);

        // ★追加：はじめてメッセージを送った直後に通知を促す
        setupPushNotifications(currentThreadId);

        // 2. ユーザーのメッセージを保存
        await supabaseClient.from('chat_messages').insert([
            { thread_id: currentThreadId, sender: 'user', text: text }
        ]);

        // 3. 画面上の演出
        showURLBanner(currentThreadId);
        appendMessageToTimeline('user', text);

        // 4. Lucaからの自動返信演出（1秒後にシュッと登場）
        setTimeout(async () => {
            const lucaGreeting = "ﾒｯｾｰｼﾞありがとう！！助かる～\n返事するからURLｺﾋﾟｰしておいて";
            
            // Lucaのセリフもデータベースに永続化する
            await supabaseClient.from('chat_messages').insert([
                { 
                    thread_id: currentThreadId, 
                    sender: 'luca', 
                    text: lucaGreeting,
                    is_auto_reply: true // ★ここを追加！
                }
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
let isAutoRefreshStarted = false; // 自動更新タイマーの二重起動防止フラグ

async function renderAdminScreen(isAutoRefresh = false) {
    roomNameLabel.textContent = '管理者用ダッシュボード';
    urlBanner.style.display = 'none';
    document.getElementById('chat-footer').style.display = 'none';
    
    // 初回読み込み時だけ「読み込み中...」を表示（自動更新時の画面チラつきを防止）
    if (!isAutoRefresh && !timeline.innerHTML) {
        timeline.innerHTML = '<p style="text-align:center; color:#666;">会話スレッドを読み込み中...</p>';
    }

    // 全メッセージを取得
    const { data: allMessages, error } = await supabaseClient
        .from('chat_messages')
        .select('*')
        .order('created_at', { ascending: true });

    if (error) {
        if (!isAutoRefresh) timeline.innerHTML = '<p>データの取得に失敗しました。</p>';
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

    // ★改善1: 各スレッドの「一番最後のメッセージの日時」を比較して新着順（降順）に並び替え
    const sortedThreadIds = Object.keys(threadsMap).sort((a, b) => {
        const lastMsgA = threadsMap[a][threadsMap[a].length - 1];
        const lastMsgB = threadsMap[b][threadsMap[b].length - 1];
        return new Date(lastMsgB.created_at) - new Date(lastMsgA.created_at);
    });

    // データの取得が完了してからDOMを一括生成（画面のチラつき防止）
    const fragment = document.createDocumentFragment();

    // 並び替えた順（sortedThreadIds）にカードを生成
    sortedThreadIds.forEach(threadId => {
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
        fragment.appendChild(card);
    });

    timeline.innerHTML = '';
    timeline.appendChild(fragment);
    
    if (sortedThreadIds.length === 0) {
        timeline.innerHTML = '<p style="text-align:center; color:#666;">まだメッセージはありません。</p>';
    }

    // ★改善2: 初回描画時のみ、5秒おきに新着をチェックする自動更新タイマーをセット
    if (!isAutoRefreshStarted) {
        isAutoRefreshStarted = true;
        setInterval(() => {
            // 【重要】どこかのスレッドで返信を入力中（テキストエリアに文字がある状態）なら、
            // 入力文字が消えないように自動更新をストップして邪魔しない！
            const isTyping = Array.from(document.querySelectorAll('.admin-reply-box textarea'))
                                  .some(ta => ta.value.trim() !== '');
            if (!isTyping) {
                renderAdminScreen(true); // 裏で静かに更新
            }
        }, 5000); // 5000 = 5秒おき
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
        // 返信後は即時更新して自分のメッセージを反映
        renderAdminScreen();
    }
};

function escapeHTML(str) {
    return str.replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag));
}

init();

// ▼▼▼ ファイルの末尾にPWA機能をそのまま追加 ▼▼▼
/* -----------------------------------------
   D. PWA（ホーム画面に追加）機能
----------------------------------------- */
let deferredPrompt;

function setupPWA(threadId) {
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    if (isStandalone) {
        return; 
    }

    const manifest = {
        "name": "Chat-NGT",
        "short_name": "Chat-NGT",
        "start_url": `/?id=${threadId}`,
        "display": "standalone",
        "background_color": "#2c3e50",
        "theme_color": "#2c3e50",
        "icons": [
            { "src": "icon-192.png", "sizes": "192x192", "type": "image/png" }
        ]
    };

    const manifestUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(manifest));
    const manifestLink = document.createElement('link');
    manifestLink.rel = 'manifest';
    manifestLink.href = manifestUrl;
    document.head.appendChild(manifestLink);

    const appleIcon = document.createElement('link');
    appleIcon.rel = 'apple-touch-icon';
    appleIcon.href = 'icon-192.png';
    document.head.appendChild(appleIcon);

    const installBtn = document.getElementById('install-btn');
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

    if (isIOS) {
        installBtn.classList.remove('hidden');
        installBtn.addEventListener('click', () => {
            document.getElementById('ios-install-modal').classList.remove('hidden');
        });
    } else {
        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault(); 
            deferredPrompt = e; 
            installBtn.classList.remove('hidden'); 
        });

        installBtn.addEventListener('click', async () => {
            if (deferredPrompt) {
                deferredPrompt.prompt(); 
                const { outcome } = await deferredPrompt.userChoice;
                if (outcome === 'accepted') {
                    installBtn.classList.add('hidden'); 
                }
                deferredPrompt = null;
            }
        });
    }
}

/* -----------------------------------------
   F. OneSignal（プッシュ通知）の設定
----------------------------------------- */
window.OneSignalDeferred = window.OneSignalDeferred || [];
OneSignalDeferred.push(async function(OneSignal) {
    await OneSignal.init({
        appId: "e1933f07-ccbb-472c-929a-db01487516cb", 
    });
});

// ユーザーに通知許可を求め、許可されたらIDをDBに保存する関数
async function setupPushNotifications(threadId) {
    OneSignalDeferred.push(async function(OneSignal) {
        // PWAとしてインストールされている（またはAndroid/PC）場合のみ通知を促す
        const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
        
        // iOSのSafari（ブラウザのまま）なら通知は非対応なので処理を抜ける
        if (isIOS && !isStandalone) return;

        // 通知の許可ダイアログを表示
        await OneSignal.Slidedown.promptPush();

        // OneSignalが発行したこのスマホ専用のIDを取得
        const subscriptionId = OneSignal.User.PushSubscription.id;
        
        if (subscriptionId) {
            // SupabaseのthreadsテーブルにデバイスIDを保存（紐付け）
            await supabaseClient
                .from('threads')
                .update({ onesignal_id: subscriptionId })
                .eq('id', threadId);
        }
    });
}