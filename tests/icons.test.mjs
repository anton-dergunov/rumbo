// Guessed task icons: the model's files on the device (app/icon-files.js) and when guesses are
// asked for, kept and dropped (app/icons.js), on fakes of fetch, Cache Storage, the store and the
// model.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadModelFiles, isCached, removeModel, readFileList, CACHE_PREFIX } from "../app/icon-files.js";
import { createIcons, missingTasks } from "../app/icons.js";
import { buildModel } from "../app/data.js";
import { iconKey } from "../app/icon-keys.js";

const base = new URL("https://example.org/rumbo/icon-model/");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const bytes = (s) => new TextEncoder().encode(s);

/** A site holding a model's files, and a Cache Storage, both in memory. Counts the fetches. */
function fakeSite({ id = "abc" } = {}) {
  const model = bytes("0123456789abcdefghij");
  const parts = [model.subarray(0, 8), model.subarray(8, 16), model.subarray(16)];
  const files = {
    tokenizer: ["tokenizer.json", bytes('{"t":1}')],
    manifest: ["manifest.json", bytes('{"tag":"F1-small"}')],
    names: ["names.txt", bytes("a b")],
    dense: ["dense.npy", bytes("D")],
    prior: ["prior.npy", bytes("P")],
    wasm: ["../vendor/ort/ort-wasm-simd-threaded.wasm", bytes("W")],
  };
  const site = new Map();
  const list = {
    id,
    tag: "F1-small",
    model: { size: model.length, sha256: sha(model), parts: parts.map((p, i) => ({ path: `model.onnx.part${i}`, size: p.length, sha256: sha(p) })) },
    files: Object.fromEntries(Object.entries(files).map(([k, [path, b]]) => [k, { path, size: b.length, sha256: sha(b) }])),
  };
  parts.forEach((p, i) => site.set(new URL(`model.onnx.part${i}`, base).href, p));
  for (const [path, b] of Object.values(files)) site.set(new URL(path, base).href, b);
  site.set(new URL("files.json", base).href, bytes(JSON.stringify(list)));
  const fetched = [];
  let offline = false;
  const fetchFn = async (url) => {
    if (offline) throw new TypeError("Load failed");
    const href = String(url);
    fetched.push(href.replace(base.href, ""));
    const b = site.get(href);
    return b ? new Response(b) : new Response("", { status: 404 });
  };
  const stores = new Map();
  const cachesApi = {
    open: async (name) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name);
      return { match: async (u) => (m.has(String(u)) ? new Response(m.get(String(u))) : undefined), put: async (u, r) => void m.set(String(u), new Uint8Array(await r.arrayBuffer())) };
    },
    has: async (name) => stores.has(name),
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
  };
  return { model, list, site, fetchFn, cachesApi, stores, fetched, setOffline: (v) => (offline = v) };
}

const sha256 = async (b) => sha(b);

test("the model's files are fetched once, checked, joined, and then read from the cache offline", async () => {
  const s = fakeSite();
  const first = await loadModelFiles({ base, fetch: s.fetchFn, caches: s.cachesApi, sha256 });
  assert.deepEqual(first.files.model, s.model);
  assert.equal(first.files.manifest.tag, "F1-small");
  assert.equal(first.files.tokenizer, '{"t":1}');
  assert.equal(first.fetched, s.model.length + 7 + 18 + 3 + 1 + 1 + 1);
  assert.ok(await isCached(first.list, base, s.cachesApi));
  assert.deepEqual([...s.stores.keys()], [CACHE_PREFIX + "abc"]);

  s.fetched.length = 0;
  const again = await loadModelFiles({ base, fetch: s.fetchFn, caches: s.cachesApi, sha256 });
  assert.deepEqual(s.fetched, ["files.json"], "only the list is asked for again");
  assert.equal(again.fetched, 0);
  assert.deepEqual(again.files.model, s.model);
});

test("a part whose sha256 differs is refused and not kept", async () => {
  const s = fakeSite();
  s.site.set(new URL("model.onnx.part1", base).href, bytes("XXXXXXXX"));
  await assert.rejects(loadModelFiles({ base, fetch: s.fetchFn, caches: s.cachesApi, sha256 }), (e) => e.kind === "corrupt");
  assert.ok(!(await isCached(s.list, base, s.cachesApi)));
});

test("offline before the first download is 'offline'; a build without the model is 'unavailable'", async () => {
  const s = fakeSite();
  s.setOffline(true);
  await assert.rejects(loadModelFiles({ base, fetch: s.fetchFn, caches: s.cachesApi, sha256 }), (e) => e.kind === "offline");
  const none = fakeSite();
  none.site.delete(new URL("files.json", base).href);
  assert.equal(await readFileList(base, none.fetchFn), null);
  await assert.rejects(loadModelFiles({ base, fetch: none.fetchFn, caches: none.cachesApi, sha256 }), (e) => e.kind === "unavailable");
});

test("a new model's files replace the old ones' cache, and remove clears them all", async () => {
  const s = fakeSite({ id: "old" });
  await loadModelFiles({ base, fetch: s.fetchFn, caches: s.cachesApi, sha256 });
  const list = JSON.parse(new TextDecoder().decode(s.site.get(new URL("files.json", base).href)));
  s.site.set(new URL("files.json", base).href, bytes(JSON.stringify({ ...list, id: "new" })));
  await s.cachesApi.open("rumbo-0.1.0-shell");
  await loadModelFiles({ base, fetch: s.fetchFn, caches: s.cachesApi, sha256 });
  assert.deepEqual([...s.stores.keys()].sort(), [CACHE_PREFIX + "new", "rumbo-0.1.0-shell"]);
  await removeModel(s.cachesApi);
  assert.deepEqual([...s.stores.keys()], ["rumbo-0.1.0-shell"]);
  assert.ok(!(await isCached(list, base, s.cachesApi)));
  assert.deepEqual([...s.stores.keys()], ["rumbo-0.1.0-shell"], "looking doesn't make the cache again");
});

// ---------------------------------------------------------------- the glue

const vault = (icons) => [
  { path: "Work.org", sha: "1", text: "* Projects\n** NEXT Ship the report\n** NEXT Call the bank\n** INPR Fix the boiler\n** TODO Not in the agenda\n", work: null },
  { path: ".ps/task-icons.json", sha: "2", text: JSON.stringify({ tag: "F1-big", inputs: ["title", "parents"], map: icons }), work: null },
];
const key = (title) => JSON.stringify({ title, parents: ["Projects"] });

function fakeStore() {
  const settings = new Map();
  return { settings, getSetting: async (k) => settings.get(k), setSetting: async (k, v) => void settings.set(k, structuredClone(v)) };
}

function fakeModel(answers = {}) {
  const calls = [];
  return {
    calls,
    list: async () => ({ id: "x" }),
    guess: async (tasks) => {
      calls.push(tasks.map((t) => t.title));
      return { tag: "F1-small", guesses: Object.fromEntries(tasks.map((t) => [t.key, answers[t.title] ?? null])), stats: { fetched: 100 } };
    },
  };
}

test("only agenda tasks with no answer from Emacs are asked about; its \"\" is an answer", () => {
  const m = buildModel(vault({ [key("Ship the report")]: "description", [key("Fix the boiler")]: "" }));
  const missing = missingTasks(m, new Map());
  assert.deepEqual(missing, [{ key: key("Call the bank"), title: "Call the bank", parents: ["Projects"] }]);
  assert.deepEqual(missingTasks(m, new Map([[key("Call the bank"), ""]])), []);
});

test("guesses are asked for once, kept in settings, shown, and give way to Emacs's icon", async () => {
  const store = fakeStore();
  const model = fakeModel({ "Call the bank": "account_balance" });
  let redraws = 0;
  const logs = [];
  const icons = createIcons({ store, iconModel: model, redraw: () => redraws++, log: (e) => logs.push(e) });
  await icons.load();
  let m = buildModel(vault({ [key("Ship the report")]: "description" }));
  icons.attach(m);
  icons.schedule(m, "file");
  await icons.flush();
  assert.equal(model.calls.length, 0, "not while the agenda isn't shown");

  icons.schedule(m, "agenda");
  await icons.flush();
  assert.deepEqual(model.calls, [["Fix the boiler", "Call the bank"]]); // agenda order: In progress, then Next up
  assert.equal(redraws, 1);
  assert.equal(m.taskIcon(m.agenda.flatMap((s) => s.items).find((i) => i.heading.title === "Call the bank").heading), "account_balance");
  assert.deepEqual(store.settings.get("iconGuesses"), { tag: "F1-small", map: { [key("Call the bank")]: "account_balance", [key("Fix the boiler")]: "" } });
  assert.equal(logs.length, 1);

  // Drawn again: nothing new to ask.
  icons.schedule(m, "agenda");
  await icons.flush();
  assert.equal(model.calls.length, 1);

  // A reopen: the stored guesses show with no model at all.
  const later = createIcons({ store, iconModel: fakeModel(), redraw: () => {} });
  await later.load();
  const m2 = buildModel(vault({ [key("Ship the report")]: "description" }));
  later.attach(m2);
  const bank = m2.agenda.flatMap((s) => s.items).find((i) => i.heading.title === "Call the bank").heading;
  assert.equal(m2.taskIcon(bank), "account_balance");

  // Emacs's icon arrives with a pull: it wins, and the guess is let go.
  m = buildModel(vault({ [key("Ship the report")]: "description", [key("Call the bank")]: "savings" }));
  later.attach(m);
  later.schedule(m, "agenda");
  const bank2 = m.agenda.flatMap((s) => s.items).find((i) => i.heading.title === "Call the bank").heading;
  assert.equal(m.taskIcon(bank2), "savings");
  assert.ok(!later.guesses.has(key("Call the bank")));
  assert.ok(!(key("Call the bank") in store.settings.get("iconGuesses").map));
});

test("a failed load is logged once and retried later; a build without the model is never asked again", async () => {
  const store = fakeStore();
  let n = 0;
  const failing = { list: async () => ({ id: "x" }), guess: async () => (n++, Promise.reject(Object.assign(new Error("Load failed"), { kind: "offline" }))) };
  const logs = [];
  const icons = createIcons({ store, iconModel: failing, redraw: () => {}, log: (e) => logs.push(e) });
  await icons.load();
  const m = buildModel(vault({}));
  icons.schedule(m, "agenda");
  await icons.flush();
  await icons.flush();
  assert.equal(n, 1, "the retry waits for its backoff");
  assert.equal(logs.length, 1);
  assert.match(logs[0].error, /Load failed/);

  const none = { list: async () => null, guess: async () => assert.fail("asked a build with no model") };
  const quiet = createIcons({ store: fakeStore(), iconModel: none, redraw: () => {} });
  await quiet.load();
  quiet.schedule(m, "agenda");
  await quiet.flush();
  await quiet.flush();
});

test("a sync in progress makes the guesses wait", async () => {
  let busy = true;
  const model = fakeModel();
  const icons = createIcons({ store: fakeStore(), iconModel: model, redraw: () => {}, busy: () => busy, delay: 5 });
  await icons.load();
  const m = buildModel(vault({}));
  icons.schedule(m, "agenda");
  await icons.flush();
  assert.equal(model.calls.length, 0);
  busy = false;
  await icons.flush();
  assert.equal(model.calls.length, 1);
  assert.equal(iconKey(m.agenda[1].items[0].heading), key("Fix the boiler"));
});
