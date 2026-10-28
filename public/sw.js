// Service worker Le Mot du Chef — notifications Web Push.
// La page reste servie en réseau (pas de cache agressif) : ce worker ne
// sert qu'au push et à l'installabilité PWA.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// Présence exigée par Chrome pour l'installabilité PWA. Aucun respondWith :
// le réseau gère tout, rien n'est jamais mis en cache (zéro risque de site
// figé après un déploiement).
self.addEventListener('fetch', () => {});

self.addEventListener('push', e => {
  let d = { title: 'Le Mot du Chef', body: 'Nouvelle réponse prête.', url: '/', tag: 'lmc' };
  try { Object.assign(d, e.data ? e.data.json() : {}); } catch { /* payload texte */ }
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body, tag: d.tag, icon: '/icon-192.png', badge: '/icon-192.png',
    data: { url: d.url }, requireInteraction: false,
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    // Réutilise un onglet ouvert sur l'app si possible, sinon ouvre le lien.
    const existing = list.find(c => 'focus' in c && new URL(c.url).origin === location.origin);
    if (existing) { existing.focus(); existing.postMessage({ type: 'push-open', url }); return; }
    return self.clients.openWindow(url);
  }));
});
