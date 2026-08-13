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
    // PWAのインストール要件を満たすためのダミーイベントです。
    // 何も介入せず、通常のインターネット通信にすべてお任せします。
    return;
});