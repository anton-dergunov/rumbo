// Rumbo's service worker (docs/plans/real-app.md §2, "Updates").
// - The whole shell is precached under a cache named by a hash of its files.
// - The shell is served cache-first; other origins (api.github.com) are never touched or cached.
// - A new version waits. It takes over only when the page posts "apply-update", which the page
//   sends when the owner taps "Update Rumbo". No automatic skipWaiting() or clients.claim():
//   a worker that activates on its own reloads the page under whoever is typing.
// tools/build.mjs replaces the two lines marked BUILD; unbuilt, the worker caches nothing.

const CACHE = "rumbo-dev"; // BUILD:CACHE
const PRECACHE = []; // BUILD:PRECACHE

const scope = () => self.registration.scope;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // `reload` skips the HTTP cache, so a new version never precaches an old file.
      await cache.addAll(PRECACHE.map((path) => new Request(new URL(path, scope()), { cache: "reload" })));
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith("rumbo-") && key !== CACHE) await caches.delete(key);
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "apply-update") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(scope())) return;
  event.respondWith(fromShell(request, url));
});

/** Pages are precached under their directory URLs, so `…/index.html` and `…/?x` find `…/`. */
async function fromShell(request, url) {
  const cache = await caches.open(CACHE);
  let key = request;
  if (request.mode === "navigate") {
    const dir = new URL(url.pathname.replace(/index\.html$/, ""), url.origin);
    key = dir.href;
  }
  const hit = await cache.match(key, { ignoreSearch: request.mode === "navigate" });
  return hit || fetch(request);
}
