// The replica's store (docs/plans/real-app.md §3, "The local replica"): one transaction per change,
// the 2 s guard, the log's cap.

import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore, StoreError } from "../app/store.js";
import { needsIdb, freshIdb } from "./idb.mjs";

const file = (path, text = `* ${path}\n`) => ({ path, sha: `sha-${path}`, text, work: null, readOnly: null });
let editSeq = 0;
const anEdit = (path, before, after, extra = {}) => ({
  id: `e${++editSeq}`,
  label: "Edited",
  summary: { verb: "Done", text: `Done "${path}"` },
  files: [{ path, before, after }],
  ops: [{ path, op: "setState", key: null, args: { state: "DONE" }, v: 1 }],
  ctx: {},
  ...extra,
});
const workOf = async (store, path) => {
  const f = (await store.allFiles()).find((x) => x.path === path);
  return f.work ?? f.text;
};

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

test("with local commits waiting, a pull may change only the files they don't touch; a reset is refused", needsIdb, async () => {
  const store = openStore({ indexedDB: freshIdb() });
  await store.applyPull({ meta: { base: "c1" }, put: [file("a.org"), file("b.org")] });
  await store.recordEdit(anEdit("a.org", "* a.org\n", "* DONE a.org\n"), { now: 1000 });
  await assert.rejects(store.applyPull({ meta: { base: "c2" }, del: ["a.org"] }), (e) => e.code === "pending-changed");
  await assert.rejects(store.applyPull({ meta: { base: "c2" }, put: [file("a.org", "* theirs\n")] }), (e) => e.code === "pending-changed");
  await assert.rejects(store.resetReplica(), /Local commits are waiting/);
  assert.equal((await store.getMeta()).base, "c1");
  await store.applyPull({ meta: { base: "c2" }, put: [file("b.org", "* new b\n"), file("c.org")] });
  assert.equal((await store.getMeta()).base, "c2");
  const [c] = await store.pending();
  assert.equal(c.base, "c2", "the local commit moves onto the new base");
  const a = (await store.allFiles()).find((f) => f.path === "a.org");
  assert.equal(a.work, "* DONE a.org\n");
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

// ------------------------------------------------------------------------------ local commits

async function withFiles() {
  const store = openStore({ indexedDB: freshIdb() });
  await store.setMeta({ device: "iPad" });
  await store.applyPull({ meta: { base: "c1", tree: "t1" }, put: [file("a.org", "1\n"), file("b.org", "x\n")] });
  return store;
}

test("an edit writes the working text and a local commit together; edits under 3 s apart fold into one", needsIdb, async () => {
  const store = await withFiles();
  await store.recordEdit(anEdit("a.org", "1\n", "2\n"), { now: 10_000 });
  await store.recordEdit(anEdit("b.org", "x\n", "y\n"), { now: 12_000 });
  await store.recordEdit(anEdit("a.org", "2\n", "3\n"), { now: 14_900 });
  let p = await store.pending();
  assert.equal(p.length, 1);
  assert.deepEqual(p[0].files, { "a.org": { before: "1\n", after: "3\n" }, "b.org": { before: "x\n", after: "y\n" } });
  assert.equal(p[0].ops.length, 3);
  assert.equal(p[0].parts.length, 3);
  assert.equal(p[0].base, "c1");
  assert.equal(p[0].message, "Rumbo: Done 3 headings in a, b (iPad)");
  assert.equal(await workOf(store, "a.org"), "3\n");
  // 3 s or more after the last edit: a new commit.
  await store.recordEdit(anEdit("a.org", "3\n", "4\n"), { now: 17_900 });
  p = await store.pending();
  assert.equal(p.length, 2);
  assert.deepEqual(p[1].files, { "a.org": { before: "3\n", after: "4\n" } });
  assert.equal(p[1].message, 'Rumbo: Done "a.org" (iPad)');
  assert.ok(p[1].id > p[0].id);
});

test("an edit made on text that isn't the file's working text is refused, and nothing is written", needsIdb, async () => {
  const store = await withFiles();
  await assert.rejects(store.recordEdit(anEdit("a.org", "old\n", "2\n")), (e) => e instanceof StoreError && e.code === "stale");
  await assert.rejects(store.recordEdit({ ...anEdit("a.org", "1\n", "2\n"), files: [{ path: "a.org", before: "1\n", after: "2\n" }, { path: "zz.org", before: "", after: "q" }] }), (e) => e.code === "stale");
  assert.deepEqual(await store.pending(), []);
  assert.equal(await workOf(store, "a.org"), "1\n");
});

test("a sealed commit takes no more edits", needsIdb, async () => {
  const store = await withFiles();
  const { id } = await store.recordEdit(anEdit("a.org", "1\n", "2\n"), { now: 1000 });
  const sealed = await store.seal(id);
  assert.equal(sealed.sealed, true);
  await store.recordEdit(anEdit("a.org", "2\n", "3\n"), { now: 1500 });
  const p = await store.pending();
  assert.equal(p.length, 2);
  assert.deepEqual(p[0].files["a.org"], { before: "1\n", after: "2\n" });
});

test("undo takes the last edit off an unsealed commit, and drops a commit left empty", needsIdb, async () => {
  const store = await withFiles();
  const e1 = anEdit("a.org", "1\n", "2\n");
  const e2 = anEdit("a.org", "2\n", "3\n");
  await store.recordEdit(e1, { now: 1000 });
  await store.recordEdit(e2, { now: 1500 });
  await store.undoEdit({ id: e2.id, files: e2.files }, { now: 1600 });
  let [c] = await store.pending();
  assert.deepEqual(c.files["a.org"], { before: "1\n", after: "2\n" });
  assert.equal(c.ops.length, 1);
  assert.equal(await workOf(store, "a.org"), "2\n");
  await store.undoEdit({ id: e1.id, files: e1.files }, { now: 1700 });
  assert.deepEqual(await store.pending(), []);
  const a = (await store.allFiles()).find((f) => f.path === "a.org");
  assert.equal(a.work, null);
});

test("undo of an edit in a sealed commit is a new commit with the old text", needsIdb, async () => {
  const store = await withFiles();
  const e1 = anEdit("a.org", "1\n", "2\n");
  const { id } = await store.recordEdit(e1, { now: 1000 });
  await store.seal(id);
  await store.undoEdit({ id: e1.id, label: "Undone", summary: { verb: "Undo", text: 'Undo: Done "a"' }, files: e1.files }, { now: 1100 });
  const p = await store.pending();
  assert.equal(p.length, 2);
  assert.deepEqual(p[1].files["a.org"], { before: "2\n", after: "1\n" });
  assert.deepEqual(p[1].ops, []);
  assert.equal(p[1].parts[0].opaque, true);
  assert.equal(p[1].message, 'Rumbo: Undo: Done "a" (iPad)');
  assert.equal(await workOf(store, "a.org"), "1\n");
});

test("edits that cancel out leave no commit", needsIdb, async () => {
  const store = await withFiles();
  await store.recordEdit(anEdit("a.org", "1\n", "2\n"), { now: 1000 });
  await store.recordEdit(anEdit("a.org", "2\n", "1\n"), { now: 1500 });
  assert.deepEqual(await store.pending(), []);
});

test("a pushed commit leaves pending, its text becomes the base, and the base moves", needsIdb, async () => {
  const store = await withFiles();
  const { id } = await store.recordEdit(anEdit("a.org", "1\n", "2\n"), { now: 1000 });
  await store.recordEdit(anEdit("b.org", "x\n", "y\n"), { now: 9000 });
  await store.noteAttempt(id, { sha: "c2", tree: "t2" });
  assert.deepEqual((await store.pending())[0].attempt, { sha: "c2", tree: "t2" });
  await store.setMeta({ etag: "e1" });
  await store.markPushed(id, { sha: "c2", tree: "t2", blobs: { "a.org": "blob2" } });
  const meta = await store.getMeta();
  assert.equal(meta.base, "c2");
  assert.equal(meta.tree, "t2");
  assert.equal(meta.etag, undefined);
  const a = (await store.allFiles()).find((f) => f.path === "a.org");
  assert.deepEqual([a.text, a.sha, a.work], ["2\n", "blob2", null]);
  const p = await store.pending();
  assert.equal(p.length, 1);
  assert.equal(p[0].base, "c2");
  assert.equal((await store.readLog()).at(-1).kind, "push");
  await assert.rejects(store.markPushed(id, { sha: "c2", tree: "t2" }), (e) => e.code === "gone");
});

// ------------------------------------------------------------------------------ rebase and the ways out

test("a pull with rebased commits replaces them and the working text in one transaction", needsIdb, async () => {
  const store = await withFiles();
  await store.recordEdit(anEdit("a.org", "1\n", "1\nmine\n"), { now: 1000 });
  const [c] = await store.pending();
  const rebased = { ...c, files: { "a.org": { before: "0\n1\n", after: "0\n1\nmine\n" } }, attempt: null };
  await store.setMeta({ conflict: { head: "x", files: [] } });
  await store.applyPull({
    meta: { base: "c2", tree: "t2" },
    put: [file("a.org", "0\n1\n")],
    rebased: { expect: [{ id: c.id, updated: c.updated }], commits: [rebased] },
  });
  const [p] = await store.pending();
  assert.equal(p.base, "c2");
  assert.deepEqual(p.files, rebased.files);
  const a = (await store.allFiles()).find((f) => f.path === "a.org");
  assert.equal(a.text, "0\n1\n");
  assert.equal(a.work, "0\n1\nmine\n");
  assert.equal((await store.getMeta()).conflict, undefined);
});

test("a rebased pull is refused if a local commit changed meanwhile (an edit during the pull)", needsIdb, async () => {
  const store = await withFiles();
  await store.recordEdit(anEdit("a.org", "1\n", "2\n"), { now: 1000 });
  const [c] = await store.pending();
  await store.recordEdit(anEdit("a.org", "2\n", "3\n"), { now: 2000 });
  await assert.rejects(
    store.applyPull({ meta: { base: "c2" }, put: [file("a.org", "0\n")], rebased: { expect: [{ id: c.id, updated: c.updated }], commits: [c] } }),
    (e) => e.code === "pending-changed",
  );
  assert.equal((await store.getMeta()).base, "c1");
  assert.equal(await workOf(store, "a.org"), "3\n");
});

test("a rebased pull that drops a commit (GitHub made the same change) leaves the file as GitHub's", needsIdb, async () => {
  const store = await withFiles();
  await store.recordEdit(anEdit("a.org", "1\n", "2\n"), { now: 1000 });
  const [c] = await store.pending();
  await store.applyPull({ meta: { base: "c2" }, put: [file("a.org", "2\n")], rebased: { expect: [{ id: c.id, updated: c.updated }], commits: [] } });
  assert.deepEqual(await store.pending(), []);
  const a = (await store.allFiles()).find((f) => f.path === "a.org");
  assert.deepEqual([a.text, a.work], ["2\n", null]);
});

test("resolveConflict: github drops the file's changes; mine adds a commit that writes this device's text", needsIdb, async () => {
  const store = await withFiles();
  await store.recordEdit(anEdit("a.org", "1\n", "2\n"), { now: 1000 });
  await store.recordEdit(anEdit("b.org", "x\n", "y\n"), { now: 9000 });
  await store.setMeta({ conflict: { head: "h", files: [{ path: "a.org", theirs: "T\n" }, { path: "b.org", theirs: "U\n" }] } });
  const [, cb] = await store.pending();
  await store.resolveConflict({ path: "a.org", how: "github", commits: [cb] });
  assert.deepEqual((await store.pending()).map((c) => Object.keys(c.files)), [["b.org"]]);
  assert.equal(await workOf(store, "a.org"), "1\n");
  assert.deepEqual((await store.getMeta()).conflict.files.map((f) => f.path), ["b.org"]);

  await store.resolveConflict({ path: "b.org", how: "mine", commits: [], theirs: "U\n", mine: "y\n", message: "Rumbo: Keep this device's b (iPad)", now: 10_000 });
  const [k] = await store.pending();
  assert.deepEqual(k.files, { "b.org": { before: "U\n", after: "y\n" } });
  assert.equal(k.sealed, true, "a resolution takes no more edits");
  assert.equal(k.message, "Rumbo: Keep this device's b (iPad)");
  assert.equal(await workOf(store, "b.org"), "y\n");
  assert.equal((await store.getMeta()).conflict, undefined);
  assert.deepEqual((await store.readLog()).filter((e) => e.kind === "resolve").map((e) => e.how), ["github", "mine"]);
});

test("a forced reset forgets the local commits too", needsIdb, async () => {
  const store = await withFiles();
  await store.recordEdit(anEdit("a.org", "1\n", "2\n"), { now: 1000 });
  await store.resetReplica({ force: true });
  assert.deepEqual(await store.pending(), []);
  assert.deepEqual(await store.allFiles(), []);
  assert.equal((await store.readLog()).at(-1).dropped, 1);
});
