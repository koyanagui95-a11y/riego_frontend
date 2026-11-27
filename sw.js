const CACHE_NAME = 'riego-user-v2';
const ASSETS = [
    './',
    './index.html',
    './login.html',
    './manifest.json',
    './icono-riego-inteligente.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS).catch(() => {}))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;
    event.respondWith(
        fetch(event.request)
            .then((res) => {
                const copy = res.clone();
                caches.open(CACHE_NAME).then((c) => c.put(event.request, copy));
                return res;
            })
            .catch(() => caches.match(event.request))
    );
});

self.addEventListener('push', function (event) {
    let data = { title: 'Riego Inteligente', body: '' };
    try { if (event.data) data = event.data.json(); } catch (e) {}

    const options = {
        body: data.body || '',
        icon: './icono-riego-inteligente.png',
        badge: './icono-riego-inteligente.png',
        vibrate: [200, 100, 200],
        tag: data.tag || 'riego',
        renotify: true,
        requireInteraction: !!data.requireInteraction,
        data: { timestamp: data.timestamp || Date.now() }
    };
    event.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener('notificationclick', function (event) {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
            for (const c of list) if ('focus' in c) return c.focus();
            if (clients.openWindow) return clients.openWindow('./index.html');
        })
    );
});