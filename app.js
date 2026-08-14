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

// ローディング画面の制御
const loadingOverlay = document.getElementById('loading-overlay');
function showLoading() {
    loadingOverlay.classList.remove('hidden');
}
function hideLoading() {
    loadingOverlay.classList.add('hidden');
}

// 日時フォーマット関数（例: 14:30）
function formatTime(dateString) {
    if (!dateString) return '';
    const d = new Date(dateString);
    return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

// スレッドIDからパステルカラーを生成する関数
function getPastelColor(id) {
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
        hash = id.charCodeAt(i) + ((hash << 5) - hash);
    }
    // HSLカラーの「色相(0〜360)」をIDから決定し、彩度70%・明度80%でパステル調にする
    const hue = Math.abs(hash % 360);
    return `hsl(${hue}, 70%, 80%)`;
}

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
        setupAdminRealtime(); // ★ここに追加！
    } else if (currentThreadId) {
        // すでにURL（トーク部屋）を持っている場合
        showURLBanner(currentThreadId);
        await loadChatHistory(currentThreadId);
        setupActiveChat();
        
        // ★ 既にIDがあるので、ここでPWAをセットアップ
        setupPWA(currentThreadId);

        // ★追加：すでにURLを持っているユーザーにも通知設定を走らせる
        setupPushNotifications(currentThreadId);
        setupUserRealtime(currentThreadId); // ★ここに追加！
    } else {
        // ▼ 変更：初めてアクセスした状態（タイムラインに初期メッセージをセット）
        timeline.innerHTML = `
            <div class="msg-row luca">
                <div class="msg-bubble">相談でも質問でも、しょーもない話でも何でもOK！\n自由に送ってみてね</div>
            </div>
        `;
        // 初めてアクセスした状態（最初の1通目を待つ）
        setupInitialChat();
    }
}

// タイムラインの最下部へスクロール
function scrollToBottom() {
    timeline.scrollTop = timeline.scrollHeight;
}

// メッセージを画面に描画する
function appendMessageToTimeline(sender, text, createdAt = new Date().toISOString()) {
    const timeString = formatTime(createdAt);
    const row = document.createElement('div');
    row.className = `msg-row ${sender}`;
    
    // 自分の発言(user)はCSSの row-reverse で左右反転させているので、HTML上の順番は同じでOK
    row.innerHTML = `
        <div class="msg-bubble">${escapeHTML(text)}</div>
        <div class="msg-time">${timeString}</div>
    `;
    timeline.appendChild(row);
    scrollToBottom();
}

// URLバナーを表示する関数
function showURLBanner(id) {
    // ★追加：PWA（アプリ）として開かれているかを判定
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;

    // アプリとして起動している場合は、バナー全体を隠したまま処理を終了する
    if (isStandalone) {
        urlBanner.classList.add('hidden');
        return;
    }

    // Webブラウザで開いている場合のみ、これまで通りバナーを表示する
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

        // ★ 処理開始！ぐるぐるを出す
        showLoading();

        try {
            // 1. トークルーム（スレッド）を新規作成
            const { data: threadData, error: tError } = await supabaseClient
                .from('threads')
                .insert([{}])
                .select();

            if (tError || !threadData) {
                alert('接続に失敗しました。');
                return;
            }

            currentThreadId = threadData[0].id;
            window.history.replaceState(null, '', `?id=${currentThreadId}`);
            setupPWA(currentThreadId);
            setupPushNotifications(currentThreadId);
            setupUserRealtime(currentThreadId);

            // 2. ユーザーのメッセージを保存
            await supabaseClient.from('chat_messages').insert([
                { thread_id: currentThreadId, sender: 'user', text: text }
            ]);

            // 3. 画面上の演出
            showURLBanner(currentThreadId);
            appendMessageToTimeline('user', text);

            // 4. Lucaからの自動返信演出
            setTimeout(async () => {
                const lucaGreeting = "ﾒｯｾｰｼﾞありがとう！！助かる～\n返事するからURLｺﾋﾟｰしておいて";
                await supabaseClient.from('chat_messages').insert([
                    { thread_id: currentThreadId, sender: 'luca', text: lucaGreeting, is_auto_reply: true }
                ]);
                setupActiveChat();
            }, 1000);

        } finally {
            // ★ 処理が全て終わったら（エラーでも）ぐるぐるを消す
            hideLoading();
            sendBtn.disabled = false;
        }
    });
}

/* -----------------------------------------
   B. 2回目以降、またはURLから開いた時の設定
----------------------------------------- */
async function loadChatHistory(id) {
    // ▼ 変更：空にするのではなく、初期メッセージをセットしておく
    timeline.innerHTML = `
        <div class="msg-row luca">
            <div class="msg-bubble">相談でも質問でも、しょーもない話でも何でもOK！\n自由に送ってみてね</div>
        </div>
    `;
    const { data, error } = await supabaseClient
        .from('chat_messages')
        .select('*')
        .eq('thread_id', id)
        .order('created_at', { ascending: true });

    if (error) return;

    data.forEach(msg => {
        appendMessageToTimeline(msg.sender, msg.text, msg.created_at);
    });
}

function setupActiveChat() {
    sendBtn.disabled = false;
    
    const newSendBtn = sendBtn.cloneNode(true);
    sendBtn.parentNode.replaceChild(newSendBtn, sendBtn);

    newSendBtn.addEventListener('click', async () => {
        const text = messageInput.value.trim();
        if (!text) return;

        messageInput.value = '';
        
        // ★ 処理開始！
        showLoading();

        try {
            const { error } = await supabaseClient.from('chat_messages').insert([
                { thread_id: currentThreadId, sender: 'user', text: text }
            ]);

            if (error) {
                alert('送信に失敗しました。もう一度お試しください。');
                return;
            }

            // DB保存が完了してから画面に表示
            appendMessageToTimeline('user', text);

            if (typeof setupPushNotifications === 'function') {
                setupPushNotifications(currentThreadId);
            }
        } finally {
            // ★ 処理完了！
            hideLoading();
        }
    });
}

/* -----------------------------------------
   C. 管理者画面の制御 (?admin=true)
----------------------------------------- */
let adminThreadsMap = {};
let currentAdminThreadId = null;

async function renderAdminScreen(isAutoRefresh = false) {
    if (!currentAdminThreadId && !isAutoRefresh) {
        timeline.innerHTML = '<p style="text-align:center; color:#666; padding:20px;">読み込み中...</p>';
    }

    // 全メッセージを取得
    const { data: allMessages, error } = await supabaseClient
        .from('chat_messages')
        .select('*')
        .order('created_at', { ascending: true });

    if (error) {
        if (!currentAdminThreadId) timeline.innerHTML = '<p>データの取得に失敗しました。</p>';
        return;
    }

    adminThreadsMap = {};
    allMessages.forEach(msg => {
        if (!adminThreadsMap[msg.thread_id]) adminThreadsMap[msg.thread_id] = [];
        adminThreadsMap[msg.thread_id].push(msg);
    });

    if (currentAdminThreadId) {
        // トークを開いたまま裏で更新された場合は中身を再描画
        openAdminThread(currentAdminThreadId);
    } else {
        // リスト画面
        renderAdminList();
    }
}

function renderAdminList() {
    roomNameLabel.textContent = 'トーク一覧';
    urlBanner.style.display = 'none';
    document.getElementById('chat-footer').style.display = 'none';
    document.querySelector('.header-back').style.visibility = 'hidden'; 
    
    timeline.style.padding = '0';
    timeline.style.gap = '0'; // リスト用の余白リセット
    timeline.style.backgroundColor = '#fff';

    // 最終メッセージの日時で降順（新しい順）に並び替え
    const sortedThreadIds = Object.keys(adminThreadsMap).sort((a, b) => {
        const lastMsgA = adminThreadsMap[a][adminThreadsMap[a].length - 1];
        const lastMsgB = adminThreadsMap[b][adminThreadsMap[b].length - 1];
        return new Date(lastMsgB.created_at) - new Date(lastMsgA.created_at);
    });

    // データの取得が完了してからDOMを一括生成（画面のチラつき防止）
    const fragment = document.createDocumentFragment();

    // 並び替えた順（sortedThreadIds）にカードを生成
    sortedThreadIds.forEach(threadId => {
        const msgs = adminThreadsMap[threadId];
        const lastMsg = msgs[msgs.length - 1];
        
        // 最後の発言が相手(user)なら「新着」として赤いバッジを出す
        const hasNewMsg = lastMsg.sender === 'user';
        
        // 時刻のフォーマット (例: 14:30)
        const timeString = new Date(lastMsg.created_at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });

        // ★追加：IDからパステルカラーを取得
        const avatarColor = getPastelColor(threadId);

        const item = document.createElement('div');
        item.className = 'admin-list-item';
        item.onclick = () => openAdminThread(threadId);

        item.innerHTML = `
            <div class="admin-list-avatar" style="background-color: ${avatarColor};"><i class="fa-solid fa-user"></i></div>
            <div class="admin-list-content">
                <div class="admin-list-name">ゲスト (${threadId.slice(0,4)})</div>
                <div class="admin-list-preview">${escapeHTML(lastMsg.text)}</div>
            </div>
            <div class="admin-list-right">
                <div class="admin-list-time">${timeString}</div>
                <div class="admin-unread-badge ${hasNewMsg ? '' : 'hidden'}">N</div>
            </div>
        `;
        fragment.appendChild(item);
    });

    timeline.innerHTML = '';
    timeline.appendChild(fragment);
    if (sortedThreadIds.length === 0) {
        timeline.innerHTML = '<p style="text-align:center; color:#666; padding:20px;">まだメッセージはありません。</p>';
    }
}

function openAdminThread(threadId) {
    currentAdminThreadId = threadId;
    roomNameLabel.textContent = `ゲスト (${threadId.slice(0,4)})`;
    document.getElementById('chat-footer').style.display = 'block';
    document.querySelector('.header-back').style.visibility = 'visible'; 
    
    timeline.style.padding = '15px';
    timeline.style.gap = '7px'; // トークルーム用の余白に戻す
    timeline.style.backgroundColor = '#b2c7da';

    // ▼ 変更：初期メッセージを管理者側（右寄り・緑色）としてセット
    timeline.innerHTML = `
        <div class="msg-row user">
            <div class="msg-bubble">相談でも質問でも、しょーもない話でも何でもOK！\n自由に送ってみてね</div>
        </div>
    `;
    const msgs = adminThreadsMap[threadId] || [];
    msgs.forEach(msg => {
        // ★ポイント：既存のCSSを活かすため、管理者(luca)の送信分を右側(userクラス)にする
        const senderClass = msg.sender === 'luca' ? 'user' : 'luca'; 
        const timeString = formatTime(msg.created_at); // ★追加
        const row = document.createElement('div');
        row.className = `msg-row ${senderClass}`;
        // ★時間をHTMLに追加
        row.innerHTML = `
            <div class="msg-bubble">${escapeHTML(msg.text)}</div>
            <div class="msg-time">${timeString}</div>
        `;
        timeline.appendChild(row);
    });
    scrollToBottom();

    // 送信ボタンを管理者用に設定
    setupAdminSendButton();
}

function setupAdminSendButton() {
    // イベントリスナーの重複を防ぐためボタンを複製して入れ替える
    const newSendBtn = sendBtn.cloneNode(true);
    sendBtn.parentNode.replaceChild(newSendBtn, sendBtn);
    const currentSendBtn = document.getElementById('send-btn');

    currentSendBtn.addEventListener('click', async () => {
        const text = messageInput.value.trim();
        if (!text || !currentAdminThreadId) return;

        messageInput.value = '';
        showLoading();

        try {
            const { error } = await supabaseClient.from('chat_messages').insert([
                { thread_id: currentAdminThreadId, sender: 'luca', text: text }
            ]);

            if (error) alert('送信に失敗しました。');
        } finally {
            hideLoading();
        }
    });
}

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
    const ua = navigator.userAgent.toLowerCase();
    const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;

    // ▼ アプリ内ブラウザ（IAB）かどうかの判定を追加
    const isLine = ua.includes('line');
    const isTwitter = ua.includes('twitter');
    const isInstagram = ua.includes('instagram');
    const isFacebook = ua.includes('fbav') || ua.includes('fban');
    const isIAB = isLine || isTwitter || isInstagram || isFacebook;

    // アプリ内ブラウザ（OS問わず）または iOSの標準ブラウザの場合はボタンを最初から表示する
    if (isIOS || isIAB) {
        installBtn.classList.remove('hidden');
        
        installBtn.addEventListener('click', () => {
            // ① アプリ内ブラウザ（インスタやXなど）の場合
            if (isIAB) {
                if (isLine) {
                    // LINEの場合はURLパラメータで外部ブラウザ起動を強制する
                    if (!window.location.search.includes('openExternalBrowser=1')) {
                        const newUrl = new URL(window.location.href);
                        newUrl.searchParams.set('openExternalBrowser', '1');
                        window.location.href = newUrl.href;
                    }
                } else {
                    // それ以外のSNSは案内モーダルを出す
                    document.getElementById('iab-warning').classList.remove('hidden');
                }
                return; // ここで処理を終わらせる
            }

            // ② IABではない標準Safari（iOS）の場合
            if (isIOS) {
                document.getElementById('ios-install-modal').classList.remove('hidden');
            }
        });
    } else {
        // ③ AndroidやPCの標準ブラウザの場合
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
    // ★1行目にログを置く（ここすら出ない場合は関数自体が呼ばれていないか、キャッシュのせい）
    console.log("【1】setupPushNotifications が実行されました。threadId:", threadId);

    if (!threadId) {
        console.error("【エラー】threadId が受け取れていません。");
        return;
    }

    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

    console.log("【2】環境チェック -> iOS:", isIOS, "PWA起動:", isStandalone);

    if (isIOS && !isStandalone) {
        console.log("【3】iOSのブラウザ環境のため、通知処理をスキップしました（ホーム画面に追加して起動してください）");
        return;
    }

    console.log("【4】OneSignalの処理を開始します...");

    OneSignalDeferred.push(async function(OneSignal) {
        console.log("【5】OneSignalSDKの準備が完了しました");

        await OneSignal.Slidedown.promptPush();

        // IDをDBに保存する共通関数
        const saveSubscriptionId = async (subId) => {
            console.log("【6】取得したデバイスID:", subId);
            
            const { data, error } = await supabaseClient
                .from('threads')
                .update({ onesignal_id: subId })
                .eq('id', threadId)
                .select();

            if (error) {
                console.error("【Supabase更新エラー】:", error.message);
            } else {
                console.log("【成功】onesignal_id を更新完了:", data);
            }
        };

        // 1. IDが発行されるまで最大10秒間（1秒間隔）待機して保存を試みる
        const pollForIdAndSave = async () => {
            let attempts = 0;
            while (attempts < 10) {
                const currentId = OneSignal.User.PushSubscription.id;
                if (currentId) {
                    // IDが見つかったら保存を実行
                    await saveSubscriptionId(currentId);
                    break; // 保存できたらループを終了
                }
                // IDがまだ無い場合は1秒待って再試行
                await new Promise(resolve => setTimeout(resolve, 1000));
                attempts++;
            }
        };

        // 上記の待機＆保存処理を実行
        await pollForIdAndSave();

        // 2. ユーザーがポップアップで「許可」を押してIDが発行された瞬間を検知して保存
        OneSignal.User.PushSubscription.addEventListener("change", async (event) => {
            if (event.current.id) {
                await saveSubscriptionId(event.current.id);
            }
        });
    });
}

/* -----------------------------------------
   G. Supabase リアルタイム通信 (吹き出しのみ追加)
----------------------------------------- */
// ▼ ユーザー用：相手(Luca)からメッセージが来たら吹き出しを追加
function setupUserRealtime(threadId) {
    supabaseClient
        .channel('user-room')
        .on('postgres_changes', {
            event: 'INSERT',
            schema: 'public',
            table: 'chat_messages',
            filter: `thread_id=eq.${threadId}`
        }, payload => {
            // 自分(user)のメッセージは送信時に画面に出しているので無視。相手からのものだけ追加。
            if (payload.new.sender !== 'user') {
                appendMessageToTimeline(payload.new.sender, payload.new.text);
            }
        })
        .subscribe();
}

// ▼ 管理者用：新着メッセージが来たらリストやトークルームを更新
function setupAdminRealtime() {
    supabaseClient
        .channel('admin-room')
        .on('postgres_changes', {
            event: 'INSERT',
            schema: 'public',
            table: 'chat_messages'
        }, payload => {
            const m = payload.new;
            
            // メモリ上のデータを更新
            if (!adminThreadsMap[m.thread_id]) adminThreadsMap[m.thread_id] = [];
            adminThreadsMap[m.thread_id].push(m);

            // 現在このスレッドを開いている場合、画面に追記
            if (currentAdminThreadId === m.thread_id) {
                const senderClass = m.sender === 'luca' ? 'user' : 'luca';
                const timeString = formatTime(m.created_at); // ★追加
                const row = document.createElement('div');
                row.className = `msg-row ${senderClass}`;
                row.innerHTML = `
                    <div class="msg-bubble">${escapeHTML(m.text)}</div>
                    <div class="msg-time">${timeString}</div>
                `;
                timeline.appendChild(row);
                scrollToBottom();
            } else if (!currentAdminThreadId) {
                // 一覧画面を開いている場合は、リストを再描画（一番上に持ってくる）
                renderAdminList();
            }
        })
        .subscribe();
}

/* -----------------------------------------
   H. バックグラウンド復帰時の自動再取得（iOS対策）
----------------------------------------- */
document.addEventListener('visibilitychange', async () => {
    // 画面が開かれた（アプリに戻ってきた）瞬間を検知
    if (document.visibilityState === 'visible') {
        console.log('アプリに復帰しました。最新メッセージを取得します。');
        
        if (isAdmin) {
            // 管理者の場合：最新のスレッド状態を再読み込み
            renderAdminScreen(true);
        } else if (currentThreadId) {
            // ユーザーの場合：最新のチャット履歴を再取得して画面を更新
            await loadChatHistory(currentThreadId);
            
            // スクロールを最下部へ
            scrollToBottom();
        }
    }
});

/* -----------------------------------------
   I. ヘッダー機能（戻るボタン＆設定メニュー）
----------------------------------------- */
// 1. 戻るボタンの吹き出しアクション
const headerBackBtn = document.querySelector('.header-back');
const backTooltip = document.getElementById('back-tooltip');
let backTooltipTimer = null;

headerBackBtn.addEventListener('click', () => {
    // ★追加：管理者モードでトークを開いている時は、一覧に戻る
    if (isAdmin && currentAdminThreadId) {
        currentAdminThreadId = null;
        renderAdminList();
        return;
    }

    // 吹き出しを表示
    backTooltip.classList.remove('tooltip-hidden');
    
    // 連続で押された時のために前のタイマーをクリア
    if (backTooltipTimer) clearTimeout(backTooltipTimer);
    
    // 2秒後に再び隠す
    backTooltipTimer = setTimeout(() => {
        backTooltip.classList.add('tooltip-hidden');
    }, 2000);
});

// 2. 設定メニュー（通知ON/OFF）
const headerMenuBtn = document.querySelector('.header-menu');
const settingsModal = document.getElementById('settings-modal');
const closeSettingsBtn = document.getElementById('close-settings-btn');
const pushToggle = document.getElementById('push-toggle');

// メニューボタンを押して設定を開く
headerMenuBtn.addEventListener('click', () => {
    settingsModal.classList.remove('hidden');
    
    // 現在のOneSignalの通知状態を取得して、トグルスイッチの見た目に反映させる
    OneSignalDeferred.push(async function(OneSignal) {
        const isPushEnabled = OneSignal.User.PushSubscription.optedIn;
        pushToggle.checked = isPushEnabled;
    });
});

// ×ボタンを押して設定を閉じる
closeSettingsBtn.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
});

// モーダルの黒い背景部分をタップしても閉じるようにする
settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) {
        settingsModal.classList.add('hidden');
    }
});

// トグルスイッチ（ON/OFF）を切り替えた時の処理
pushToggle.addEventListener('change', (e) => {
    const isChecked = e.target.checked;
    
    OneSignalDeferred.push(async function(OneSignal) {
        // ★ 処理開始！ぐるぐるを出す
        showLoading();

        try {
            if (isChecked) {
                // --- ONにした場合 ---
                await OneSignal.User.PushSubscription.optIn();
                
                // IDが取れるまで最大3秒間（0.5秒おきに）確認して再登録
                let currentId = OneSignal.User.PushSubscription.id;
                let attempts = 0;
                while (!currentId && attempts < 6) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    currentId = OneSignal.User.PushSubscription.id;
                    attempts++;
                }

                if (currentId && currentThreadId) {
                    await supabaseClient
                        .from('threads')
                        .update({ onesignal_id: currentId })
                        .eq('id', currentThreadId);
                    console.log("【通知ON】onesignal_id を復元しました:", currentId);
                }
            } else {
                // --- OFFにした場合 ---
                await OneSignal.User.PushSubscription.optOut();
                
                // Supabaseのonesignal_idをnullにして送信対象から外す
                if (currentThreadId) {
                    await supabaseClient
                        .from('threads')
                        .update({ onesignal_id: null })
                        .eq('id', currentThreadId);
                    console.log("【通知OFF】onesignal_id を null に設定しました");
                }
            }
        } finally {
            // ★ 処理が全て終わったらぐるぐるを消す
            hideLoading();
        }
    });
});

/* =========================================
   追加：Android等でのキーボード表示時のスクロール調整
========================================= */
const androidFixInput = document.getElementById('message-input');
if (androidFixInput) {
    androidFixInput.addEventListener('focus', () => {
        setTimeout(() => {
            if (typeof scrollToBottom === 'function') {
                scrollToBottom();
            }
        }, 300);
    });
}