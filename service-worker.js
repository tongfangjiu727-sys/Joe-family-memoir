const CACHE_PREFIX = "family-memoir-shell-";
const CACHE_NAME = `${CACHE_PREFIX}v1`;
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./questions.json",
  "./audio/available.json",
  "./manifest.webmanifest",
  "./icon.svg",
  "./audio/preview/intro-male.mp3",
  "./audio/preview/intro-female.mp3"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(SHELL.map((path) => new Request(new URL(path, self.registration.scope), { cache: "reload" })));
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data?.type === "CACHE_ASSETS" && Array.isArray(event.data.urls)) {
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.all(event.data.urls.map(async (path) => {
        try {
          const url = new URL(path, self.registration.scope);
          const response = await fetch(url.href, { cache: "reload" });
          if (response.ok) await cache.put(url.href, response);
        } catch {
          // Missing audio is allowed while the question bank is being prepared.
        }
      }));
    })());
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;

  const url = new URL(request.url);
  const isQuestionBank = url.pathname.endsWith("/questions.json");
  const isAudioManifest = url.pathname.endsWith("/audio/available.json");
  const isAudio = url.pathname.includes("/audio/");

  if (isQuestionBank || isAudioManifest) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const fresh = await fetch(request, { cache: "no-cache" });
        if (fresh.ok) await cache.put(request, fresh.clone());
        return fresh;
      } catch {
        return (await cache.match(request)) || Response.error();
      }
    })());
    return;
  }

  if (isAudio && request.headers.has("Range")) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(new Request(url.href));
      if (cached) return rangeResponse(request, cached);
      return fetch(request);
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok && (isAudio || request.mode === "navigate")) await cache.put(request, response.clone());
      return response;
    } catch {
      return (await cache.match("./index.html")) || Response.error();
    }
  })());
});

async function rangeResponse(request, cached) {
  const range = request.headers.get("Range");
  const match = /^bytes=(\d*)-(\d*)$/.exec(range || "");
  if (!match) return cached;
  const bytes = await cached.arrayBuffer();
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), bytes.byteLength - 1) : bytes.byteLength - 1;
  if (start > end || start >= bytes.byteLength) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${bytes.byteLength}` } });
  return new Response(bytes.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": cached.headers.get("Content-Type") || "audio/mpeg",
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${bytes.byteLength}`,
      "Accept-Ranges": "bytes"
    }
  });
}
