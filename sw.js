self.addEventListener('push', function (event) {
    const data = event.data ? event.data.json() : {};
    const title = data.title || 'Riego Inteligente';
    const options = {
        body: data.body || 'Humedad baja detectada',
        icon: '/icono-riego-inteligente.png',
        badge: '/icono-riego-inteligente.png',
        vibrate: [200, 100, 200]
    };
    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
    event.notification.close();
    event.waitUntil(clients.openWindow('/'));
});