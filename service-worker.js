const CACHE_NAME = "external-activities-fund-shell-v1";
const APP_SHELL = [
    "./index.html",
    "./style.css?v=20261120-soft-shapes",
    "./supabase-config.js",
    "./script.js?v=20261120-pwa",
    "./assets/baahira-logo.png",
    "./assets/dp-creations-logo.png",
    "./assets/app-icon-192.png",
    "./assets/app-icon-512.png",
    "./assets/apple-touch-icon.png"
];
const STATIC_PATHS = new Set(
    APP_SHELL
        .filter(path => path !== "./index.html")
        .map(path => new URL(path, self.registration.scope).pathname)
);

self.addEventListener("install", event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
    );
});

self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(
            keys
                .filter(key => key.startsWith("external-activities-fund-shell-") &&
                    key !== CACHE_NAME)
                .map(key => caches.delete(key))
        )).then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", event => {
    const request = event.request;
    const requestUrl = new URL(request.url);
    if (request.method !== "GET" || requestUrl.origin !== self.location.origin) {
        return;
    }

    if (request.mode === "navigate") {
        event.respondWith(
            fetch(request).catch(async () =>
                (await caches.match("./index.html")) || Response.error()
            )
        );
        return;
    }

    if (STATIC_PATHS.has(requestUrl.pathname)) {
        event.respondWith(
            caches.match(request).then(cached => cached || fetch(request))
        );
    }
});
