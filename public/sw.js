const CACHE = "ariana-v2";
const ASSETS = ["/manifest.json", "/icons/icon-192.svg", "/icons/icon-512.svg"];

// ── INSTALL ───────────────────────────────────────────────────
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

// ── ACTIVATE ──────────────────────────────────────────────────
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

// ── FETCH ─────────────────────────────────────────────────────
// HTML (index.html / "/") → network-first so updates always reach the browser
// Everything else         → cache-first for speed
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;

  const url = new URL(e.request.url);
  const isHTML = url.pathname === "/" || url.pathname.endsWith(".html");

  if (isHTML) {
    // Network-first: try server, fall back to cache only if offline
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
  } else {
    // Cache-first for static assets (icons, manifest)
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
  }
});

// ── PUSH NOTIFICATION ─────────────────────────────────────────
self.addEventListener("push", e => {
  let data = { title: "Ariana", body: "New message", phone: "", name: "" };
  try { data = { ...data, ...e.data.json() }; } catch {}

  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icons/icon-192.svg",
      badge: "/icons/icon-192.svg",
      tag: `chat-${data.phone}`,      // groups by contact — replaces old notification
      renotify: true,
      vibrate: [200, 100, 200],
      data: { phone: data.phone },
      actions: [
        { action: "open", title: "Open" },
        { action: "dismiss", title: "Dismiss" }
      ]
    })
  );
});

// ── NOTIFICATION CLICK ────────────────────────────────────────
self.addEventListener("notificationclick", e => {
  e.notification.close();
  if (e.action === "dismiss") return;

  const phone = e.notification.data?.phone;
  const url = phone ? `/?chat=${encodeURIComponent(phone)}` : "/";

  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          client.postMessage({ type: "OPEN_CHAT", phone });
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
