// Minimal service worker: makes the site installable ("홈 화면에 추가") and shows a friendly page when offline.
// Everything else goes straight to the network — search results and login must always be fresh.
const OFFLINE = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ref</title><body style="font:15px -apple-system,sans-serif;display:grid;place-items:center;min-height:90vh;text-align:center;color:#555"><div><h2>인터넷 연결이 없어요</h2><p>연결되면 다시 열어 주세요.</p></div>';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => new Response(OFFLINE, { headers: { 'content-type': 'text/html; charset=utf-8' } })));
});
