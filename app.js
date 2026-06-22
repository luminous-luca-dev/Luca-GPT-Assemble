// Supabaseの接続情報（メモした情報に書き換えてください）
const SUPABASE_URL = 'https://kslcxmfmzwgmuxsrnjrb.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_HzbTleN2spmfwE8neINPKw_TxHP80ob';
// 名前が衝突しないように修正
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const mainContent = document.getElementById('main-content');
const headerTitle = document.getElementById('header-title');

// URLパラメータを読み取って画面を判断
const urlParams = new URLSearchParams(window.location.search);
const currentId = urlParams.get('id');
const isAdmin = urlParams.get('admin') === 'true'; 

// 画面の初期化
function init() {
    if (isAdmin) {
        renderAdminScreen();
    } else if (currentId) {
        renderStatusScreen(currentId);
    } else {
        renderSendScreen();
    }
}

// 1. 送信画面
function renderSendScreen() {
    headerTitle.textContent = 'メッセージを送る';
    mainContent.innerHTML = `
        <div class="notice-box">
            <p>匿名で何でもメッセージを送ってください。<br>頂いた内容はLuca-GPTの学習に役立てます！</p>
        </div>
        <textarea id="messageInput" placeholder="ここにメッセージを入力..."></textarea>
        <button id="sendBtn">送信する</button>
    `;

    document.getElementById('sendBtn').addEventListener('click', async () => {
        const text = document.getElementById('messageInput').value;
        if (!text.trim()) return;

        const btn = document.getElementById('sendBtn');
        btn.textContent = '送信中...';
        btn.disabled = true;

        const { data, error } = await supabaseClient
            .from('messages')
            .insert([{ message: text }])
            .select();

        if (error || !data || data.length === 0) {
            alert('通信がうまくいきませんでした。時間をおいてやり直してください。');
            btn.textContent = '送信する';
            btn.disabled = false;
            return;
        }

        renderCompleteScreen(data[0].id);
    });
}

// 2. 送信完了画面（専用リンクの発行）
function renderCompleteScreen(id) {
    headerTitle.textContent = '送信完了';
    
    const currentUrl = window.location.href.split('?')[0];
    const personalLink = `${currentUrl}?id=${id}`;

    mainContent.innerHTML = `
        <div class="notice-box">
            <h3>ありがとうございます！</h3>
            <p>メッセージを受け取りました。お返事をお待ちください。</p>
        </div>
        <p>以下のURLがあなた専用の確認リンクです。メモ帳などに保存してください。</p>
        <input type="text" id="linkInput" class="link-input" value="${personalLink}" readonly>
        <button id="copyBtn">URLをコピーする</button>
        <br><br>
        <button onclick="window.location.href='${currentUrl}'" style="background-color:#7f8c8d;">新しく送る</button>
    `;

    document.getElementById('copyBtn').addEventListener('click', () => {
        const linkInput = document.getElementById('linkInput');
        linkInput.select();
        document.execCommand('copy');
        document.getElementById('copyBtn').textContent = 'コピーしました！';
    });
}

// 3. 確認画面（専用リンクから開いた場合）
async function renderStatusScreen(id) {
    headerTitle.textContent = 'メッセージの確認';
    mainContent.innerHTML = `<p style="text-align:center;">データを読み込んでいます...</p>`;

    const { data, error } = await supabaseClient
        .from('messages')
        .select('*')
        .eq('id', id)
        .single();

    if (error || !data) {
        mainContent.innerHTML = `<p style="text-align:center;">情報が見つかりません。URLが正しいか確認してください。</p>`;
        return;
    }

    if (!data.reply) {
        // 返答がまだの場合
        mainContent.innerHTML = `
            <div class="notice-box">
                <h3>メッセージを確認しました</h3>
                <p>現在、お返事を準備中です。もうしばらくお待ちください。<br>貴重なメッセージをありがとうございます！</p>
            </div>
            <div class="chat-container" style="margin-top: 20px;">
                <div class="message-bubble message-mine">${escapeHTML(data.message)}</div>
            </div>
        `;
    } else {
        // 返答が来た場合
        mainContent.innerHTML = `
            <div class="notice-box" style="background-color:#e6f4ea; border-color:#ceead6; color:#137333;">
                <p>お返事が届きました！ご協力ありがとうございます。</p>
            </div>
            <div class="chat-container" style="margin-top: 20px;">
                <div class="message-bubble message-mine">${escapeHTML(data.message)}</div>
                <div class="message-bubble message-theirs">${escapeHTML(data.reply)}</div>
            </div>
        `;
    }
}

// 4. 管理者画面（?admin=true で開いた場合）
async function renderAdminScreen() {
    headerTitle.textContent = '管理者: 未返信リスト';
    mainContent.innerHTML = `<p style="text-align:center;">読み込み中...</p>`;

    const { data, error } = await supabaseClient
        .from('messages')
        .select('*')
        .is('reply', null)
        .order('created_at', { ascending: false });

    if (error) {
        mainContent.innerHTML = `<p>データの取得に失敗しました。</p>`;
        return;
    }

    if (data.length === 0) {
        mainContent.innerHTML = `<p style="text-align:center;">未返信のメッセージはありません。</p>`;
        return;
    }

    let htmlStr = '';
    data.forEach(msg => {
        htmlStr += `
            <div class="admin-card" id="card-${msg.id}">
                <p><strong>受信メッセージ:</strong><br>${escapeHTML(msg.message)}</p>
                <textarea id="reply-${msg.id}" placeholder="返信を入力..."></textarea>
                <button onclick="sendReply('${msg.id}')">返信する</button>
            </div>
        `;
    });
    mainContent.innerHTML = htmlStr;
}

// 返信を保存する処理
window.sendReply = async function(id) {
    const replyText = document.getElementById(`reply-${id}`).value;
    if (!replyText.trim()) return;

    const { error } = await supabaseClient
        .from('messages')
        .update({ reply: replyText })
        .eq('id', id);

    if (error) {
        alert('送信がうまくいきませんでした。');
    } else {
        // 送信できたら画面から消す
        document.getElementById(`card-${id}`).style.display = 'none';
    }
};

// 安全に文字を表示するための処理
function escapeHTML(str) {
    return str.replace(/[&<>'"]/g, function(tag) {
        const chars = { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' };
        return chars[tag] || tag;
    });
}

// アプリの開始
init();