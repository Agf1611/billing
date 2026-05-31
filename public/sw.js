const CACHE_NAME = 'billing-pwa-v8';
const PRECACHE_URLS = [
  '/css/style.css',
  '/css/admin.css',
  '/img/logo.png',
  '/img/pwa-icon.svg',
  '/img/hero.png',
  '/pwa/customer.webmanifest',
  '/pwa/admin.webmanifest',
  '/pwa/tech.webmanifest',
  '/pwa/agent.webmanifest',
  '/pwa/collector.webmanifest'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) =>
        Promise.all(keys.map((k) => (k === CACHE_NAME ? null : caches.delete(k))))
      ),
      self.clients.claim()
    ])
  );
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  const cache = await caches.open(CACHE_NAME);
  if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
  return res;
}

async function networkFirst(request, fallbackUrl) {
  try {
    const res = await fetch(request);
    const cache = await caches.open(CACHE_NAME);
    if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (fallbackUrl) {
      const fallback = await caches.match(fallbackUrl);
      if (fallback) return fallback;
    }
    return new Response('Offline', {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;

  const isPortalNavigation =
    req.mode === 'navigate' &&
    (
      path.startsWith('/admin') ||
      path.startsWith('/tech') ||
      path.startsWith('/agent') ||
      path.startsWith('/collector')
    );

  if (isPortalNavigation) {
    event.respondWith(fetch(req, { cache: 'no-store' }));
    return;
  }

  if (path.startsWith('/customer/api/')) {
    event.respondWith((async () => {
      try {
        return await fetch(req, { cache: 'no-store' });
      } catch (_) {
        return new Response(JSON.stringify({ ok: false, error: 'offline' }), {
          status: 503,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
          }
        });
      }
    })());
    return;
  }

  if (path.startsWith('/css/') || path.startsWith('/img/') || path.startsWith('/pwa/') || path.endsWith('/manifest.webmanifest') || path === '/manifest.webmanifest') {
    event.respondWith(cacheFirst(req));
    return;
  }

  event.respondWith(networkFirst(req));
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'SHOW_NOTIFICATION') return;
  const title = String(data.title || 'SICKAS WIFI');
  const options = {
    body: String(data.body || ''),
    icon: data.icon || '/img/logo.png',
    badge: data.badge || '/img/logo.png',
    tag: data.tag || `notif-${Date.now()}`,
    data: data.data || {},
    renotify: Boolean(data.renotify),
    requireInteraction: Boolean(data.requireInteraction)
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification?.data?.url || '/';
  event.waitUntil((async () => {
    const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      if ('focus' in client) {
        try {
          await client.focus();
          if (targetUrl && 'navigate' in client) {
            await client.navigate(targetUrl);
          }
          return;
        } catch (_) {}
      }
    }
    if (clients.openWindow) {
      return clients.openWindow(targetUrl);
    }
  })());
});
