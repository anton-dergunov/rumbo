// The built service worker, run against a fake worker scope: install, activate, fetch, update.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "../tools/build.mjs";

const SCOPE = "https://me.github.io/rumbo/";

function loadWorker({ existingCaches = [] } = {}) {
  const out = mkdtempSync(join(tmpdir(), "rumbo-sw-"));
  const b = build({ out });
  const code = readFileSync(join(out, "sw.js"), "utf8");

  const store = new Map(existingCaches.map((name) => [name, new Map()])); // name → Map(url → Response)
  const network = [];
  const listeners = {};
  let skipped = 0;
  const self = {
    registration: { scope: SCOPE },
    location: { origin: new URL(SCOPE).origin },
    addEventListener: (type, fn) => (listeners[type] = fn),
    skipWaiting: () => skipped++,
  };
  const keyOf = (req) => (typeof req === "string" ? req : req.url);
  const caches = {
    open: async (name) => {
      if (!store.has(name)) store.set(name, new Map());
      const c = store.get(name);
      return {
        addAll: async (reqs) => {
          for (const r of reqs) {
            assert.equal(r.cache, "reload", "precache must bypass the HTTP cache");
            c.set(r.url, new Response(`body of ${r.url}`));
          }
        },
        match: async (req, opts = {}) => {
          let key = keyOf(req);
          if (opts.ignoreSearch) key = key.split("?")[0];
          return c.get(key)?.clone();
        },
      };
    },
    keys: async () => [...store.keys()],
    delete: async (name) => store.delete(name),
  };
  const fetch = async (req) => (network.push(keyOf(req)), new Response("from network"));
  new Function("self", "caches", "fetch", code)(self, caches, fetch);

  const fire = async (type, extra = {}) => {
    let waited = null;
    let responded = null;
    const event = { ...extra, waitUntil: (p) => (waited = p), respondWith: (p) => (responded = p) };
    listeners[type](event);
    await waited;
    return responded ? await responded : null;
  };
  const get = (url, mode = "no-cors") => fire("fetch", { request: { url, method: "GET", mode } });
  return { b, store, network, fire, get, skipped: () => skipped };
}

test("install precaches the whole shell, resolved against the scope", async () => {
  const w = loadWorker();
  await w.fire("install");
  const cached = [...w.store.get(w.b.cache).keys()].sort();
  assert.deepEqual(cached, w.b.precache.map((p) => new URL(p, SCOPE).href).sort());
  assert.ok(cached.includes(SCOPE));
});

test("activate removes old Rumbo caches and leaves others alone", async () => {
  const w = loadWorker({ existingCaches: ["rumbo-0.0.1-aaaaaaaaaa", "something-else"] });
  await w.fire("install");
  await w.fire("activate");
  assert.deepEqual([...w.store.keys()].sort(), [w.b.cache, "something-else"].sort());
});

test("the shell is served from the cache, pages by their directory URL", async () => {
  const w = loadWorker();
  await w.fire("install");
  assert.equal(await (await w.get(`${SCOPE}app.js`)).text(), `body of ${SCOPE}app.js`);
  for (const url of [SCOPE, `${SCOPE}index.html`, `${SCOPE}?view=agenda`]) {
    assert.equal(await (await w.get(url, "navigate")).text(), `body of ${SCOPE}`, url);
  }
  assert.deepEqual(w.network, []);
});

test("a file missing from the cache comes from the network", async () => {
  const w = loadWorker();
  await w.fire("install");
  assert.equal(await (await w.get(`${SCOPE}not-there.js`)).text(), "from network");
  assert.deepEqual(w.network, [`${SCOPE}not-there.js`]);
});

test("the GitHub API, other paths on the host, and non-GET requests are not intercepted", async () => {
  const w = loadWorker();
  await w.fire("install");
  assert.equal(await w.get("https://api.github.com/repos/me/notes/git/ref/heads/main"), null);
  assert.equal(await w.get("https://me.github.io/other-project/"), null);
  assert.equal(await w.fire("fetch", { request: { url: `${SCOPE}app.js`, method: "POST", mode: "cors" } }), null);
});

test("a new version waits until the page asks for it", async () => {
  const w = loadWorker();
  await w.fire("install");
  await w.fire("message", { data: { type: "something-else" } });
  assert.equal(w.skipped(), 0);
  await w.fire("message", { data: { type: "apply-update" } });
  assert.equal(w.skipped(), 1);
});
