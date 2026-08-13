// sw.js
self.addEventListener('install', (event) => {
    // 新しいService Workerを即座に有効化
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    // ページの制御権を即座に取得
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
    // GETリクエスト以外（POST等）やHTTP(S)以外のスキーマはプロキシしない
    if (event.request.method !== 'GET' || !event.request.url.startsWith('http')) {
        return;
    }

    event.respondWith(
        fetch(event.request).catch(async () => {
            // ネットワーク通信が失敗した時のフォールバック処理
            const cache = await caches.open('pwa-cache-v1');
            const cachedResponse = await cache.match(event.request);
            
            // キャッシュがあればそれを返し、無ければエラーメッセージ付きのレスポンスを安全に返す
            return cachedResponse || new Response('通信エラーが発生しました。', {
                status: 503,
                headers: { 'Content-Type': 'text/plain; charset=utf-8' }
            });
        })
    );
});