// The pull and the sync engine (docs/plans/real-app.md §3), against the fake GitHub and a store on
// fake-indexeddb.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeGitHub } from "./fake-github.mjs";
import { createRemote } from "../app/remote-github.js";
import { openStore } from "../app/store.js";
import { pull, createEngine, BACKOFF, SyncError } from "../app/sync.js";
import { RemoteError } from "../app/remote-github.js";
import { needsIdb, freshIdb } from "./idb.mjs";

function setup(files = { "Inbox.org": "* TODO Call\n", "Work/Plan.org": "* NEXT Write\n", "workspace.org": "#+TITLE: ws\n" }) {
  const gh = createFakeGitHub();
  gh.push(files, "First");
  const remote = createRemote({ owner: gh.owner, repo: gh.repo, token: "t", fetch: gh.fetch });
  const store = openStore({ indexedDB: freshIdb() });
  return { gh, remote, store };
}
const paths = async (store) => (await store.allFiles()).map((f) => f.path).sort();
const textOf = async (store, path) => (await store.allFiles()).find((f) => f.path === path)?.text;

test("a first clone takes the wanted files, and skips the rest", needsIdb, async () => {
  const { gh, remote, store } = setup();
  gh.push({ "Journal/2026.org": "* day\n", "init.org": "beorg\n", ".ps/task-icons.json": '{"map":{}}', "notes.txt": "x" });
  const r = await pull({ remote, store });
  assert.equal(r.changed, true);
  assert.deepEqual(await paths(store), [".ps/task-icons.json", "Inbox.org", "Work/Plan.org", "workspace.org"]);
  const meta = await store.getMeta();
  assert.equal(meta.base, gh.head());
  assert.equal(meta.baseCommit.message, "Auto backup");
  assert.ok(meta.etag);
  assert.deepEqual((await store.readLog()).map((e) => e.kind), ["pull"]);
});

test("an unchanged head is a 304: no tree or blob requests", needsIdb, async () => {
  const { gh, remote, store } = setup();
  await pull({ remote, store });
  const before = gh.calls.length;
  const left = gh.rateLimit();
  const r = await pull({ remote, store });
  assert.equal(r.changed, false);
  assert.deepEqual(gh.calls.slice(before).map((c) => c.split(" ")[1].split("/").slice(4, 6).join("/")), ["git/ref"]);
  assert.equal(gh.rateLimit(), left, "a 304 costs nothing");
  assert.ok((await store.getMeta()).lastCheck);
});

test("a new head fetches only the blobs that changed; deletes and adds follow", needsIdb, async () => {
  const { gh, remote, store } = setup();
  await pull({ remote, store });
  gh.push({ "Inbox.org": "* TODO Call\n* TODO Write\n", "Work/Plan.org": null, "Home.org": "* MAYB Paint\n" });
  const before = gh.calls.length;
  const r = await pull({ remote, store });
  const blobCalls = gh.calls.slice(before).filter((c) => c.includes("/git/blobs/"));
  assert.equal(blobCalls.length, 2);
  assert.deepEqual(r.paths.sort(), ["Home.org", "Inbox.org", "Work/Plan.org"]);
  assert.deepEqual(await paths(store), ["Home.org", "Inbox.org", "workspace.org"]);
  assert.equal(await textOf(store, "Inbox.org"), "* TODO Call\n* TODO Write\n");
});

test("a force-pushed branch stops with diverged and changes nothing", needsIdb, async () => {
  const { gh, remote, store } = setup();
  await pull({ remote, store });
  const base = (await store.getMeta()).base;
  gh.forcePush({ "Other.org": "* new history\n" });
  await assert.rejects(pull({ remote, store }), (e) => e instanceof SyncError && e.kind === "diverged");
  assert.equal((await store.getMeta()).base, base);
  assert.deepEqual(await paths(store), ["Inbox.org", "Work/Plan.org", "workspace.org"]);
});

test("a head behind the base is diverged too", needsIdb, async () => {
  const { gh, remote, store } = setup();
  const first = gh.head();
  gh.push({ "Inbox.org": "* later\n" });
  await pull({ remote, store });
  // The branch was reset to an older commit: the head answers with the first commit again.
  const fetchBack = async (url, init) =>
    String(url).includes("/git/ref/heads/") ? new Response(JSON.stringify({ object: { sha: first } }), { status: 200, headers: { etag: '"back"' } }) : gh.fetch(url, init);
  const back = createRemote({ owner: gh.owner, repo: gh.repo, token: "t", fetch: fetchBack });
  await assert.rejects(pull({ remote: back, store }), (e) => e.kind === "diverged" && /behind/.test(e.detail));
  assert.equal(await textOf(store, "Inbox.org"), "* later\n");
});

test("a file that is not UTF-8, or has CR line endings, is kept read-only", needsIdb, async () => {
  const { gh, remote, store } = setup();
  gh.push({ "Win.org": "* TODO a\r\n", "Latin1.org": new Uint8Array([0x2a, 0x20, 0xe9, 0x0a]) });
  await pull({ remote, store });
  const files = Object.fromEntries((await store.allFiles()).map((f) => [f.path, f]));
  assert.equal(files["Win.org"].readOnly, "cr");
  assert.equal(files["Latin1.org"].readOnly, "not-utf8");
  assert.equal(files["Inbox.org"].readOnly, null);
});

test("a failure part-way through a pull writes nothing", needsIdb, async () => {
  const { gh, remote, store } = setup();
  gh.fail({ match: (p) => p.includes("/git/blobs/"), status: 502 });
  await assert.rejects(pull({ remote, store }), (e) => e.kind === "server");
  assert.deepEqual(await store.getMeta(), {});
  assert.deepEqual(await store.allFiles(), []);
  await pull({ remote, store });
  assert.equal((await store.allFiles()).length, 3);
});

// ------------------------------------------------------------------------------- the engine

function fakeTimers() {
  let now = 1_000_000;
  const timers = [];
  return {
    now: () => now,
    setTimer: (fn, ms) => (timers.push({ fn, at: now + ms }), timers.length),
    clearTimer: (id) => id && (timers[id - 1] = null),
    pending: () => timers.filter(Boolean).map((t) => t.at - now),
    async advance(ms) {
      now += ms;
      for (let i = 0; i < timers.length; i++) {
        const t = timers[i];
        if (t && t.at <= now) {
          timers[i] = null;
          t.fn();
        }
      }
      await new Promise((r) => setImmediate(r));
    },
  };
}

test("offline and server failures back off 5 s, 15 s, 60 s, then every minute", async () => {
  const clock = fakeTimers();
  let runs = 0;
  const engine = createEngine({ run: async () => (runs++, Promise.reject(new RemoteError("offline", "no network"))), ...clock });
  await engine.sync("manual");
  assert.equal(engine.status().status, "offline");
  const waits = [clock.pending()[0]];
  for (let i = 0; i < 4; i++) {
    await clock.advance(waits.at(-1));
    await engine.idle();
    waits.push(clock.pending().filter((x) => x > 0)[0]);
  }
  assert.deepEqual(waits, [5000, 15000, 60000, 60000, 60000]);
  assert.equal(runs, 5);
  assert.deepEqual(BACKOFF, [5, 15, 60]);
});

test("a success clears the backoff and the error", async () => {
  const clock = fakeTimers();
  let fail = true;
  const engine = createEngine({ run: async () => (fail ? Promise.reject(new RemoteError("server", "500")) : { changed: false }), ...clock });
  await engine.sync("manual");
  assert.equal(engine.status().lastError.kind, "server");
  fail = false;
  await clock.advance(5000);
  await engine.idle();
  assert.equal(engine.status().status, "synced");
  assert.equal(engine.status().lastError, null);
  assert.equal(engine.status().failures, 0);
});

test("auth, missing and diverged stop until the owner acts; other triggers are skipped", async () => {
  for (const err of [new RemoteError("auth", "401"), new RemoteError("missing", "404"), new SyncError("diverged", "rewritten")]) {
    const clock = fakeTimers();
    let runs = 0;
    const engine = createEngine({ run: async () => (runs++, Promise.reject(err)), ...clock });
    await engine.sync("manual");
    assert.equal(engine.status().status, "attention");
    assert.equal(engine.status().stoppedBy, err.kind);
    assert.deepEqual(clock.pending(), []);
    await engine.sync("tick");
    await engine.sync("visible");
    assert.equal(runs, 1);
    await engine.sync("manual");
    assert.equal(runs, 2);
  }
});

test("a rate limit waits until it resets", async () => {
  const clock = fakeTimers();
  let runs = 0;
  const engine = createEngine({ run: async () => (runs++, Promise.reject(new RemoteError("rate-limited", "limit", { retryAt: clock.now() + 600_000 }))), ...clock });
  await engine.sync("manual");
  assert.equal(engine.status().status, "waiting");
  assert.deepEqual(clock.pending(), [600_000]);
  await engine.sync("tick");
  assert.equal(runs, 1);
});

test("a trigger during a sync gives exactly one more pass", async () => {
  let runs = 0;
  let release;
  const engine = createEngine({ run: () => (runs++, new Promise((r) => (release = r))) });
  const first = engine.sync("manual");
  engine.sync("focus");
  engine.sync("visible");
  engine.sync("tick");
  release({ changed: false });
  await new Promise((r) => setImmediate(r));
  assert.equal(runs, 2);
  release({ changed: false });
  await first;
  await engine.idle();
  assert.equal(runs, 2);
});

test("onLine false skips an automatic sync and shows offline; true proves nothing", async () => {
  let runs = 0;
  let online = false;
  const engine = createEngine({ run: async () => (runs++, { changed: false }), online: () => online });
  await engine.sync("tick");
  assert.equal(runs, 0);
  assert.equal(engine.status().status, "offline");
  await engine.sync("manual");
  assert.equal(runs, 1);
  online = true;
  await engine.sync("tick");
  assert.equal(runs, 2);
});
