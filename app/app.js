// Entry point. Opening paints from the replica in IndexedDB with no network work first, then the
// sync engine pulls from GitHub (docs/plans/real-app.md §3). Without a repo and token, Setup.

import { state, readUrl, setRenderer, update, actions, restoreFromUrl, runtime, THEMES, NAVS, FOLDS, overridesFor } from "./state.js";
import { buildModel } from "./data.js";
import { setModel, h } from "./ui.js";
import { setOutlineModel, reveal } from "./outline.js";
import { renderShell, sizeClass } from "./shell.js";
import { setEditModel, setStore, onRedraw, onCommitted, onReload, settled, queuedCount, undo } from "./edits.js";
import { mountLayer, setEditUiModel, setLayerSize, panelOpen } from "./edit-ui.js";
import { headingKey, findHeading } from "./org-edit.js";
import { openStore } from "./store.js";
import { createRemote } from "./remote-github.js";
import { pull, syncOnce, createEngine, attachTriggers } from "./sync.js";
import { renderSetup } from "./setup.js";
import { startPwa, onStatus as onPwaStatus, applyUpdate } from "./pwa.js";

const viewport = document.getElementById("viewport");
// The app redraws into its own root; the editing layer beside it (dialogs, menus, the toast) is
// never redrawn, so a dialog keeps its text and the keyboard while the page under it changes.
const appRoot = h("div", { id: "app-root" });
viewport.append(appRoot);
mountLayer(viewport);

const store = openStore();
setStore(store);
const scrolls = new Map();
let model = null;
let remote = null;
let engine = null;

const repoName = (meta) => (meta.repo || "").split("/").pop() || "Plans";

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  if (bg) document.querySelector('meta[name="theme-color"]').content = bg;
}

function pickDefaultFile() {
  if (state.file && model.byPath.has(state.file)) return;
  state.file = (model.files.find((f) => f.counts.NEXT) || model.files[0])?.path || null;
}

// ---------------------------------------------------------------- drawing

let lastView = null;
function render() {
  if (!model) return;
  applyTheme();
  setModel(model);
  setOutlineModel(model);
  setEditModel(model);
  setEditUiModel(model);
  pickDefaultFile();
  if (state.view === "sync" && lastView !== "sync") loadSyncPage();
  lastView = state.view;

  // Remember every scroller's position by name (data-scroll), so redraws and Back/Forward return
  // to where the reader was.
  for (const el of viewport.querySelectorAll("[data-scroll]")) scrolls.set(el.dataset.scroll, el.scrollTop);
  const width = window.innerWidth;
  viewport.dataset.size = sizeClass(width);
  setLayerSize(sizeClass(width));
  appRoot.replaceChildren(renderShell(model, width));
  for (const el of viewport.querySelectorAll("[data-scroll]")) {
    if (scrolls.has(el.dataset.scroll)) el.scrollTop = scrolls.get(el.dataset.scroll);
  }
  placeChanged();
}

function message(text, retry = false) {
  appRoot.replaceChildren(h("div", { class: "loading error" }, h("p", null, text), retry ? h("button", { class: "sy-btn", onclick: () => location.reload() }, "Try again") : null));
}

// Redraws that change the page's height above the reader (edit mode on or off, an edit, a pull)
// keep the row at the top of the file page where it was: same row, same distance from the top.
function fileScroller() {
  return appRoot.querySelector(".file-pane .pane-scroll");
}

function topAnchor() {
  const sc = fileScroller();
  if (!sc) return null;
  const top = sc.getBoundingClientRect().top;
  for (const head of sc.querySelectorAll(".node > .head")) {
    const r = head.getBoundingClientRect();
    if (r.height && r.bottom > top + 1) return { id: head.parentElement.dataset.id, offset: r.top - top, scrollTop: sc.scrollTop };
  }
  return { id: null, offset: 0, scrollTop: sc.scrollTop };
}

function restoreAnchor(a, idMap = null) {
  const sc = fileScroller();
  if (!sc || !a) return;
  const id = a.id && idMap?.has(a.id) ? idMap.get(a.id) : a.id;
  const head = id && sc.querySelector(`.node[data-id="${id}"] > .head`);
  if (!head) {
    sc.scrollTop = a.scrollTop;
    return;
  }
  sc.scrollTop += head.getBoundingClientRect().top - sc.getBoundingClientRect().top - a.offset;
}

function anchored(fn, idMap) {
  const a = topAnchor();
  fn();
  restoreAnchor(a, idMap);
}

// ---------------------------------------------------------------- a pull changed files

/**
 * Carry the reader's place (focus, fold overrides, open agenda rows) from the old model to the new
 * one, finding each heading of a changed file again by its title path. Unchanged files keep their
 * ids: an id is the file's path tag plus the heading's place.
 */
function carryOver(old, next, paths) {
  const changed = new Set(paths);
  const idMap = new Map();
  for (const path of changed) {
    const of = old.byPath.get(path);
    const nf = next.byPath.get(path);
    if (!of) continue;
    for (const hd of of.doc.headings) {
      const n = nf && findHeading(nf.doc, headingKey(of.doc, hd));
      if (n) idMap.set(hd.id, n.id);
    }
    const ov = overridesFor(path);
    state.overrides.set(path, new Map([...ov].filter(([id]) => idMap.has(id)).map(([id, v]) => [idMap.get(id), v])));
  }
  const inChanged = (id) => changed.has(old.headingById.get(id)?.file.path);
  if (state.focus && inChanged(state.focus)) state.focus = idMap.get(state.focus) || null;
  for (const set of [state.agendaOpen, state.agendaShut]) {
    const ids = [...set].map((id) => (inChanged(id) ? idMap.get(id) : id)).filter(Boolean);
    set.clear();
    ids.forEach((id) => set.add(id));
  }
  return idMap;
}

/** The model from the store again. Edits still being written land first, so the redraw can't drop one. */
async function readModel() {
  for (;;) {
    await settled();
    const n = queuedCount();
    const records = await store.allFiles();
    if (n === queuedCount()) return buildModel(records, { name: repoName(runtime.meta) });
  }
}

async function reloadModel(paths) {
  const old = model;
  const next = await readModel();
  const idMap = old ? carryOver(old, next, paths) : new Map();
  model = next;
  anchored(() => update(), idMap);
}

// ---------------------------------------------------------------- the last place

// iOS reopens a Home Screen app at its start page, so the place is saved and restored when the
// app opens with no query (lectern ac9468c).
let placeTimer = 0;
function placeChanged() {
  clearTimeout(placeTimer);
  placeTimer = setTimeout(savePlace, 800);
}

function savePlace() {
  clearTimeout(placeTimer);
  if (!model) return;
  const keyOf = (id) => {
    const at = id && model.headingById.get(id);
    return at ? headingKey(at.file.doc, at.heading) : null;
  };
  const a = state.view === "file" ? topAnchor() : null;
  const main = appRoot.querySelector(".main .pane-scroll");
  store
    .setSetting("place", {
      view: state.view === "sync" ? "agenda" : state.view,
      file: state.file,
      focusKey: keyOf(state.focus),
      fold: state.fold,
      group: state.group,
      anchor: a ? { key: keyOf(a.id), offset: a.offset, scrollTop: a.scrollTop } : null,
      scrollTop: main?.scrollTop || 0,
    })
    .catch(() => {});
}

function restorePlace(place) {
  if (!place || location.search) return null;
  state.view = place.view === "file" ? "file" : "agenda";
  state.file = place.file || null;
  if (FOLDS.includes(place.fold)) state.fold = place.fold;
  if (place.group) state.group = place.group;
  const file = state.file && model.byPath.get(state.file);
  state.focus = (file && findHeading(file.doc, place.focusKey)?.id) || null;
  return () => {
    if (state.view === "file" && place.anchor) {
      const id = file && findHeading(file.doc, place.anchor.key)?.id;
      restoreAnchor({ id, offset: place.anchor.offset, scrollTop: place.anchor.scrollTop });
    } else {
      const main = appRoot.querySelector(".main .pane-scroll");
      if (main) main.scrollTop = place.scrollTop || 0;
    }
  };
}

window.addEventListener("pagehide", savePlace);
document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && savePlace());
viewport.addEventListener("scroll", placeChanged, { capture: true, passive: true });

// ---------------------------------------------------------------- sync

function startSync() {
  const m = runtime.meta;
  const [owner, repo] = m.repo.split("/");
  remote = createRemote({ owner, repo, branch: m.branch || "main", token: m.token });
  engine?.stop();
  engine = createEngine({ run: () => syncOnce({ remote, store }), store });
  let shown = markState();
  engine.onStatus(async (st) => {
    runtime.sync = st;
    runtime.meta = await store.getMeta().catch(() => runtime.meta);
    runtime.pending = await store.pending().catch(() => runtime.pending);
    if (st.result?.changed) return reloadModel(st.result.paths);
    // Redraw only when something on screen depends on it.
    const now = markState();
    if (now !== shown || state.view === "sync" || state.sheet === "settings") render();
    shown = now;
    if (!st.running && state.view === "sync") loadSyncPage();
  });
  attachTriggers(engine);
  engine.sync("start");
}

const markState = () => (["synced", "syncing"].includes(runtime.sync.status) ? "" : runtime.sync.status);

let syncPageSeq = 0;
async function loadSyncPage() {
  const seq = ++syncPageSeq;
  const page = (runtime.syncPage = { log: await store.readLog().catch(() => []), vault: null, file: null });
  render();
  if (!remote) return;
  const fetchLog = (opts) => remote.log(opts).catch((e) => ({ error: e.kind === "offline" ? "Offline: history needs GitHub." : e.message }));
  const [vault, file] = await Promise.all([fetchLog({ perPage: 20 }), state.file ? fetchLog({ path: state.file, perPage: 10 }) : null]);
  if (seq !== syncPageSeq) return;
  Object.assign(page, { vault, file });
  if (state.view === "sync") render();
}

// ---------------------------------------------------------------- setup

/** What the device check saved on this device (its own database), to prefill Setup once. */
function checkPageSettings() {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 2000);
    const done = (v) => (clearTimeout(timer), resolve(v));
    let req;
    try {
      req = indexedDB.open("rumbo-check");
    } catch {
      return done(null);
    }
    // No such database: don't create one.
    req.onupgradeneeded = () => req.transaction.abort();
    req.onerror = () => done(null);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const get = db.transaction("kv").objectStore("kv").get("settings");
        get.onsuccess = () => {
          db.close();
          const s = get.result;
          done(s ? { repo: s.vaultRepo, branch: s.branch, token: s.token, tokenExpiry: s.tokenExpiry, noExpiry: s.tokenNoExpiry, notesRepo: s.notesRepo, obsidianVault: s.obsidianVault } : null);
        };
        get.onerror = () => (db.close(), done(null));
      } catch {
        db.close();
        done(null);
      }
    };
  });
}

async function showSetup(values) {
  engine?.stop();
  appRoot.replaceChildren(renderSetup(values, runSetup));
}

async function runSetup(v, say) {
  const [owner, repo] = v.repo.split("/");
  const r = createRemote({ owner, repo, branch: v.branch, token: v.token });
  try {
    say("Checking the repo…");
    await r.head();
    const old = runtime.meta;
    if (old.base && (old.repo !== v.repo || old.branch !== v.branch)) await store.resetReplica();
    await store.setMeta({ repo: v.repo, branch: v.branch, token: v.token, noExpiry: v.noExpiry, tokenExpiry: v.tokenExpiry, device: v.device });
    await store.setSetting("obsidian", { repo: v.notesRepo, vault: v.obsidianVault });
    await pull({ remote: r, store, onProgress: ({ done, total }) => say(total ? `Downloading ${done} of ${total} files…` : "Up to date.") });
    await store.log({ kind: "setup", repo: v.repo, branch: v.branch });
  } catch (e) {
    say(e.message + (e.detail ? ` (${e.detail})` : ""), "error");
    return;
  }
  // Asked once, after Setup succeeds (Acervo dictionaryStore.ts).
  navigator.storage?.persist?.().catch(() => {});
  runtime.meta = await store.getMeta();
  model = buildModel(await store.allFiles(), { name: repoName(runtime.meta) });
  update({ view: "agenda", focus: null });
  startSync();
}

// ---------------------------------------------------------------- actions

actions.openFile = (path) => update({ view: "file", file: path, focus: null, drawer: false, sheet: null });
actions.openView = (view) => update({ view, focus: null, drawer: false, sheet: null });
actions.openSync = () => update({ view: "sync", focus: null, drawer: false, sheet: null });
actions.reveal = (id) => reveal(id);
actions.setEditing = (on) => anchored(() => update({ editing: on }));
actions.openHeading = (path, id) => {
  actions.openFile(path);
  requestAnimationFrame(() => requestAnimationFrame(() => reveal(id)));
};
actions.setPref = (key, value) => {
  update({ [key]: value });
  store.setSetting("prefs", { theme: state.theme, nav: state.nav }).catch(() => {});
};
actions.syncNow = () => engine?.sync("manual");
actions.resetReplica = async () => {
  try {
    await store.resetReplica();
  } catch (e) {
    alert(e.message);
    return;
  }
  runtime.meta = await store.getMeta();
  model = buildModel([], { name: repoName(runtime.meta) });
  render();
  engine?.sync("manual");
};
actions.openSetup = () => showSetup(runtime.meta);
// An update never lands during a sync (§2).
actions.applyUpdate = async () => {
  await engine?.idle();
  applyUpdate();
};
onRedraw((idMap) => anchored(() => update(), idMap));

// An edit is stored: push it once the owner pauses (edits under 3 s apart are one commit anyway).
let pushTimer = 0;
onCommitted(async () => {
  runtime.pending = await store.pending().catch(() => runtime.pending);
  if (state.view === "sync") render();
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => engine?.sync("edit"), 3000);
});
// An edit the store refused: show what the store holds. Every changed path is carried over.
onReload(() => reloadModel(model ? model.files.map((f) => f.path) : []));

// ---------------------------------------------------------------- start

const typing = (e) => e.target.closest?.("input, textarea, [contenteditable]");
document.addEventListener("keydown", (e) => {
  if (!model || panelOpen()) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey && !typing(e) && state.view === "file") {
    e.preventDefault();
    undo();
    return;
  }
  if (e.key.toLowerCase() === "e" && !e.metaKey && !e.ctrlKey && !e.altKey && !typing(e) && state.view === "file") {
    actions.setEditing(!state.editing);
    return;
  }
  if (e.key === "Escape" && state.editing && !state.sheet && !state.drawer) actions.setEditing(false);
  if (e.key === "Escape" && (state.sheet || state.drawer)) update({ sheet: null, drawer: false });
  if (e.key === "Tab" && e.shiftKey && !typing(e)) {
    e.preventDefault();
    state.overrides.delete(state.file);
    update({ fold: FOLDS[(FOLDS.indexOf(state.fold) + 1) % FOLDS.length] });
  }
});

let resizeRaf = 0;
window.addEventListener("resize", () => (resizeRaf ||= requestAnimationFrame(() => ((resizeRaf = 0), render()))));
window.addEventListener("popstate", restoreFromUrl);

async function boot() {
  startPwa().catch(() => {});
  onPwaStatus((st) => {
    if (runtime.updateWaiting === st.waiting) return;
    runtime.updateWaiting = st.waiting;
    render();
  });
  readUrl();
  setRenderer(render);
  let meta, prefs, place;
  try {
    [meta, prefs, place] = await Promise.all([store.getMeta(), store.getSetting("prefs"), store.getSetting("place")]);
  } catch (e) {
    return message(`This device's copy of the vault could not be opened: ${e.message}`, true);
  }
  if (THEMES.includes(prefs?.theme)) state.theme = prefs.theme;
  if (NAVS.includes(prefs?.nav)) state.nav = prefs.nav;
  applyTheme();
  runtime.meta = meta;
  if (!meta.repo || !meta.token) return showSetup({ ...(await checkPageSettings()), ...meta });

  model = buildModel(await store.allFiles(), { name: repoName(meta) });
  runtime.pending = await store.pending().catch(() => []);
  const after = restorePlace(place);
  update();
  after?.();
  startSync();
}

boot();
