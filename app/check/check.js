// The device check (docs/plans/real-app.md §10, step 1): confirms on each device the platform
// assumptions the app is built on, using the app's own modules. It shows counts, SHAs and
// timings only, never vault text or file names, so the report can be pasted anywhere.

import { startPwa, onStatus, applyUpdate } from "../pwa.js";
import { createRemote } from "../remote-github.js";
import { blobSha, bytesToText } from "../gitobj.js";
import { isIncluded, SUPPORT_FILES } from "../vault-files.js";
import { openStore } from "../store.js";
import { buildModel } from "../data.js";
import { spacingTable } from "../spacing.js";

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------------------------------------
// A small key-value store in IndexedDB, with the 2 s guard of §3: WebKit can leave a request
// unanswered forever after a long time in the background, so every call times out and the
// database is reopened on the next one. (The app's own store comes in step 2.)

const DB_NAME = "rumbo-check";
const IDB_TIMEOUT = 2000;
let dbPromise = null;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function guarded(work) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      dbPromise?.then((db) => db.close()).catch(() => {});
      dbPromise = null;
      reject(new Error("IndexedDB did not answer within 2 s"));
    }, IDB_TIMEOUT);
  });
  return Promise.race([work(), timeout]).finally(() => clearTimeout(timer));
}

const kv = {
  get: (key) =>
    guarded(async () => {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const req = db.transaction("kv").objectStore("kv").get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }),
  set: (key, value) =>
    guarded(async () => {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }),
};

// ---------------------------------------------------------------------------------------------
// Check rows. Each has a status: pass, fail, info (a fact to record) or wait (running).

const MARKS = { pass: "✓", fail: "✗", info: "·", wait: "…" };
const checks = new Map();

function report(id, title, status, detail = "") {
  checks.set(id, { title, status, detail });
  renderChecks();
  renderReport();
}

function renderChecks() {
  const ul = $("#checks");
  ul.replaceChildren(
    ...[...checks.values()].map(({ title, status, detail }) => {
      const li = document.createElement("li");
      li.className = status;
      const mark = document.createElement("span");
      mark.className = "mark";
      mark.textContent = MARKS[status];
      const t = document.createElement("span");
      t.textContent = title;
      li.append(mark, t);
      if (detail) {
        const d = document.createElement("span");
        d.className = "detail";
        d.textContent = detail;
        li.append(d);
      }
      return li;
    }),
  );
}

const errorText = (e) => (e?.kind ? `${e.kind}: ${e.message}${e.status ? ` (HTTP ${e.status}${e.detail ? `, ${e.detail}` : ""})` : e.detail ? ` (${e.detail})` : ""}` : String(e?.message || e));
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

// ---------------------------------------------------------------------------------------------
// Checks that need no network.

const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

function environmentChecks() {
  const iPad = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  report("secure", "Secure context (needed for the service worker and hashing)", isSecureContext ? "pass" : "fail", location.origin);
  report("standalone", "Opened from the Home Screen", standalone() ? "pass" : "info", standalone() ? "standalone" : "in the browser: add it to the Home Screen and open it from there");
  report(
    "device",
    "Device",
    "info",
    `${iPad ? "iPad (reports MacIntel with touch)" : navigator.platform || "?"}; touch points ${navigator.maxTouchPoints}; screen ${screen.width}×${screen.height} @${devicePixelRatio}x; window ${innerWidth}×${innerHeight}; ${navigator.userAgent}`,
  );
  report("subtle", "crypto.subtle available (blob SHAs)", crypto?.subtle ? "pass" : "fail");
}

async function storageChecks(opens) {
  report("idb", "IndexedDB keeps data between opens", opens.length > 1 ? "pass" : "info", `${opens.length} open(s) recorded; open it again to confirm`);
  if (!navigator.storage?.persisted) return report("persist", "Persistent storage", "fail", "navigator.storage is missing");
  const persisted = await navigator.storage.persisted();
  const est = navigator.storage.estimate ? await navigator.storage.estimate() : null;
  const quota = est ? `; using ${kb(est.usage || 0)} of ${((est.quota || 0) / 1024 ** 3).toFixed(1)} GB` : "";
  report("persist", "Persistent storage granted", persisted ? "pass" : "info", `${persisted ? "yes" : "not yet: it is asked for when you run the checks"}${quota}`);
}

async function askPersist() {
  if (!navigator.storage?.persist) return;
  const granted = await navigator.storage.persist();
  report("persist", "Persistent storage granted", granted ? "pass" : "fail", granted ? "yes" : "refused by the browser");
}

async function swChecks(st) {
  const caches_ = "caches" in self ? (await caches.keys()).filter((k) => k.startsWith("rumbo-")) : [];
  if (!st.supported) return report("sw", "Service worker", "fail", "not supported here");
  if (st.build === "dev") return report("sw", "Service worker", "info", "not registered: this is an unbuilt copy");
  report(
    "sw",
    "Service worker serves the page",
    st.controlled ? "pass" : "info",
    st.controlled ? `cache ${caches_.join(", ") || "none"}` : "installed on the first open; it takes over from the next one",
  );
}

// ---------------------------------------------------------------------------------------------
// Checks against GitHub.

const splitRepo = (s) => {
  const [owner, repo] = (s || "").trim().split("/");
  return owner && repo ? { owner, repo } : null;
};

/** Run `fn` over `items`, `n` at a time. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

async function vaultChecks(s) {
  const where = splitRepo(s.vaultRepo);
  if (!where || !s.token) return report("vault", "Vault repo", "info", "fill in the vault repo and the token");
  const remote = createRemote({ ...where, branch: s.branch || "main", token: s.token });

  report("head", "Read the branch head", "wait");
  let head;
  try {
    const t0 = performance.now();
    head = await remote.head();
    report("head", "Read the branch head", "pass", `${head.sha.slice(0, 7)} in ${Math.round(performance.now() - t0)} ms`);
    noteReach("reached");
  } catch (e) {
    // Any answer from GitHub, even a 401, means it was reached.
    if (e?.kind) noteReach(e.kind === "offline" ? "unreachable" : "reached");
    return report("head", "Read the branch head", "fail", errorText(e));
  }

  try {
    const again = await remote.head(head.etag);
    report("etag", "Unchanged head comes back as 304 (free polling)", again.changed ? "fail" : "pass", again.changed ? "a full answer came back instead" : `ETag ${head.etag ? "sent" : "missing"}`);
  } catch (e) {
    report("etag", "Unchanged head comes back as 304 (free polling)", "fail", errorText(e));
  }

  const l = remote.limits;
  report("limits", "Rate-limit headers readable", l ? "pass" : "fail", l ? `${l.remaining} of ${l.limit} left this hour` : "not exposed");
  report(
    "expiry",
    "Token expiry header readable",
    "info",
    remote.tokenExpiry
      ? `yes: ${remote.tokenExpiry}`
      : `no (expected: GitHub's CORS policy hides it); entered here: ${s.tokenNoExpiry ? "no expiry" : s.tokenExpiry || "not set"}`,
  );

  let entries;
  try {
    const commit = await remote.commit(head.sha);
    const tree = await remote.tree(commit.tree);
    entries = tree.entries.filter((e) => e.type === "blob");
    const included = entries.filter((e) => isIncluded(e.path));
    const support = SUPPORT_FILES.map((p) => `${p} ${entries.some((e) => e.path === p) ? "found" : "missing"}`).join("; ");
    report("tree", "Read the whole file list", "pass", `${entries.length} files; ${included.length} agenda files; ${support}`);
  } catch (e) {
    return report("tree", "Read the whole file list", "fail", errorText(e));
  }

  // The first clone: every agenda file and support file, each checked against its blob SHA.
  const wanted = entries.filter((e) => isIncluded(e.path) || SUPPORT_FILES.includes(e.path));
  report("clone", "Download every agenda file and check its SHA", "wait", `${wanted.length} files…`);
  try {
    const t0 = performance.now();
    let bytes = 0;
    let mismatched = 0;
    let notUtf8 = 0;
    let withCR = 0;
    await pool(wanted, 6, async (e) => {
      const data = await remote.blob(e.sha);
      bytes += data.byteLength;
      if ((await blobSha(data)) !== e.sha) mismatched++;
      try {
        if (bytesToText(data).includes("\r")) withCR++;
      } catch {
        notUtf8++;
      }
    });
    const ms = performance.now() - t0;
    report(
      "clone",
      "Download every agenda file and check its SHA",
      mismatched ? "fail" : "pass",
      `${wanted.length} files, ${kb(bytes)} in ${secs(ms)}; SHA mismatches ${mismatched}; not UTF-8 ${notUtf8}; with CR line endings ${withCR}; ${remote.limits?.remaining ?? "?"} requests left this hour`,
    );
  } catch (e) {
    report("clone", "Download every agenda file and check its SHA", "fail", errorText(e));
  }
}

async function notesChecks(s) {
  const where = splitRepo(s.notesRepo);
  if (!where || !s.token) return report("notes", "Notes repo", "info", "fill in the notes repo to check Obsidian notes");
  const remote = createRemote({ ...where, token: s.token });
  report("notes", "Find and fetch a note by its name", "wait");
  try {
    const t0 = performance.now();
    const head = await remote.head();
    const commit = await remote.commit(head.sha);
    const tree = await remote.tree(commit.tree);
    const notes = tree.entries.filter((e) => e.type === "blob" && e.path.endsWith(".md") && !e.path.split("/").some((p) => p.startsWith(".")));
    const byName = new Map();
    let clashes = 0;
    for (const e of notes) {
      const name = e.path.split("/").pop().slice(0, -3).toLowerCase();
      if (byName.has(name)) clashes++;
      byName.set(name, e);
    }
    const indexMs = performance.now() - t0;
    const detail = `${notes.length} notes indexed in ${secs(indexMs)}; ${clashes} name clashes`;
    if (!s.noteName) return report("notes", "Find and fetch a note by its name", "info", `${detail}; no note name given`);
    const hit = byName.get(s.noteName.trim().toLowerCase());
    if (!hit) return report("notes", "Find and fetch a note by its name", "fail", `${detail}; the note was not found`);
    const t1 = performance.now();
    const raw = await remote.raw(hit.path, head.sha);
    const sameSha = (await blobSha(raw)) === hit.sha;
    report("notes", "Find and fetch a note by its name", sameSha ? "pass" : "fail", `${detail}; note fetched, ${kb(raw.byteLength)} in ${Math.round(performance.now() - t1)} ms; SHA ${sameSha ? "matches" : "differs"}`);
  } catch (e) {
    report("notes", "Find and fetch a note by its name", "fail", errorText(e));
  }
}

// ---------------------------------------------------------------------------------------------
// Settings, the Obsidian link, opens and the report.

const FIELDS = ["vaultRepo", "branch", "notesRepo", "token", "tokenExpiry", "tokenNoExpiry", "obsidianVault", "noteName"];
const form = () => $("#setup");

function readForm() {
  const f = form();
  return Object.fromEntries(FIELDS.map((k) => [k, f.elements[k].type === "checkbox" ? f.elements[k].checked : f.elements[k].value.trim()]));
}

function fillForm(s) {
  for (const k of FIELDS) {
    const el = form().elements[k];
    if (el.type === "checkbox") el.checked = !!s?.[k];
    else if (s?.[k]) el.value = s[k];
  }
  syncExpiry();
}

// A token made without an expiry has no date to enter.
function syncExpiry() {
  const f = form();
  f.elements.tokenExpiry.disabled = f.elements.tokenNoExpiry.checked;
}

function updateObsidianLink() {
  const s = readForm();
  const vault = s.obsidianVault || "obsidian";
  $("#obsidian-link").href = `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(s.noteName || "")}`;
}

let opens = [];
let currentOpen = null;
let pwaStatus = null;

// `navigator.onLine` can say "online" with every radio off (Android Chrome, 2026-11-22), so each
// open also records whether this open's first request actually reached GitHub.
function noteReach(github) {
  if (!currentOpen || currentOpen.github) return;
  currentOpen.github = github;
  kv.set("opens", opens).catch(() => {});
  renderOpens();
  renderReport();
}

const offline = (o) => !o.online || o.github === "unreachable";
const reachText = (o) => (o.github ? `, GitHub ${o.github}` : "");

function renderOpens() {
  $("#opens").replaceChildren(
    ...opens
      .slice()
      .reverse()
      .map((o) => {
        const li = document.createElement("li");
        li.className = "info";
        const mark = document.createElement("span");
        mark.className = "mark";
        mark.textContent = offline(o) ? "✈" : "·";
        const t = document.createElement("span");
        t.textContent = `${new Date(o.at).toLocaleString()} — the browser says ${o.online ? "online" : "offline"}${reachText(o)}, ${o.controlled ? "from the service worker" : "from the network"}, ${o.standalone ? "Home Screen" : "browser"}`;
        li.append(mark, t);
        return li;
      }),
  );
}

function renderReport() {
  const manual = [...document.querySelectorAll("select.manual")].map((el) => `${el.name}: ${el.value || "not tried"}`);
  const lines = [
    `Rumbo device check, ${new Date().toISOString()}`,
    `Build: ${pwaStatus ? `${pwaStatus.version} (${pwaStatus.build})` : "?"}`,
    "",
    ...[...checks.values()].map((c) => `${MARKS[c.status]} ${c.title}${c.detail ? ` — ${c.detail}` : ""}`),
    "",
    "Opens:",
    ...opens.map((o) => `  ${o.at} ${o.online ? "online" : "OFFLINE"} ${o.controlled ? "sw" : "net"} ${o.standalone ? "home-screen" : "browser"}${o.github ? ` github-${o.github}` : ""}`),
    "",
    "Obsidian link:",
    ...manual.map((m) => `  ${m}`),
    "",
    `Blank-line rule${spacingRows ? ` (${spacingNote})` : ""}:`,
    ...(spacingRows ? spacingRows.map((r) => `  ${r.cell}: ${r.total} — ${countsText(r)} — ${ruleText(r)}`) : [`  ${spacingNote}`]),
  ];
  $("#report").value = lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// The blank-line rule (real-app.md §5): the cells counted from the app's own replica, the same
// numbers the app's edits use. Counts only; no vault text or file names.

let spacingRows = null;
let spacingNote = "not read yet";
const countsText = (r) => r.counts.map(([v, n]) => `${v}: ${n}`).join(", ") || "—";
const ruleText = (r) => (!r.total ? "—" : r.rule == null ? `keep (too few; default ${r.fallback})` : `${r.rule} (${r.share}%)`);

async function spacingCheck() {
  const store = openStore();
  try {
    const records = await store.allFiles();
    const model = records.length ? buildModel(records) : null;
    spacingRows = model?.files.length ? spacingTable(model.spacing) : null;
    spacingNote = spacingRows ? `${model.spacing.files} files` : "No vault on this device yet: set Rumbo up first.";
  } finally {
    store.close();
  }
  const table = $("#spacing");
  table.hidden = !spacingRows;
  $("#spacing-none").hidden = !!spacingRows;
  $("#spacing-none").textContent = spacingNote;
  if (spacingRows) {
    table.tBodies[0].replaceChildren(
      ...spacingRows.map((r) => {
        const tr = document.createElement("tr");
        for (const text of [r.cell, String(r.total), countsText(r), ruleText(r)]) {
          const td = document.createElement("td");
          td.textContent = text;
          tr.append(td);
        }
        return tr;
      }),
    );
  }
  renderReport();
}

// ---------------------------------------------------------------------------------------------
// The task icon model (real-app.md §7): is it here, how long it takes to load and to guess.

const SAMPLE_TASKS = [
  { title: "Book a dentist appointment", parents: ["Health"] },
  { title: "Renew the passport", parents: ["Travel"] },
  { title: "Pay the council tax", parents: ["Money"] },
  { title: "Read the attention paper again", parents: ["Papers"] },
  { title: "Fix the flaky build", parents: ["Work"] },
  { title: "Buy apples and bread", parents: ["Errands"] },
  { title: "Llamar al fontanero", parents: ["Casa"] },
  { title: "Купить билеты на поезд", parents: ["Поездки"] },
  { title: "Practise the guitar piece", parents: ["Music"] },
  { title: "Back up the photos", parents: ["Photos"] },
];
let iconModel = null;
const mb = (n) => `${(n / 1e6).toFixed(0)} MB`;

async function loadIconModel() {
  if (!iconModel) iconModel = (await import("../icon-model.js")).createIconModel();
  return iconModel;
}

let cachedSeq = 0;
async function iconCachedCheck() {
  const mine = ++cachedSeq; // only the latest look reports, when several overlap
  const m = await loadIconModel();
  const list = await m.list().catch(() => null);
  if (mine !== cachedSeq) return;
  if (!list) return report("icon-cached", "Task icon model on this device", "info", "this build has none");
  const size = await m.size();
  if (mine !== cachedSeq) return;
  report("icon-cached", "Task icon model on this device", "info", size ? `yes, ${mb(size)} (${list.tag})` : `no; ${list.tag} is ${mb(m.totalSize(list))} to download`);
}

async function iconRun() {
  const m = await loadIconModel();
  const off = m.onProgress((done, total) => ($("#icon-progress").textContent = `Downloading ${mb(done)} of ${mb(total)}…`));
  report("icon-run", "Task icon model loads and guesses", "wait");
  const t0 = performance.now();
  try {
    const tasks = SAMPLE_TASKS.map((t, i) => ({ key: String(i), ...t }));
    const r = await m.guess(tasks);
    const st = r.stats;
    const enc = [...st.encodeMs].slice(-tasks.length).sort((a, b) => a - b);
    const p = (q) => enc[Math.min(enc.length - 1, Math.floor(q * enc.length))];
    const picks = tasks.map((t) => `${t.title} → ${r.guesses[t.key] || "none"}`).join("; ");
    const mem = performance.memory ? `; JS heap ${mb(performance.memory.usedJSHeapSize)}` : "";
    report(
      "icon-run",
      "Task icon model loads and guesses",
      "pass",
      `${st.fetched ? `downloaded ${mb(st.fetched)}, ` : "from the cache, "}files ${secs(st.filesMs)}, model ${secs(st.loadMs)}, first answer ${secs(performance.now() - t0)}; one guess p50 ${p(0.5)} ms, p95 ${p(0.95)} ms${mem}. ${picks}`,
    );
  } catch (e) {
    report("icon-run", "Task icon model loads and guesses", "fail", errorText(e));
  } finally {
    off();
    $("#icon-progress").textContent = "";
    await iconCachedCheck().catch(() => {});
  }
}

async function iconRemove() {
  const m = await loadIconModel();
  await m.remove();
  checks.delete("icon-run");
  await iconCachedCheck();
}

async function run() {
  const s = readForm();
  await kv.set("settings", s);
  await askPersist();
  await Promise.all([vaultChecks(s), notesChecks(s)]);
}

async function main() {
  environmentChecks();
  onStatus((st) => {
    pwaStatus = st;
    $("#build").textContent = st.build === "dev" ? "Unbuilt copy (no service worker)" : `Version ${st.version}, build ${st.build}`;
    $("#update").hidden = !st.waiting;
    swChecks(st);
    renderReport();
  });
  startPwa().catch((e) => report("sw", "Service worker", "fail", errorText(e)));
  $("#apply-update").addEventListener("click", () => applyUpdate());

  try {
    opens = ((await kv.get("opens")) || []).slice(-9);
    currentOpen = { at: new Date().toISOString(), online: navigator.onLine, controlled: !!navigator.serviceWorker?.controller, standalone: standalone() };
    opens.push(currentOpen);
    await kv.set("opens", opens);
    fillForm(await kv.get("settings"));
    for (const el of document.querySelectorAll("select.manual")) el.value = (await kv.get(el.name)) || "";
  } catch (e) {
    report("idb", "IndexedDB keeps data between opens", "fail", errorText(e));
  }
  renderOpens();
  $("#icon-run").addEventListener("click", () => iconRun());
  $("#icon-remove").addEventListener("click", () => iconRemove().catch((e) => report("icon-cached", "Task icon model on this device", "fail", errorText(e))));
  iconCachedCheck().catch((e) => report("icon-cached", "Task icon model on this device", "fail", errorText(e)));
  spacingCheck().catch((e) => {
    spacingNote = `Couldn't read this device's copy of the vault: ${errorText(e)}`;
    $("#spacing-none").textContent = spacingNote;
    $("#spacing-none").hidden = false;
    renderReport();
  });
  await storageChecks(opens).catch((e) => report("persist", "Persistent storage", "fail", errorText(e)));
  updateObsidianLink();

  form().addEventListener("input", updateObsidianLink);
  form().elements.tokenNoExpiry.addEventListener("change", syncExpiry);
  form().addEventListener("submit", (ev) => {
    ev.preventDefault();
    run().catch((e) => report("run", "Running the checks", "fail", errorText(e)));
  });
  $("#forget").addEventListener("click", async () => {
    form().elements.token.value = "";
    await kv.set("settings", readForm());
  });
  for (const el of document.querySelectorAll("select.manual")) {
    el.addEventListener("change", () => {
      kv.set(el.name, el.value).catch(() => {});
      renderReport();
    });
  }
  $("#copy").addEventListener("click", async () => {
    renderReport();
    try {
      await navigator.clipboard.writeText($("#report").value);
      $("#copied").textContent = "Copied.";
    } catch {
      $("#report").select();
      $("#copied").textContent = "Select-all is on; copy it from the menu.";
    }
  });
  renderReport();

  // The page paints first; the network checks follow, and only when online with a token saved.
  const s = readForm();
  if (navigator.onLine && s.token) run().catch((e) => report("run", "Running the checks", "fail", errorText(e)));
}

main();
