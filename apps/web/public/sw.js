/**
 * M9.2 Service Worker — Web Push handling
 * No hard-coded branding, uses push payload data.
 * Handles push events and notification clicks safely.
 */

self.addEventListener('push', (event) => {
  let data = {};
  try {
    if (event.data) {
      data = event.data.json();
    }
  } catch {
    data = { subject: 'VeltrixEye alert', text: event.data ? event.data.text() : 'New alert' };
  }
  const title = data.subject || 'VeltrixEye alert';
  const body = data.text || 'You have a new trading alert';
  const alertId = data.data?.alertId || data.data?.alert_id || null;

  const options = {
    body,
    icon: '/icon.png',
    badge: '/badge.png',
    data: { alertId, url: alertId ? `/alerts/${alertId}` : '/alerts' },
    tag: data.idempotencyKey || `veltrixeye-${Date.now()}`,
    requireInteraction: false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/alerts';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          // If a window is already open, focus it and navigate
          if (client.url.includes(url) || client.url.includes('/alerts') || client.url.includes('/dashboard')) {
            return client.focus();
          }
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
      return undefined;
    }),
  );
});

self.addEventListener('pushsubscriptionchange', (event) => {
  // Subscription expired — the UI will detect missing subscription and resubscribe
  event.waitUntil(
    self.registration.pushManager
      .subscribe(event.oldSubscription ? { ...event.oldSubscription.options, applicationServerKey: event.oldSubscription.options.applicationServerKey } : { userVisibleOnly: true })
      .then((newSubscription) => {
        // Attempt to send new subscription to server — best effort, will be handled on next UI load
        return fetch('/api/notifications/push/subscriptions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            endpoint: newSubscription.endpoint,
            keys: {
              p256dh: newSubscription.toJSON().keys.p256dh,
              auth: newSubscription.toJSON().keys.auth,
            },
          }),
        }).catch(() => {});
      }),
  );
});
