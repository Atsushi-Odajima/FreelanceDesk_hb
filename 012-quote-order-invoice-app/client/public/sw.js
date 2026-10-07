/* Freelance Desk Service Worker
 * - アプリシェル（HTML/JS/CSS/アイコン）をキャッシュしてオフラインでも起動可能にする
 * - GET /api/* はネットワーク優先。失敗時のみ直近の取得結果を返す（閲覧用。x-fd-offline ヘッダ付き）
 * - 更新系（POST/PUT/PATCH/DELETE）はキャッシュも再送もしない（オフライン同期はしない）
 * - PDF・添付・バックアップ・CSVはキャッシュしない
 */
const VERSION = 'fd-v2';
const SHELL = `${VERSION}-shell`;
const API = `${VERSION}-api`;
const SHELL_URLS = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_URLS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'clear-api-cache') event.waitUntil(caches.delete(API));
});

// クライアントポータル（お客様向け）は認可・公開状態を確実に反映するため一切キャッシュしない
const NO_CACHE_API = [/^\/api\/pdf\//, /^\/api\/attachments\//, /^\/api\/data\//, /^\/api\/auth\//, /^\/api\/portal\//, /\/portal\/.*\/export$/];

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    if (NO_CACHE_API.some((re) => re.test(url.pathname))) return;
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(API).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.open(API).then((c) => c.match(req));
          if (!cached) return new Response(JSON.stringify({ error: { message: 'オフラインのため表示できません', code: 'offline' } }), { status: 503, headers: { 'Content-Type': 'application/json' } });
          const headers = new Headers(cached.headers);
          headers.set('x-fd-offline', '1');
          return new Response(await cached.blob(), { status: 200, headers });
        }),
    );
    return;
  }

  // 画面遷移：ネットワーク優先、オフライン時はキャッシュ済みのアプリシェル
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }

  // 静的ファイル：/assets/ はファイル名にハッシュがあるためキャッシュ優先
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(SHELL).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});
