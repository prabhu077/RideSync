/* ================================================================
   sw.js  –  RideSync  |  Service Worker
   Offline-first PWA caching for a low-connectivity environment.

   Strategy:
     App shell (HTML/CSS/JS)  →  Cache-first (versioned)
     Leaflet map tiles         →  Cache-first  (long-lived)
     Firebase API calls        →  Network-first, fallback to cache
     Everything else           →  Network-first, fallback to cache
   ================================================================ */

"use strict";

const CACHE_VERSION = "ridesync-v1.2";

/* Files that MUST be cached for the app to work offline */
const APP_SHELL = [
  "./index.html",
  "./style.css",
  "./app.js",
  "./firebase-config.js",
  "./manifest.json",
  "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap"
];

/* CDN resources (Leaflet, Firebase) – cache on first use */
const CDN_ORIGINS = [
  "https://www.gstatic.com",
  "https://unpkg.com",
  "https://tile.openstreetmap.org",
  "https://fonts.gstatic.com",
  "https://fonts.googleapis.com",
  "https://api.qrserver.com"
];

/* Firebase API – use network-first but never block offline */
const FIREBASE_ORIGINS = [
  "https://firestore.googleapis.com",
  "https://firebase.googleapis.com",
  "https://firebaseio.com"
];

/* ── Install ────────────────────────────────────────────────────── */
self.addEventListener("install", event => {
  console.log("[SW] Installing", CACHE_VERSION);
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => {
      /* Pre-cache the app shell; ignore individual failures gracefully */
      return Promise.allSettled(
        APP_SHELL.map(url =>
          cache.add(url).catch(err =>
            console.warn("[SW] Pre-cache failed for", url, err.message)
          )
        )
      );
    }).then(() => self.skipWaiting())
  );
});

/* ── Activate – clean up old caches ────────────────────────────── */
self.addEventListener("activate", event => {
  console.log("[SW] Activating", CACHE_VERSION);
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_VERSION)
          .map(key => {
            console.log("[SW] Deleting old cache:", key);
            return caches.delete(key);
          })
      )
    ).then(() => self.clients.claim())
  );
});

/* ── Fetch ──────────────────────────────────────────────────────── */
self.addEventListener("fetch", event => {
  const { request } = event;
  const url = new URL(request.url);

  /* Skip non-GET and cross-origin chrome-extension requests */
  if (request.method !== "GET") return;
  if (url.protocol === "chrome-extension:") return;

  /* Firebase — network-first, short timeout, fall back to cache */
  if (FIREBASE_ORIGINS.some(o => request.url.includes(o))) {
    event.respondWith(networkFirstWithTimeout(request, 4000));
    return;
  }

  /* Map tiles — cache-first (tiles rarely change) */
  if (url.hostname.includes("tile.openstreetmap.org") ||
      url.hostname.includes("openstreetmap")) {
    event.respondWith(cacheFirst(request, "tiles-v1"));
    return;
  }

  /* CDN resources — cache-first with network fallback */
  if (CDN_ORIGINS.some(o => request.url.startsWith(o))) {
    event.respondWith(cacheFirst(request, CACHE_VERSION));
    return;
  }

  /* App shell and same-origin assets — cache-first */
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request, CACHE_VERSION));
    return;
  }

  /* Everything else — network-first */
  event.respondWith(networkFirst(request));
});

/* ── Strategy: Cache-First ──────────────────────────────────────── */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    /* Return offline fallback for navigation requests */
    if (request.mode === "navigate") {
      const fallback = await cache.match("./index.html");
      if (fallback) return fallback;
    }
    return new Response("Offline – resource unavailable.", {
      status: 503,
      headers: { "Content-Type": "text/plain" }
    });
  }
}

/* ── Strategy: Network-First ────────────────────────────────────── */
async function networkFirst(request) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: "offline" }), {
      status: 503,
      headers: { "Content-Type": "application/json" }
    });
  }
}

/* ── Strategy: Network-First with Timeout ───────────────────────── */
async function networkFirstWithTimeout(request, timeoutMs) {
  const cache = await caches.open(CACHE_VERSION);

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("timeout")), timeoutMs)
  );

  try {
    const response = await Promise.race([fetch(request), timeout]);
    if (response.ok) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) {
      console.log("[SW] Serving Firebase response from cache (offline/slow)");
      return cached;
    }
    return new Response(JSON.stringify({ error: "offline" }), {
      status: 503,
      headers: { "Content-Type": "application/json" }
    });
  }
}

/* ── Background Sync – retry failed GPS pushes ──────────────────── */
self.addEventListener("sync", event => {
  if (event.tag === "sync-gps") {
    event.waitUntil(replayPendingGPS());
  }
});

async function replayPendingGPS() {
  /* Pending GPS payloads are stored in IndexedDB by app.js
     This SW picks them up and re-sends when connectivity returns */
  try {
    const db = await openDB();
    const tx = db.transaction("pending_gps", "readwrite");
    const store = tx.objectStore("pending_gps");
    const all = await promisifyRequest(store.getAll());
    for (const item of all) {
      try {
        await fetch(item.url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(item.payload)
        });
        store.delete(item.id);
      } catch {
        console.warn("[SW] GPS replay failed, will retry later");
      }
    }
  } catch (e) {
    console.warn("[SW] Background sync DB error:", e);
  }
}

/* ── IndexedDB helpers (lightweight, no lib) ────────────────────── */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("ridesync_sw", 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore("pending_gps", {
        keyPath: "id", autoIncrement: true
      });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

function promisifyRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

/* ── Push Notifications (optional – for ETA alerts) ─────────────── */
self.addEventListener("push", event => {
  if (!event.data) return;
  let data;
  try { data = event.data.json(); } catch { return; }

  const title   = data.title   || "RideSync";
  const options = {
    body:    data.body   || "Bus update available",
    icon:    "./icon-192.png",
    badge:   "./icon-192.png",
    tag:     data.tag    || "bus-update",
    renotify: true,
    data:    { url: data.url || "./" },
    actions: [
      { action: "view", title: "View" },
      { action: "dismiss", title: "Dismiss" }
    ]
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  if (event.action === "dismiss") return;
  const url = event.notification.data?.url || "./";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes(self.location.origin)) {
          client.focus();
          client.navigate(url);
          return;
        }
      }
      return clients.openWindow(url);
    })
  );
});

console.log("[SW] RideSync service worker loaded –", CACHE_VERSION);
