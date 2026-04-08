/* ================================================================
   app.js  –  RideSync  |  Core Application
   Vanilla JS, no frameworks. Hash-based SPA routing.
   ================================================================

   Architecture:
     App        – init, PWA setup, network detection
     Router     – hash routing, view switching
     DataStore  – Firestore / demo data reads, localStorage cache
     MapEngine  – Leaflet map, markers, polylines, live updates
     ETA        – haversine + speed-based arrival estimation
     Search     – bus/route search with recent history
     StopView   – renders /#stop=STOP_ID page
     BusView    – renders /#bus=BUS_NUM page
     HomeView   – renders / home page
     DownloadView – renders /#download=BUS_NUM page
     UI         – toast, modal, offline banner helpers

   ================================================================ */

"use strict";

/* ── Constants ─────────────────────────────────────────────────── */
const POLL_FAST = 15_000;   // ms – good network
const POLL_SLOW = 30_000;   // ms – slow / 2G network
const LS_CACHE_KEY = "btCache_v1";
const LS_RECENT_KEY = "btRecent";
const DEFAULT_LAT = 19.0760;  // Mumbai centre fallback
const DEFAULT_LNG = 72.8777;
const DEFAULT_ZOOM = 13;
const AVG_SPEED_KMH = 25;       // fallback bus speed

/* ── State ─────────────────────────────────────────────────────── */
const State = {
    currentView: null,
    mapInstance: null,
    mapInitialized: false,
    busMarkers: {},              // busId → Leaflet marker
    routeLayer: null,            // Leaflet polyline layer
    stopMarkers: [],              // Leaflet markers for stops
    userMarker: null,            // user's GPS dot
    userLatLng: null,            // { lat, lng }
    activeListeners: [],          // Firebase Realtime DB unsubscribe fns
    pollTimer: null,              // setInterval handle
    selectedRouteId: null,
    selectedBusId: null,
    selectedStopId: null,
    dataCache: {},                // { routes, stops, buses }
    firebaseReady: false
};

/* ================================================================
   APP – Entry Point
   ================================================================ */
const App = {
    async init() {
        UI.init();
        Network.init();
        Router.init();
        PWA.init();

        // Try to restore cache from localStorage first (instant offline data)
        DataStore.loadLocalCache();

        // Init Firebase (deferred – don't block render)
        await this.initFirebaseDeferred();

        // Route to current hash
        Router.route(location.hash);
    },

    async initFirebaseDeferred() {
        // Firebase SDK is loaded async via CDN; poll until ready
        return new Promise(resolve => {
            const tryInit = () => {
                if (typeof firebase !== "undefined") {
                    State.firebaseReady = initFirebase();
                    resolve();
                } else {
                    setTimeout(tryInit, 200);
                }
            };
            tryInit();
        });
    }
};

/* ================================================================
   PWA  –  Service Worker + install prompt
   ================================================================ */
const PWA = {
    deferredPrompt: null,

    init() {
        if ("serviceWorker" in navigator) {
            navigator.serviceWorker.register("./sw.js")
                .then(reg => console.log("[PWA] SW registered:", reg.scope))
                .catch(err => console.warn("[PWA] SW error:", err));
        }

        window.addEventListener("beforeinstallprompt", e => {
            e.preventDefault();
            this.deferredPrompt = e;
            const btn = document.getElementById("install-btn");
            if (btn) btn.style.display = "flex";
        });

        const iBtn = document.getElementById("install-btn");
        if (iBtn) {
            iBtn.addEventListener("click", () => this.promptInstall());
        }
    },

    promptInstall() {
        if (!this.deferredPrompt) { UI.toast("App already installed!"); return; }
        this.deferredPrompt.prompt();
        this.deferredPrompt.userChoice.then(r => {
            if (r.outcome === "accepted") UI.toast("✅ Bus Tracker installed!");
            this.deferredPrompt = null;
            const b = document.getElementById("install-btn");
            if (b) b.style.display = "none";
        });
    }
};

/* ================================================================
   NETWORK  –  Adaptive polling, offline detection
   ================================================================ */
const Network = {
    isOnline: navigator.onLine,
    pollInterval: POLL_FAST,

    init() {
        window.addEventListener("online", () => this.setOnline(true));
        window.addEventListener("offline", () => this.setOnline(false));
        this.updatePollInterval();
    },

    setOnline(flag) {
        this.isOnline = flag;
        document.getElementById("offline-banner").classList.toggle("show", !flag);
        this.updatePollInterval();
    },

    updatePollInterval() {
        const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (!this.isOnline) { this.pollInterval = 0; return; }
        if (conn) {
            const ect = conn.effectiveType;
            this.pollInterval = (ect === "2g" || ect === "slow-2g") ? POLL_SLOW : POLL_FAST;
        } else {
            this.pollInterval = POLL_FAST;
        }
    },

    get isSlowNetwork() {
        const conn = navigator.connection;
        return conn ? (conn.effectiveType === "2g" || conn.effectiveType === "slow-2g") : false;
    }
};

/* ================================================================
   ROUTER  –  Hash-based SPA routing
   ================================================================ */
const Router = {
    init() {
        window.addEventListener("hashchange", () => Router.route(location.hash));
        // Handle QR ?stop= param → convert to hash
        const u = new URL(location.href);
        const qrStop = u.searchParams.get("stop");
        const qrBus = u.searchParams.get("bus");
        if (qrStop) { history.replaceState(null, "", `#stop=${qrStop}`); }
        if (qrBus) { history.replaceState(null, "", `#bus=${qrBus}`); }
    },

    route(hash) {
        hash = hash || "#home";
        if (hash === "#" || hash === "") hash = "#home";

        // Parse hash patterns
        if (hash === "#home" || hash === "#") {
            this.show("home");
            HomeView.render();
        } else if (hash.startsWith("#stop=")) {
            const stopId = hash.split("=")[1];
            this.show("stop");
            StopView.render(stopId);
        } else if (hash.startsWith("#bus=")) {
            const busNum = hash.split("=")[1];
            this.show("bus");
            BusView.render(busNum);
        } else if (hash.startsWith("#download=")) {
            const busNum = hash.split("=")[1];
            this.show("download");
            DownloadView.render(busNum);
        } else if (hash === "#qr") {
            this.show("home");
            HomeView.render();
            setTimeout(() => UI.openQrModal("STOP001"), 300);
        } else {
            this.show("home");
            HomeView.render();
        }

        // Scroll to top
        window.scrollTo({ top: 0, behavior: "instant" });
        // Stop existing polls
        this.clearPolls();
    },

    show(viewName) {
        // Hide all views
        document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
        // Show target
        const target = document.getElementById(`view-${viewName}`);
        if (target) target.classList.add("active");

        State.currentView = viewName;

        // Update nav
        document.querySelectorAll(".nav-item").forEach(b => {
            b.classList.toggle("active", b.dataset.view === viewName);
        });

        // Back button visibility
        const backBtn = document.getElementById("back-btn");
        const headerLogo = document.getElementById("header-logo");
        if (viewName === "home") {
            backBtn.style.display = "none";
            headerLogo.style.display = "flex";
        } else {
            backBtn.style.display = "flex";
            headerLogo.style.display = "none";
        }
    },

    clearPolls() {
        if (State.pollTimer) { clearInterval(State.pollTimer); State.pollTimer = null; }
        // Detach Firebase listeners
        State.activeListeners.forEach(fn => { try { fn(); } catch { } });
        State.activeListeners = [];
    },

    navigate(hash) {
        location.hash = hash;
    }
};

/* ================================================================
   DATA STORE  –  Firestore / Demo data, localStorage caching
   ================================================================ */
const DataStore = {

    // ── Fetch all routes from Firestore or demo data ──
    async getRoutes() {
        if (State.dataCache.routes) return State.dataCache.routes;

        // Try Firestore
        if (State.firebaseReady && db) {
            try {
                const snap = await db.collection("routes").get();
                if (!snap.empty) {
                    const routes = {};
                    snap.forEach(doc => { routes[doc.id] = { id: doc.id, ...doc.data() }; });
                    State.dataCache.routes = routes;
                    this.saveLocalCache();
                    return routes;
                }
            } catch (e) {
                console.warn("[DataStore] Firestore routes failed, using demo data:", e.message);
            }
        }

        // Fallback to demo
        State.dataCache.routes = DEMO_DATA.routes;
        return DEMO_DATA.routes;
    },

    // ── Fetch all stops ──
    async getStops() {
        if (State.dataCache.stops) return State.dataCache.stops;

        if (State.firebaseReady && db) {
            try {
                const snap = await db.collection("stops").get();
                if (!snap.empty) {
                    const stops = {};
                    snap.forEach(doc => { stops[doc.id] = { id: doc.id, ...doc.data() }; });
                    State.dataCache.stops = stops;
                    this.saveLocalCache();
                    return stops;
                }
            } catch (e) {
                console.warn("[DataStore] Firestore stops failed:", e.message);
            }
        }

        State.dataCache.stops = DEMO_DATA.stops;
        return DEMO_DATA.stops;
    },

    // ── Get a single stop ──
    async getStop(stopId) {
        const stops = await this.getStops();
        return stops[stopId] || null;
    },

    // ── Get a single route ──
    async getRoute(routeId) {
        const routes = await this.getRoutes();
        return routes[routeId] || null;
    },

    // ── Find route by bus number (shortName) ──
    async getRouteByBusNum(busNum) {
        const routes = await this.getRoutes();
        return Object.values(routes).find(r =>
            r.shortName === String(busNum) ||
            r.id.includes(String(busNum))
        ) || null;
    },

    // ── Get buses on a route ──
    async getBusesOnRoute(routeId) {
        // From demo data or Firestore
        const allBuses = State.dataCache.buses || DEMO_DATA.buses;
        return Object.entries(allBuses)
            .filter(([_, b]) => b.routeId === routeId)
            .map(([id, b]) => ({ id, ...b }));
    },

    // ── Subscribe to live bus GPS (Firebase Realtime DB) ──
    subscribeBusGPS(busId, callback) {
        if (State.firebaseReady && rtdb) {
            const ref = rtdb.ref(`buses/${busId}`);
            ref.on("value", snap => {
                const data = snap.val();
                if (data) callback({ id: busId, ...data });
            });
            // Return unsubscribe fn
            const unsub = () => ref.off("value");
            State.activeListeners.push(unsub);
            return unsub;
        } else {
            // Demo: simulate movement
            return this.simulateBusMovement(busId, callback);
        }
    },

    // ── Simulate bus movement for demo ──
    simulateBusMovement(busId, callback) {
        const bus = DEMO_DATA.buses[busId];
        if (!bus) return () => { };

        const route = DEMO_DATA.routes[bus.routeId];
        const stops = route ? route.stops.map(sid => DEMO_DATA.stops[sid]).filter(Boolean) : [];
        let idx = bus.currentStopIndex || 0;
        let progress = 0; // 0..1 between stops

        // Emit immediately
        callback({ id: busId, ...bus });

        const timer = setInterval(() => {
            if (stops.length < 2) return;
            progress += 0.08;
            if (progress >= 1) { progress = 0; idx = (idx + 1) % (stops.length - 1); }

            const from = stops[idx];
            const to = stops[(idx + 1) % stops.length];
            if (!from || !to) return;

            const lat = from.lat + (to.lat - from.lat) * progress;
            const lng = from.lng + (to.lng - from.lng) * progress;
            const heading = ETA.bearing(from.lat, from.lng, to.lat, to.lng);

            callback({
                id: busId,
                routeId: bus.routeId,
                lat, lng, heading,
                speed: AVG_SPEED_KMH + (Math.random() * 10 - 5),
                timestamp: Date.now(),
                currentStopIndex: idx,
                nextStop: route.stops[idx + 1]
            });
        }, Network.pollInterval || POLL_FAST);

        const unsub = () => clearInterval(timer);
        State.activeListeners.push(unsub);
        return unsub;
    },

    // ── localStorage cache ──
    saveLocalCache() {
        try {
            localStorage.setItem(LS_CACHE_KEY, JSON.stringify({
                ts: Date.now(),
                routes: State.dataCache.routes,
                stops: State.dataCache.stops
            }));
        } catch { }
    },

    loadLocalCache() {
        try {
            const raw = localStorage.getItem(LS_CACHE_KEY);
            if (!raw) return;
            const data = JSON.parse(raw);
            // Use cache if <24 hours old
            if (Date.now() - data.ts < 86_400_000) {
                if (data.routes) State.dataCache.routes = data.routes;
                if (data.stops) State.dataCache.stops = data.stops;
                console.log("[DataStore] Loaded from localStorage cache");
            }
        } catch { }
    },

    // ── Recent search history ──
    getRecent() {
        try { return JSON.parse(localStorage.getItem(LS_RECENT_KEY) || "[]"); } catch { return []; }
    },
    addRecent(item) {
        try {
            const list = this.getRecent().filter(r => r.id !== item.id);
            list.unshift(item);
            localStorage.setItem(LS_RECENT_KEY, JSON.stringify(list.slice(0, 8)));
        } catch { }
    }
};

/* ================================================================
   ETA ENGINE  –  Haversine distance + speed-based ETAs
   ================================================================ */
const ETA = {
    // Haversine formula → km
    distance(lat1, lng1, lat2, lng2) {
        const R = 6371;
        const dLat = this.toRad(lat2 - lat1);
        const dLng = this.toRad(lng2 - lng1);
        const a =
            Math.sin(dLat / 2) ** 2 +
            Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
            Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    },

    toRad(d) { return d * Math.PI / 180; },

    // Bearing for icon rotation
    bearing(lat1, lng1, lat2, lng2) {
        const dLng = this.toRad(lng2 - lng1);
        const y = Math.sin(dLng) * Math.cos(this.toRad(lat2));
        const x = Math.cos(this.toRad(lat1)) * Math.sin(this.toRad(lat2)) -
            Math.sin(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) * Math.cos(dLng);
        return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    },

    // mins = distKm / speed * 60
    etaMins(distKm, speedKmh) {
        const spd = speedKmh && speedKmh > 2 ? speedKmh : AVG_SPEED_KMH;
        return (distKm / spd) * 60;
    },

    formatETA(mins) {
        if (mins <= 0) return "Arriving";
        if (mins < 1) return "< 1 min";
        if (mins < 60) return `${Math.round(mins)} min`;
        const h = Math.floor(mins / 60);
        const m = Math.round(mins % 60);
        return `${h}h ${m}m`;
    },

    // Remaining distance along route stops from busLat/Lng
    remainingRoute(busLat, busLng, stops /* [{ lat, lng }] */, targetStopIndex) {
        if (!stops || stops.length === 0) return 0;
        // Find closest stop index to bus
        let minDist = Infinity, busStopIdx = 0;
        stops.forEach((s, i) => {
            const d = this.distance(busLat, busLng, s.lat, s.lng);
            if (d < minDist) { minDist = d; busStopIdx = i; }
        });

        if (busStopIdx >= targetStopIndex) return 0;

        // Sum segment distances from bus to target stop
        let total = this.distance(busLat, busLng, stops[busStopIdx].lat, stops[busStopIdx].lng);
        for (let i = busStopIdx; i < targetStopIndex; i++) {
            total += this.distance(stops[i].lat, stops[i].lng, stops[i + 1].lat, stops[i + 1].lng);
        }
        return total;
    }
};

/* ================================================================
   MAP ENGINE  –  Leaflet.js wrapper
   ================================================================ */
const MapEngine = {
    BUS_SVG: (heading = 0, color = "#007BFF") => `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 56" width="40" height="56">
      <g transform="rotate(${heading - 0}, 20, 20)">
        <rect x="4" y="4" width="32" height="42" rx="6" fill="${color}" stroke="white" stroke-width="2"/>
        <rect x="8" y="8"  width="11" height="8" rx="2" fill="white" opacity=".85"/>
        <rect x="21" y="8" width="11" height="8" rx="2" fill="white" opacity=".85"/>
        <rect x="8" y="20" width="11" height="8" rx="2" fill="white" opacity=".85"/>
        <rect x="21" y="20" width="11" height="8" rx="2" fill="white" opacity=".85"/>
        <rect x="8" y="34" width="10" height="8" rx="3" fill="white" opacity=".85"/>
        <rect x="22" y="34" width="10" height="8" rx="3" fill="white" opacity=".85"/>
        <rect x="12" y="44" width="6" height="6"  rx="3" fill="#1A1A2E"/>
        <rect x="22" y="44" width="6" height="6"  rx="3" fill="#1A1A2E"/>
      </g>
      <circle cx="20" cy="20" r="5" fill="white" opacity=".9"/>
    </svg>`,

    STOP_SVG: (num = "", color = "#007BFF") => `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 40" width="30" height="40">
      <path d="M15 0 C6.7 0 0 6.7 0 15 C0 26 15 40 15 40 C15 40 30 26 30 15 C30 6.7 23.3 0 15 0Z" fill="${color}" stroke="white" stroke-width="1.5"/>
      <circle cx="15" cy="15" r="10" fill="white" opacity=".9"/>
      <text x="15" y="19.5" text-anchor="middle" font-size="9" font-weight="bold" fill="${color}" font-family="Inter,Arial">${num}</text>
    </svg>`,

    USER_SVG: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
      <circle cx="12" cy="12" r="10" fill="#4285F4" stroke="white" stroke-width="2"/>
      <circle cx="12" cy="12" r="4"  fill="white"/>
    </svg>`,

    // Lazy-load Leaflet from CDN then call back
    ensureLeaflet(cb) {
        if (typeof L !== "undefined") { cb(); return; }
        const css = document.createElement("link");
        css.rel = "stylesheet";
        css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
        document.head.appendChild(css);

        const script = document.createElement("script");
        script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
        script.onload = cb;
        script.onerror = () => console.error("[Map] Failed to load Leaflet");
        document.head.appendChild(script);
    },

    // Initialise map (only once)
    init(containerId = "map") {
        return new Promise(resolve => {
            this.ensureLeaflet(() => {
                if (State.mapInstance) {
                    State.mapInstance.invalidateSize();
                    resolve(State.mapInstance);
                    return;
                }
                const map = L.map(containerId, {
                    center: [DEFAULT_LAT, DEFAULT_LNG],
                    zoom: DEFAULT_ZOOM,
                    zoomControl: true,
                    attributionControl: false
                });

                // OpenStreetMap tiles
                L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
                    maxZoom: 19,
                    attribution: "© OpenStreetMap contributors",
                    crossOrigin: true
                }).addTo(map);

                L.control.attribution({ prefix: false, position: "bottomleft" }).addTo(map);

                State.mapInstance = map;
                resolve(map);
            });
        });
    },

    // Draw route polyline
    drawRoute(stops, color = "#007BFF") {
        const map = State.mapInstance;
        if (!map || !stops.length) return;

        if (State.routeLayer) { State.routeLayer.remove(); }

        const latlngs = stops.map(s => [s.lat, s.lng]);
        State.routeLayer = L.polyline(latlngs, {
            color, weight: 5, opacity: 0.85, smoothFactor: 1
        }).addTo(map);

        map.fitBounds(State.routeLayer.getBounds(), { padding: [40, 40] });
    },

    // Draw stop markers
    drawStops(stops, color = "#007BFF") {
        const map = State.mapInstance;
        // Clear old
        State.stopMarkers.forEach(m => m.remove());
        State.stopMarkers = [];

        stops.forEach((stop, i) => {
            const icon = L.divIcon({
                html: this.STOP_SVG(i + 1, color),
                iconSize: [30, 40],
                iconAnchor: [15, 40],
                className: ""
            });
            const marker = L.marker([stop.lat, stop.lng], { icon })
                .addTo(map)
                .bindPopup(`<b>${stop.name}</b><br><small>${stop.id}</small>`);
            State.stopMarkers.push(marker);
        });
    },

    // Update / add a bus marker
    updateBusMarker(busId, lat, lng, heading, color = "#007BFF", label = "") {
        const map = State.mapInstance;
        if (!map) return;

        const icon = L.divIcon({
            html: this.BUS_SVG(heading, color),
            iconSize: [40, 56],
            iconAnchor: [20, 56],
            className: ""
        });

        if (State.busMarkers[busId]) {
            State.busMarkers[busId].setLatLng([lat, lng]);
            State.busMarkers[busId].setIcon(icon);
        } else {
            State.busMarkers[busId] = L.marker([lat, lng], { icon, zIndexOffset: 1000 })
                .addTo(map)
                .bindPopup(`<b>Bus ${label || busId}</b><br>Heading: ${Math.round(heading)}°`);
        }
    },

    clearBusMarkers() {
        Object.values(State.busMarkers).forEach(m => m.remove());
        State.busMarkers = {};
    },

    // Show user location
    updateUserMarker(lat, lng) {
        const map = State.mapInstance;
        if (!map) return;
        const icon = L.divIcon({
            html: this.USER_SVG,
            iconSize: [24, 24],
            iconAnchor: [12, 12],
            className: ""
        });
        if (State.userMarker) {
            State.userMarker.setLatLng([lat, lng]);
        } else {
            State.userMarker = L.marker([lat, lng], { icon, zIndexOffset: 2000 })
                .addTo(map)
                .bindPopup("📍 Your location");
        }
    }
};

/* ================================================================
   HOME VIEW  –  Search + QR + Quick routes
   ================================================================ */
const HomeView = {
    async render() {
        UI.setTitle("🚌 RideSync");

        const el = document.getElementById("view-home");

        // Populate quick routes
        const routes = await DataStore.getRoutes();
        const qrContainer = el.querySelector("#quick-routes");
        if (qrContainer && Object.keys(routes).length) {
            qrContainer.innerHTML = Object.values(routes).map(r => `
        <button class="quick-route-btn" onclick="Router.navigate('#bus=${r.shortName}')">
          <span class="qr-num" style="color:${r.color || '#007BFF'}">${r.shortName}</span>
          <span style="font-size:.75rem;color:#5A6A7A;max-width:80px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${r.name.split("–")[1]?.trim() || ""}</span>
        </button>
      `).join("");
        }

        // Populate recent searches
        this.renderRecent();

        // Search handler
        const searchInput = document.getElementById("home-search");
        if (searchInput) {
            searchInput.addEventListener("input", e => this.handleSearch(e.target.value.trim()));
            searchInput.addEventListener("keydown", e => {
                if (e.key === "Enter") this.submitSearch(searchInput.value.trim());
            });
        }

        const searchBtn = document.getElementById("home-search-btn");
        if (searchBtn) {
            searchBtn.addEventListener("click", () => {
                const val = document.getElementById("home-search")?.value.trim();
                if (val) this.submitSearch(val);
            });
        }
    },

    renderRecent() {
        const list = DataStore.getRecent();
        const el = document.getElementById("recent-list");
        if (!el) return;
        if (!list.length) { el.innerHTML = `<p class="text-muted" style="padding:8px 0">No recent searches</p>`; return; }
        el.innerHTML = list.map(item => `
      <div class="suggestion-item" onclick="Router.navigate('${item.hash}')">
        <span class="s-icon">${item.type === "bus" ? "🚌" : "📍"}</span>
        <div>
          <div style="font-weight:600">${item.name}</div>
          <div class="text-muted" style="font-size:.82rem">${item.subtitle || ""}</div>
        </div>
      </div>
    `).join("");
    },

    async handleSearch(query) {
        const resultsEl = document.getElementById("search-results");
        if (!resultsEl) return;
        if (!query) { resultsEl.style.display = "none"; return; }

        const routes = await DataStore.getRoutes();
        const stops = await DataStore.getStops();

        const ql = query.toLowerCase();
        const routeMatches = Object.values(routes).filter(r =>
            r.shortName?.includes(query) || r.name?.toLowerCase().includes(ql)
        );
        const stopMatches = Object.values(stops).filter(s =>
            s.name?.toLowerCase().includes(ql) || s.id?.toLowerCase().includes(ql)
        ).slice(0, 4);

        const items = [
            ...routeMatches.map(r => ({
                icon: "🚌", name: `Bus ${r.shortName}`, subtitle: r.name,
                hash: `#bus=${r.shortName}`, type: "bus"
            })),
            ...stopMatches.map(s => ({
                icon: "📍", name: s.name, subtitle: s.id,
                hash: `#stop=${s.id}`, type: "stop"
            }))
        ];

        if (!items.length) {
            resultsEl.innerHTML = `<div class="suggestion-item"><span class="s-icon">🔍</span> No results found</div>`;
        } else {
            resultsEl.innerHTML = items.map(item => `
        <div class="suggestion-item" onclick="HomeView.selectResult('${item.hash}','${item.name}','${item.subtitle}','${item.type}','${item.icon}')">
          <span class="s-icon">${item.icon}</span>
          <div>
            <div style="font-weight:600">${item.name}</div>
            <div class="text-muted" style="font-size:.82rem">${item.subtitle}</div>
          </div>
        </div>
      `).join("");
        }
        resultsEl.style.display = "block";
    },

    selectResult(hash, name, subtitle, type, icon) {
        DataStore.addRecent({ id: hash, hash, name, subtitle, type, icon });
        document.getElementById("search-results").style.display = "none";
        Router.navigate(hash);
    },

    submitSearch(query) {
        if (!query) return;
        // If number, go to bus page directly
        if (/^\d+$/.test(query)) {
            Router.navigate(`#bus=${query}`);
        } else {
            this.handleSearch(query);
        }
    }
};

/* ================================================================
   STOP VIEW  –  /#stop=STOP_ID
   ================================================================ */
const StopView = {
    async render(stopId) {
        if (!stopId) { Router.navigate("#home"); return; }
        UI.setTitle("Bus Stop");

        const el = document.getElementById("view-stop");
        el.innerHTML = UI.loadingHTML("Loading stop info…");

        const [stop, routes, stops] = await Promise.all([
            DataStore.getStop(stopId),
            DataStore.getRoutes(),
            DataStore.getStops()
        ]);

        if (!stop) {
            el.innerHTML = `<div class="card"><p>⚠️ Stop <b>${stopId}</b> not found.</p><a href="#home" onclick="Router.navigate('#home'); return false;" class="btn btn-primary" style="margin-top:12px">← Go Home</a></div>`;
            return;
        }

        UI.setTitle(stop.name);
        DataStore.addRecent({ id: stopId, hash: `#stop=${stopId}`, name: stop.name, subtitle: stopId, type: "stop", icon: "📍" });

        // Find routes serving this stop
        const servingRoutes = (stop.routes || [])
            .map(rid => routes[rid])
            .filter(Boolean);

        // Build schedule for this stop across all serving routes
        const scheduleHTML = servingRoutes.map(route => {
            const times = (route.schedule || []).slice(0, 12);
            return `
        <div class="card">
          <div class="card-header">
            <div class="card-icon">🚌</div>
            <div>
              <div style="font-weight:700">${route.name}</div>
              <div class="text-muted" style="font-size:.82rem">${route.days || "Daily"}</div>
            </div>
            <span class="route-badge" style="background:${route.color || '#007BFF'};margin-left:auto">${route.shortName}</span>
          </div>
          <div class="section-title">Today's Schedule</div>
          <div class="schedule-grid">
            ${times.map((t, i) => `<div class="sched-time${i === 0 ? " next-time" : ""}">${t}</div>`).join("")}
            ${route.schedule?.length > 12 ? `<div class="sched-time" style="background:var(--text);color:#fff" onclick="Router.navigate('#bus=${route.shortName}')">+${route.schedule.length - 12} more</div>` : ""}
          </div>
          <div style="margin-top:12px">
            <button class="btn btn-primary btn-sm" onclick="Router.navigate('#bus=${route.shortName}')">🗺️ Track Bus ${route.shortName} Live</button>
          </div>
        </div>
      `;
        }).join("") || `<div class="card"><p class="text-muted">No routes found for this stop.</p></div>`;

        // Route stop index
        const stopIndexInRoute = servingRoutes[0]
            ? (servingRoutes[0].stops || []).indexOf(stopId)
            : -1;

        el.innerHTML = `
      <div class="card" style="background:linear-gradient(135deg,#007BFF,#0056B3);color:#fff;margin-bottom:16px">
        <div style="font-size:2rem;margin-bottom:6px">📍</div>
        <h2 style="color:#fff">${stop.name}</h2>
        <div style="opacity:.85;font-size:.88rem;margin-top:4px">${stopId} &nbsp;•&nbsp; ${stop.routes?.length || 0} route(s)</div>
        ${stopIndexInRoute >= 0 ? `<div style="opacity:.8;font-size:.82rem;margin-top:2px">Stop #${stopIndexInRoute + 1} on route</div>` : ""}
      </div>

      <div class="btn-row" style="margin-bottom:16px">
        <button class="btn btn-secondary btn-sm" onclick="UI.openQrModal('${stopId}')">📷 Show QR</button>
        <button class="btn btn-secondary btn-sm" onclick="StopView.getMyLocationETA('${stopId}')">📡 My ETA</button>
      </div>

      <p class="section-title">Serving Routes</p>
      ${scheduleHTML}

      <div class="card">
        <div class="section-title">Live Upcoming Buses</div>
        <div id="stop-live-eta">
          <div class="spinner"></div>
        </div>
      </div>
    `;

        // Load live ETAs for each route
        this.loadLiveETAs(stop, servingRoutes, stops);
    },

    async loadLiveETAs(stop, routes, allStops) {
        const etaEl = document.getElementById("stop-live-eta");
        if (!etaEl) return;

        const etaItems = [];

        for (const route of routes) {
            const routeStops = (route.stops || []).map(sid => allStops[sid]).filter(Boolean);
            const stopIdx = (route.stops || []).indexOf(stop.id);
            const buses = await DataStore.getBusesOnRoute(route.id);

            for (const bus of buses) {
                const remDist = ETA.remainingRoute(bus.lat, bus.lng, routeStops, stopIdx);
                const mins = ETA.etaMins(remDist, bus.speed);
                if (mins >= 0 && mins < 120) {
                    etaItems.push({ bus, route, mins, remDist });
                }
            }
        }

        etaItems.sort((a, b) => a.mins - b.mins);

        if (!etaItems.length) {
            etaEl.innerHTML = `<p class="text-muted">No buses approaching in the next 2 hours.</p>`;
            return;
        }

        etaEl.innerHTML = etaItems.map(({ bus, route, mins, remDist }) => `
      <div class="info-row">
        <div>
          <div style="font-weight:600">Bus ${route.shortName} <span style="font-size:.82rem;color:${route.color}">(${bus.id})</span></div>
          <div class="text-muted" style="font-size:.82rem">${remDist.toFixed(1)} km away</div>
        </div>
        <div>
          <div style="font-weight:700;color:#007BFF;font-size:1.1rem">${ETA.formatETA(mins)}</div>
          <button class="btn btn-secondary btn-sm" style="margin-top:4px" onclick="Router.navigate('#bus=${route.shortName}')">Track</button>
        </div>
      </div>
    `).join("");

        // Start live poll
        this.startETAPoll(stop, routes, allStops);
    },

    startETAPoll(stop, routes, allStops) {
        Router.clearPolls();
        const interval = Network.pollInterval || POLL_FAST;
        State.pollTimer = setInterval(() => {
            this.loadLiveETAs(stop, routes, allStops);
        }, interval);
    },

    getMyLocationETA(stopId) {
        if (!navigator.geolocation) { UI.toast("Geolocation not supported"); return; }
        navigator.geolocation.getCurrentPosition(pos => {
            const { latitude, longitude } = pos.coords;
            const stop = DEMO_DATA.stops[stopId];
            if (!stop) return;
            const dist = ETA.distance(latitude, longitude, stop.lat, stop.lng);
            const walk = (dist / 5) * 60; // 5 km/h walking
            UI.toast(`📍 You are ${dist.toFixed(2)} km away (≈ ${ETA.formatETA(walk)} walk)`);
        }, () => UI.toast("Location permission denied"));
    }
};

/* ================================================================
   BUS VIEW  –  /#bus=BUS_NUM
   ================================================================ */
const BusView = {
    async render(busNum) {
        if (!busNum) { Router.navigate("#home"); return; }
        UI.setTitle(`Bus ${busNum}`);

        const el = document.getElementById("view-bus");
        el.innerHTML = UI.loadingHTML("Loading bus info…");

        const [routes, stops] = await Promise.all([
            DataStore.getRoutes(),
            DataStore.getStops()
        ]);

        const route = await DataStore.getRouteByBusNum(busNum);
        if (!route) {
            el.innerHTML = `
        <div class="card">
          <div style="font-size:2rem;margin-bottom:8px">🔍</div>
          <h2>Bus ${busNum} not found</h2>
          <p class="text-muted" style="margin:8px 0">This bus number doesn't exist in our system. Try one of these:</p>
          ${Object.values(routes).map(r => `<button class="btn btn-outline btn-sm" style="margin:4px" onclick="Router.navigate('#bus=${r.shortName}')">Bus ${r.shortName}</button>`).join("")}
        </div>`;
            return;
        }

        State.selectedRouteId = route.id;
        DataStore.addRecent({ id: busNum, hash: `#bus=${busNum}`, name: `Bus ${busNum}`, subtitle: route.name, type: "bus", icon: "🚌" });

        const routeStops = (route.stops || []).map(sid => stops[sid]).filter(Boolean);
        const buses = await DataStore.getBusesOnRoute(route.id);

        UI.setTitle(`Bus ${busNum} – ${route.name.split("–")[1]?.trim() || ""}`);

        el.innerHTML = `
      <!-- Route header -->
      <div class="card" style="background:linear-gradient(135deg,${route.color || '#007BFF'},${route.color ? route.color + 'CC' : '#0056B3'});color:#fff;margin-bottom:14px">
        <div style="display:flex;align-items:center;gap:12px">
          <div style="font-size:2.5rem">🚌</div>
          <div>
            <h2 style="color:#fff">${route.name}</h2>
            <div style="opacity:.85;font-size:.88rem">${route.days || "Daily"} &nbsp;•&nbsp; ${routeStops.length} stops</div>
          </div>
        </div>
      </div>

      <!-- ETA boxes -->
      <div class="eta-grid" id="eta-boxes">
        <div class="eta-box"><div class="eta-val" id="eta-next">--</div><div class="eta-label">Next Stop</div></div>
        <div class="eta-box"><div class="eta-val" id="eta-dist">--</div><div class="eta-label">Distance</div></div>
        <div class="eta-box eta-user"><div class="eta-val" id="eta-user">--</div><div class="eta-label">To Your Stop</div></div>
        <div class="eta-box"><div class="eta-val" id="eta-speed">--</div><div class="eta-label">Speed km/h</div></div>
      </div>

      <!-- Map -->
      <div id="map-container">
        <div id="map"></div>
        <div class="map-placeholder" id="map-loading">
          <div class="mp-icon">🗺️</div><p>Loading map…</p>
        </div>
      </div>
      <div class="map-legend">
        <div class="legend-item"><div class="legend-dot" style="background:${route.color || '#007BFF'}"></div> Route</div>
        <div class="legend-item"><div class="legend-dot" style="background:#007BFF"></div> Bus</div>
        <div class="legend-item"><div class="legend-dot" style="background:#4285F4"></div> You</div>
        <div class="legend-item"><div class="legend-dot" style="background:#28A745"></div> Stop</div>
      </div>

      <!-- Route progress -->
      <div class="route-progress"><div class="route-progress-fill" id="route-progress-fill" style="width:0%"></div></div>

      <!-- Stops list -->
      <div class="card">
        <div class="section-title">Route Stops</div>
        <div class="stops-timeline" id="stops-list">
          ${routeStops.map((stop, i) => `
            <div class="stop-item" onclick="Router.navigate('#stop=${stop.id}')" id="stop-item-${i}">
              <div class="stop-dot"></div>
              <div class="stop-num">${i + 1}</div>
              <div>
                <div class="stop-name">${stop.name}</div>
                <div class="stop-eta text-muted" id="stop-eta-${i}">Tap to see stop info</div>
              </div>
            </div>
          `).join("")}
        </div>
      </div>

      <!-- Schedule -->
      <div class="card">
        <div class="section-title">Today's Schedule</div>
        <div class="schedule-grid">
          ${(route.schedule || []).map((t, i) => `<div class="sched-time${i === 0 ? " next-time" : ""}">${t}</div>`).join("")}
        </div>
        <button class="btn btn-secondary btn-sm" style="margin-top:12px" onclick="Router.navigate('#download=${busNum}')">⬇️ Download Schedule</button>
      </div>
    `;

        // Initialise map
        const mapLoading = document.getElementById("map-loading");
        MapEngine.init("map").then(map => {
            if (mapLoading) mapLoading.style.display = "none";
            MapEngine.drawRoute(routeStops, route.color || "#007BFF");
            MapEngine.drawStops(routeStops, "#28A745");

            // Start live bus tracking
            this.startLiveTracking(route, routeStops, buses);

            // Try geolocation for user dot
            if (navigator.geolocation) {
                navigator.geolocation.getCurrentPosition(pos => {
                    State.userLatLng = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                    MapEngine.updateUserMarker(pos.coords.latitude, pos.coords.longitude);
                }, () => { });
            }
        });
    },

    startLiveTracking(route, routeStops, buses) {
        MapEngine.clearBusMarkers();

        buses.forEach(bus => {
            DataStore.subscribeBusGPS(bus.id, (data) => {
                this.onBusUpdate(data, route, routeStops);
            });
        });
    },

    onBusUpdate(bus, route, routeStops) {
        // Update marker
        MapEngine.updateBusMarker(
            bus.id, bus.lat, bus.lng, bus.heading || 0,
            route.color || "#007BFF", `${route.shortName}`
        );

        // ETA to next stop
        const nextStopId = bus.nextStop;
        const nextStopIdx = (route.stops || []).indexOf(nextStopId);
        if (nextStopIdx > 0) {
            const nextStop = routeStops[nextStopIdx];
            if (nextStop) {
                const dist = ETA.distance(bus.lat, bus.lng, nextStop.lat, nextStop.lng);
                const mins = ETA.etaMins(dist, bus.speed);
                const etaNext = document.getElementById("eta-next");
                const etaDist = document.getElementById("eta-dist");
                const etaSpeed = document.getElementById("eta-speed");
                if (etaNext) etaNext.textContent = ETA.formatETA(mins);
                if (etaDist) etaDist.textContent = `${dist.toFixed(1)} km`;
                if (etaSpeed) etaSpeed.textContent = `${Math.round(bus.speed || AVG_SPEED_KMH)}`;

                // Highlight current stop in list
                const busStopIdx = Math.max(0, nextStopIdx - 1);
                document.querySelectorAll(".stop-item").forEach((el, i) => {
                    el.classList.toggle("current-stop", i === busStopIdx);
                    el.classList.toggle("passed-stop", i < busStopIdx);
                });

                // Progress bar
                const pct = routeStops.length > 1 ? (busStopIdx / (routeStops.length - 1)) * 100 : 0;
                const fill = document.getElementById("route-progress-fill");
                if (fill) fill.style.width = `${pct}%`;

                // Update per-stop ETAs
                routeStops.forEach((stop, i) => {
                    const cell = document.getElementById(`stop-eta-${i}`);
                    if (!cell) return;
                    if (i <= busStopIdx) {
                        cell.textContent = "Passed";
                        cell.style.color = "#aaa";
                    } else {
                        const d = ETA.remainingRoute(bus.lat, bus.lng, routeStops, i);
                        const m = ETA.etaMins(d, bus.speed);
                        cell.textContent = `ETA: ${ETA.formatETA(m)}`;
                        cell.style.color = "#007BFF";
                    }
                });
            }
        }

        // ETA to user's position
        if (State.userLatLng) {
            const nearestStopDist = routeStops.reduce((best, stop) => {
                const d = ETA.distance(State.userLatLng.lat, State.userLatLng.lng, stop.lat, stop.lng);
                return d < best.d ? { d, stop } : best;
            }, { d: Infinity, stop: null });

            if (nearestStopDist.stop) {
                const nearIdx = (route.stops || []).indexOf(nearestStopDist.stop.id);
                const remDist = ETA.remainingRoute(bus.lat, bus.lng, routeStops, nearIdx);
                const mins = ETA.etaMins(remDist, bus.speed);
                const etaUser = document.getElementById("eta-user");
                if (etaUser) etaUser.textContent = ETA.formatETA(mins);
            }
        }
    }
};

/* ================================================================
   DOWNLOAD VIEW  –  /#download=BUS_NUM
   ================================================================ */
const DownloadView = {
    async render(busNum) {
        UI.setTitle(`Download – Bus ${busNum}`);
        const el = document.getElementById("view-download");

        const route = await DataStore.getRouteByBusNum(busNum);
        if (!route) {
            el.innerHTML = `<div class="card"><p>Bus ${busNum} not found.</p></div>`;
            return;
        }

        const allStops = await DataStore.getStops();
        const routeStops = (route.stops || []).map(sid => allStops[sid]).filter(Boolean);
        const schedule = route.schedule || [];

        const previewRows = routeStops.slice(0, 5).map((stop, i) => `
      <tr>
        <td>${route.shortName}</td>
        <td>${route.name}</td>
        <td>${stop.name}</td>
        <td>${schedule[i] || "—"}</td>
        <td>${(i * 2.5).toFixed(1)} km</td>
        <td>${route.days}</td>
      </tr>
    `).join("");

        el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <div class="card-icon">⬇️</div>
          <div>
            <h3>Download Schedule</h3>
            <div class="text-muted" style="font-size:.85rem">Bus ${busNum} – ${routeStops.length} stops, ${schedule.length} departures</div>
          </div>
        </div>

        <p class="text-muted" style="font-size:.88rem;margin-bottom:14px">
          The CSV file contains the complete route schedule for Bus ${busNum} including all stops and departure times.
        </p>

        <div class="download-preview">
          <table class="dl-table">
            <thead>
              <tr><th>Bus</th><th>Route</th><th>Stop</th><th>Time</th><th>Dist</th><th>Days</th></tr>
            </thead>
            <tbody>${previewRows}</tbody>
          </table>
          <p class="text-muted" style="font-size:.78rem;margin-top:6px">Showing first 5 of ${routeStops.length} stops</p>
        </div>

        <div class="btn-row" style="margin-top:16px">
          <button class="btn btn-primary" onclick="DownloadView.downloadCSV('${busNum}')">
            📥 Download CSV
          </button>
          <button class="btn btn-secondary" onclick="Router.navigate('#bus=${busNum}')">
            🗺️ Track Live
          </button>
        </div>
      </div>

      <div class="card">
        <div class="section-title">QR Code for Stop</div>
        <p class="text-muted" style="font-size:.88rem;margin-bottom:12px">Share this QR for any stop on Route ${busNum}</p>
        <button class="btn btn-outline" onclick="UI.openQrModal('${route.stops?.[0] || 'STOP001'}')">📷 Show Stop QR</button>
      </div>
    `;
    },

    async downloadCSV(busNum) {
        const route = await DataStore.getRouteByBusNum(busNum);
        const allStops = await DataStore.getStops();
        if (!route) { UI.toast("Route not found"); return; }

        const routeStops = (route.stops || []).map(sid => allStops[sid]).filter(Boolean);
        const schedule = route.schedule || [];

        const rows = [
            ["Bus", "Route Name", "Stop ID", "Stop Name", "Latitude", "Longitude", "Departure", "Distance (km)", "Days"],
            ...routeStops.map((stop, i) => [
                route.shortName,
                route.name,
                stop.id,
                stop.name,
                stop.lat,
                stop.lng,
                schedule[i] || "",
                (ETA.distance(
                    routeStops[0].lat, routeStops[0].lng,
                    stop.lat, stop.lng
                )).toFixed(2),
                route.days
            ])
        ];

        const csv = rows.map(r => r.map(v => `"${v}"`).join(",")).join("\n");
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = `bus-${busNum}-schedule.csv`;
        a.click();
        URL.revokeObjectURL(url);
        UI.toast("✅ CSV downloaded!");
    }
};

/* ================================================================
   UI  –  Toast, modal, helpers
   ================================================================ */
const UI = {
    toastTimer: null,

    init() {
        // Bottom nav
        document.querySelectorAll(".nav-item").forEach(btn => {
            btn.addEventListener("click", () => {
                const view = btn.dataset.view;
                if (view === "home") Router.navigate("#home");
            });
        });

        // Back button
        document.getElementById("back-btn")?.addEventListener("click", () => {
            if (history.length > 1) history.back(); else Router.navigate("#home");
        });

        // Close QR modal
        document.getElementById("qr-modal-overlay")?.addEventListener("click", e => {
            if (e.target.id === "qr-modal-overlay") this.closeQrModal();
        });
        document.getElementById("qr-close-btn")?.addEventListener("click", () => this.closeQrModal());

        // Close search results on tap outside
        document.addEventListener("click", e => {
            if (!e.target.closest(".search-container")) {
                const res = document.getElementById("search-results");
                if (res) res.style.display = "none";
            }
        });
    },

    setTitle(title) {
        const el = document.getElementById("page-title");
        if (el) el.textContent = title;
        document.title = `${title} | RideSync`;
    },

    toast(msg, duration = 3000) {
        const el = document.getElementById("toast");
        if (!el) return;
        el.textContent = msg;
        el.classList.add("show");
        clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => el.classList.remove("show"), duration);
    },

    openQrModal(stopId) {
        const stop = DEMO_DATA.stops[stopId] || { name: stopId, id: stopId };
        const url = `${location.origin}${location.pathname}#stop=${stopId}`;
        const el = document.getElementById("qr-modal-overlay");
        if (!el) return;

        document.getElementById("qr-stop-name").textContent = stop.name;
        document.getElementById("qr-url-display").textContent = url;
        document.getElementById("qr-copy-btn").onclick = () => {
            navigator.clipboard?.writeText(url).then(() => this.toast("📋 Link copied!"));
        };

        // Generate QR via a free QR API (lightweight, no JS lib)
        const qrImg = document.getElementById("qr-image");
        if (qrImg) {
            qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url)}`;
            qrImg.style.display = "block";
            document.querySelector(".qr-placeholder-icon").style.display = "none";
        }

        el.style.display = "flex";
        document.body.style.overflow = "hidden";
    },

    closeQrModal() {
        const el = document.getElementById("qr-modal-overlay");
        if (el) { el.style.display = "none"; document.body.style.overflow = ""; }
    },

    loadingHTML(msg = "Loading…") {
        return `<div class="card" style="text-align:center;padding:40px 20px">
      <div class="spinner"></div>
      <p class="text-muted" style="margin-top:8px">${msg}</p>
    </div>`;
    }
};

/* ================================================================
   GEOLOCATION FAB
   ================================================================ */
function requestUserLocation() {
    if (!navigator.geolocation) { UI.toast("Geolocation not supported."); return; }
    navigator.geolocation.getCurrentPosition(pos => {
        State.userLatLng = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        MapEngine.updateUserMarker(pos.coords.latitude, pos.coords.longitude);
        if (State.mapInstance) {
            State.mapInstance.setView([pos.coords.latitude, pos.coords.longitude], 15);
        }
        UI.toast("📍 Location found!");
    }, () => UI.toast("Location permission denied."), { enableHighAccuracy: true });
}

/* ================================================================
   INIT
   ================================================================ */
window.addEventListener("DOMContentLoaded", () => App.init());

// Expose globals needed by inline onclick handlers
window.Router = Router;
window.HomeView = HomeView;
window.StopView = StopView;
window.BusView = BusView;
window.DownloadView = DownloadView;
window.UI = UI;
window.requestUserLocation = requestUserLocation;
