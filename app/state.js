// One state object for the whole app. The place (view, file, focus, fold, agenda grouping) lives in
// the URL, so Back and Forward work; the theme and tablet nav are settings; fold overrides and
// expanded rows stay in memory. `runtime` holds what the app knows beyond the vault: the replica's
// meta, the sync status and whether an update is waiting.

// Per-device choices, kept in the `settings` store (not the URL).
export const THEMES = ["paper", "slate", "dusk", "night"];
export const NAVS = ["rail", "drawer"]; // tablet portrait: icon rail beside the page, or the page alone with a drawer

export const FOLDS = ["overview", "tasks", "all"];

export const state = {
  theme: "paper",
  nav: "rail",
  edit: "mode", // the edit-mode way in; swipe joins it with the write path (plan step 4)
  editing: false, // edit mode is on (the "mode" variant); kept in the URL but not a history entry
  fold: "tasks",
  file: null, // vault-relative path of the open file
  view: "agenda", // what the main area shows: a view ("agenda"; later calendar, situations), "file" or "sync"
  focus: null, // id of the section the file view is narrowed to (null = whole file)
  group: "list", // agenda: "list" | "file"
  drawer: false,
  sheet: null, // "contents" | "legend" | "settings" | null
  // in-memory only
  overrides: new Map(), // path -> Map(id -> "open" | "shut" | "kids")
  agendaOpen: new Set(), // expanded agenda rows (heading ids)
  agendaShut: new Set(), // collapsed agenda sections
};

export const runtime = {
  meta: {}, // the replica's meta (repo, branch, base commit, last check, last error, …)
  sync: { status: "synced", lastError: null }, // from the sync engine
  updateWaiting: false,
};

const URL_KEYS = ["fold", "file", "view", "focus", "group", "editing"];

export function readUrl() {
  const p = new URLSearchParams(location.search);
  for (const k of URL_KEYS) {
    const v = p.get(k);
    if (v == null) continue;
    if (k === "fold" && !FOLDS.includes(v)) continue;
    state[k] = k === "editing" ? v === "1" : v;
  }
}

// Our place in the browser history, so the header's back and forward buttons know what they can do.
let navIdx = history.state?.idx ?? 0;
let navMax = navIdx;
export const canGoBack = () => navIdx > 0;
export const canGoForward = () => navIdx < navMax;

export function writeUrl(push = false) {
  const p = new URLSearchParams();
  for (const k of URL_KEYS) {
    const v = k === "editing" ? (state.editing ? "1" : "") : state[k];
    if (v == null || v === "") continue;
    p.set(k, v);
  }
  const q = p.toString().replace(/%2F/g, "/");
  const url = q ? `${location.pathname}?${q}` : location.pathname;
  if (push) {
    navIdx += 1;
    navMax = navIdx;
    history.pushState({ idx: navIdx }, "", url);
  } else history.replaceState({ idx: navIdx }, "", url);
}

let renderer = () => {};
export function setRenderer(fn) {
  renderer = fn;
}

// Moving to another file, view or focus is a history entry, so Back and Forward work.
const NAV_KEYS = ["view", "file", "focus"];
export function update(patch = {}) {
  const moved = NAV_KEYS.some((k) => k in patch && patch[k] !== state[k]);
  Object.assign(state, patch);
  writeUrl(moved);
  renderer();
}

export function restoreFromUrl(event) {
  navIdx = event?.state?.idx ?? 0;
  Object.assign(state, { view: "agenda", focus: null, sheet: null, drawer: false, editing: false });
  readUrl();
  renderer();
}

export function overridesFor(path) {
  if (!state.overrides.has(path)) state.overrides.set(path, new Map());
  return state.overrides.get(path);
}

// Actions are filled in by app.js; views call them without importing app.js (no cycles).
export const actions = {};
