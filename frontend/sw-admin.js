// /sw-admin.js
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'admin-notify') {
    const { title, body, tag, requireInteraction, data: extra } = data.payload || {};
    self.registration.showNotification(title || 'Shatova Admin', {
      body: body || 'New activity requires your attention.',
      tag: tag || 'shatova-admin',
      requireInteraction: !!requireInteraction,
      renotify: true,
      badge: '/favicon.ico',
      icon: '/favicon.ico',
      vibrate: [180, 90, 180, 90, 180],
      data: extra || {},
      actions: [
        { action: 'open', title: 'Open Admin' },
        { action: 'dismiss', title: 'Dismiss' }
      ]
    });
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  const url = (event.notification.data && event.notification.data.url) || '/admin.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const c of clients) if (c.url.includes('/admin')) { c.focus(); return; }
      return self.clients.openWindow(url);
    })
  );
});
