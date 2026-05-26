/* Robotrend IA — Service Worker
   ---------------------------------------------------------------
   v6.5.0 — Bump para invalidar cache de dashboard.js (guard master),
            saas-nav.js (sidebar Cliente/Master) e index.html
            (snapshot master). Estratégia mantida:
     - Navegações HTML  → NETWORK-ONLY
     - Assets estáticos → Cache-first com expulsão automática no bump
     - API/Socket.io    → bypass total
*/
const VERSION = 'v6.5.0';
const CACHE_STATIC = `robotrend-static-${VERSION}`;

// Apenas assets estáticos (não-HTML). HTML é sempre network-only.
const STATIC_SHELL = [
  '/output.css',
  '/style.css',
  '/manifest.json',
  '/js/auth.js',
  '/js/auth-guard.js',
  '/js/saas-nav.js',
  '/js/pwa.js',
  '/js/payments.js',
  '/js/user-state.js',
  '/js/upgrade-celebration.js',
  '/js/promo-banner.js',
  '/js/dashboard.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_STATIC)
      .then((c) => c.addAll(STATIC_SHELL).catch(() => {}))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(
      // Apaga TODOS os caches antigos (inclui v5.1.0 e anteriores que
      // possam ter HTMLs incorretos guardados)
      keys.filter((k) => k !== CACHE_STATIC).map((k) => caches.delete(k))
    )).catch(() => {})
  );
  self.clients.claim();
});

function isHtmlNavigation(request, url) {
  if (request.mode === 'navigate') return true;
  if (request.destination === 'document') return true;
  if (url.pathname.endsWith('.html')) return true;
  if (url.pathname === '/') return true;
  return false;
}

async function networkOnly(request) {
  try {
    return await fetch(request, { cache: 'no-store' });
  } catch (err) {
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>Offline</title>'
      + '<style>body{font-family:system-ui;display:grid;place-items:center;min-height:100vh;background:#07100a;color:#e6f4ec}</style>'
      + '<div><h1>Você está offline</h1><p>Verifique sua conexão.</p></div>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

async function cacheFirst(request) {
  try {
    const cached = await caches.match(request);
    if (cached) return cached;
  } catch (_) {}
  try {
    const res = await fetch(request);
    if (res && res.ok && res.type === 'basic') {
      try {
        const cache = await caches.open(CACHE_STATIC);
        await cache.put(request, res.clone());
      } catch (_) {}
    }
    return res;
  } catch (err) {
    return new Response('', { status: 504 });
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); }
  catch (_) { return; }

  // Bypass: API, Socket.io, cross-origin → deixa o navegador tratar
  if (
    url.pathname.startsWith('/api/')
    || url.pathname.startsWith('/socket.io/')
    || url.origin !== self.location.origin
  ) return;

  // HTML / navegação → SEMPRE network (sem cache). Garante que cada URL
  // abre a página real correspondente sem risco de servir cópia antiga.
  if (isHtmlNavigation(req, url)) {
    e.respondWith(networkOnly(req));
    return;
  }

  // Assets estáticos (CSS/JS/imagens) → cache-first
  e.respondWith(cacheFirst(req));
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) {}
  const title = data.title || '🔥 Robotrend IA';
  const body = data.body || 'Novo sinal disponível';
  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/manifest.json',
      badge: '/manifest.json',
      vibrate: [100, 50, 100],
      data: { url: data.url || '/' },
    }).catch(() => {})
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(self.clients.openWindow(url).catch(() => {}));
});

// Permite forçar update via postMessage do client (debugging)
self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});
