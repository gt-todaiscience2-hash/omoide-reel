/*
 * おもいでリール Service Worker
 * 役割はひとつだけ：ホーム画面に追加したあと、LINEなど他のアプリの「共有」から
 * 渡された写真を受け取り、ページに引き渡す。写真は端末内の一時キャッシュに置かれ、
 * ページが読み込んだ直後に削除される。外部への通信は行わない。
 */
'use strict';
const CACHE = 'omoide-share-v1';
const MAX_FILES = 60;
const MAX_BYTES = 40 * 1024 * 1024;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'POST' || url.origin !== self.location.origin || !url.pathname.endsWith('/share-target')) return;
  e.respondWith((async () => {
    try {
      const form = await e.request.formData();
      const files = form.getAll('photos').filter((f) => f instanceof File && f.size > 0 && f.size <= MAX_BYTES).slice(0, MAX_FILES);
      await caches.delete(CACHE);
      const cache = await caches.open(CACHE);
      let i = 0;
      for (const f of files) {
        await cache.put(new Request(`./__shared/${String(i++).padStart(3, '0')}`), new Response(f, {
          headers: { 'Content-Type': 'application/octet-stream', 'X-Last-Modified': String(Number(f.lastModified) || 0) }
        }));
      }
    } catch (_) { /* 受け取りに失敗しても、通常の画面を開く */ }
    return Response.redirect('./?shared=1', 303);
  })());
});
