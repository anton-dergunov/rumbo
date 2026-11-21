// One state object for the whole prototype. Variant keys and the open file live in the URL so any
// combination can be bookmarked or screenshotted; fold overrides and expanded rows stay in memory.

export const VARIANTS = {
  frame: ["none", "ipad11p", "ipad11l", "minip", "minil", "phone"],
  theme: ["paper", "slate", "dusk", "night"],
  nav: ["rail", "drawer"], // tablet portrait: icon rail beside the page, or the page alone with a drawer
  data: ["real", "sample"],
  // How editing is entered, to compare on the devices: a header toggle that turns on edit mode,
  // long-press (right-click), or swipe actions.
  edit: ["mode", "press", "swipe"],
};

export const LABELS = {
  edit: { mode: "edit mode", press: "long-press", swipe: "swipe" },
  frame: { none: "window", ipad11p: 'iPad 11" ▯', ipad11l: 'iPad 11" ▭', minip: "iPad mini ▯", minil: "iPad mini ▭", phone: "phone" },
};

export const FRAMES = {
  ipad11p: [834, 1210],
  ipad11l: [1210, 834],
  minip: [744, 1133],
  minil: [1133, 744],
  phone: [412, 915],
};

export const FOLDS = ["overview", "tasks", "all"];

export const state = {
  frame: "none",
  theme: "paper",
  nav: "rail",
  data: "real",
  edit: "mode",
  editing: false, // edit mode is on (the "mode" variant); kept in the URL but not a history entry
  fold: "tasks",
  file: null, // vault-relative path of the open file
  view: "agenda", // what the main area shows: a view ("agenda"; later calendar, situations) or "file"
  focus: null, // id of the section the file view is narrowed to (null = whole file)
  group: "list", // agenda: "list" | "file"
  drawer: false,
  sheet: null, // "contents" | "legend" | null
  harness: true,
  // in-memory only
  overrides: new Map(), // path -> Map(id -> "open" | "shut" | "kids")
  agendaOpen: new Set(), // expanded agenda rows (heading ids)
  agendaShut: new Set(), // collapsed agenda sections
};

const URL_KEYS = [...Object.keys(VARIANTS), "fold", "file", "view", "focus", "group", "editing"];

export function readUrl() {
  const p = new URLSearchParams(location.search);
  for (const k of URL_KEYS) {
    const v = p.get(k);
    if (v == null) continue;
    if (VARIANTS[k] && !VARIANTS[k].includes(v)) continue;
    if (k === "fold" && !FOLDS.includes(v)) continue;
    state[k] = k === "editing" ? v === "1" : v;
  }
  if (p.get("harness") === "0") state.harness = false;
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
  if (!state.harness) p.set("harness", "0");
  const url = `${location.pathname}?${p.toString().replace(/%2F/g, "/")}`;
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
