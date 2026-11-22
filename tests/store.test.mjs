// The replica's store (docs/plans/real-app.md §3, "The local replica"): one transaction per change,
// the 2 s guard, the log's cap.

import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore, StoreError } from "../app/store.js";
import { needsIdb, freshIdb } from "./idb.mjs";

const file = (path, text = `* ${path}\n`) => ({ path, sha: `sha-${path}`, text, work: null, readOnly: null });

test("meta keys are set, read back, and removed with undefined", needsIdb, async () => {
  const store = openStore({ indexedDB: freshIdb() });
  assert.deepEqual(await store.getMeta(), {});
  await store.setMeta({ repo: "me/vault", branch: "main", base: "abc" });
  await store.setMeta({ base: undefined, lastCheck: 5 });
  assert.deepEqual(await store.getMeta(), { repo: "me/vault", branch: "main", lastCheck: 5 });
});

test("a pull writes meta, files, deletions and its log entry in one transaction", needsIdb, async () => {
  const store = openStore({ indexedDB: freshIdb() });
  await store.applyPull({ meta: { base: "c1" }, put: [file("a.org"), file("b.org")] });
  await store.applyPull({ meta: { base: "c2" }, put: [file("c.org")], del: ["a.org"], log: { kind: "pull", to: "c2" } });
  assert.deepEqual((await store.allFiles()).map((f) => f.path), ["b.org", "c.org"]);
  assert.equal((await store.getMeta()).base, "c2");
  const log = await store.readLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].to, "c2");
});

test("a pull that fails part-way leaves the old state whole", needsIdb, async () => {
  const store = openStore({ indexedDB: freshIdb() });
  await store.applyPull({ meta: { base: "c1" }, put: [file("a.org")] });
  // The second record has no key path: the put throws, and the whole transaction is rolled back.
  await assert.rejects(store.applyPull({ meta: { base: "c2" }, put: [file("b.org"), { text: "no path" }], del: ["a.org"] }));
  assert.deepEqual((await store.allFiles()).map((f) => f.path), ["a.org"]);
  assert.equal((await store.getMeta()).base, "c1");
});

test("a pull and a reset are refused while local commits are pending", needsIdb, async () => {
  const idb = freshIdb();
  const store = openStore({ indexedDB: idb });
  await store.applyPull({ meta: { base: "c1" }, put: [file("a.org")] });
  // Plan step 4 writes pending commits; here one is put in directly.
  await new Promise((resolve, reject) => {
    const req = idb.open("rumbo");
    req.onsuccess = () => {
      const tx = req.result.transaction("pending", "readwrite");
      tx.objectStore("pending").put({ id: "x1", ops: [] });
      tx.oncomplete = () => (req.result.close(), resolve());
      tx.onerror = () => reject(tx.error);
    };
  });
  store.close();
  await assert.rejects(store.applyPull({ meta: { base: "c2" }, del: ["a.org"] }), /Local commits are waiting/);
  await assert.rejects(store.resetReplica(), /Local commits are waiting/);
  assert.equal((await store.getMeta()).base, "c1");
  assert.equal((await store.allFiles()).length, 1);
});

test("a reset forgets the files and the base, and keeps Setup and settings", needsIdb, async () => {
  const store = openStore({ indexedDB: freshIdb() });
  await store.setMeta({ repo: "me/vault", token: "t", device: "iPad" });
  await store.setSetting("prefs", { theme: "dusk" });
  await store.applyPull({ meta: { base: "c1", etag: "e", tree: "t1" }, put: [file("a.org")] });
  await store.resetReplica();
  assert.deepEqual(await store.getMeta(), { repo: "me/vault", token: "t", device: "iPad" });
  assert.deepEqual(await store.allFiles(), []);
  assert.deepEqual(await store.getSetting("prefs"), { theme: "dusk" });
});

test("the log keeps the last 100 events", needsIdb, async () => {
  const store = openStore({ indexedDB: freshIdb() });
  for (let i = 0; i < 105; i++) await store.log({ kind: "pull", n: i });
  const log = await store.readLog();
  assert.equal(log.length, 100);
  assert.equal(log[0].n, 5);
  assert.equal(log.at(-1).n, 104);
});

test("a request that never answers times out, and the next call opens the database again", needsIdb, async () => {
  const real = freshIdb();
  let hang = true;
  let opens = 0;
  const factory = {
    open: (...args) => {
      opens += 1;
      // A request whose handlers never fire, as WebKit leaves one after a long time in the background.
      return hang ? {} : real.open(...args);
    },
  };
  const store = openStore({ indexedDB: factory, timeoutMs: 50 });
  const t0 = Date.now();
  await assert.rejects(store.getMeta(), (e) => e instanceof StoreError && /did not answer/.test(e.message));
  assert.ok(Date.now() - t0 < 1000);
  hang = false;
  await store.setMeta({ repo: "me/vault" });
  assert.equal((await store.getMeta()).repo, "me/vault");
  assert.equal(opens, 2);
});
