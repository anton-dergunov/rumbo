// One state object for the whole prototype. Variant keys and the open file live in the URL so any
// combination can be bookmarked or screenshotted; fold overrides and expanded rows stay in memory.

export const VARIANTS = {
  frame: ["none", "ipad11p", "ipad11l", "minip", "minil", "phone"],
  theme: ["paper", "slate", "dusk", "night"],
  shell: ["panes", "tabs", "home"],
  outline: ["indent", "guides"],
  marks: ["shapes", "labels"],
  icons: ["right", "off"],
  data: ["real", "sample"],
};

export const LABELS = {
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
  shell: "panes",
  outline: "indent",
  marks: "shapes",
  icons: "right",
  data: "real",
  fold: "tasks",
  file: null, // vault-relative path of the open file
  view: "agenda", // single-pane contexts: "agenda" | "files" | "file"
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

const URL_KEYS = [...Object.keys(VARIANTS), "fold", "file", "view", "focus", "group"];

export function readUrl() {
  const p = new URLSearchParams(location.search);
  for (const k of URL_KEYS) {
    const v = p.get(k);
    if (v == null) continue;
    if (VARIANTS[k] && !VARIANTS[k].includes(v)) continue;
    if (k === "fold" && !FOLDS.includes(v)) continue;
    state[k] = v;
  }
  if (p.get("harness") === "0") state.harness = false;
}

export function writeUrl() {
  const p = new URLSearchParams();
  for (const k of URL_KEYS) {
    const v = state[k];
    if (v == null || v === "") continue;
    p.set(k, v);
  }
  if (!state.harness) p.set("harness", "0");
  history.replaceState(null, "", `${location.pathname}?${p.toString().replace(/%2F/g, "/")}`);
}

let renderer = () => {};
export function setRenderer(fn) {
  renderer = fn;
}

export function update(patch = {}) {
  Object.assign(state, patch);
  writeUrl();
  renderer();
}

export function overridesFor(path) {
  if (!state.overrides.has(path)) state.overrides.set(path, new Map());
  return state.overrides.get(path);
}

// Actions are filled in by app.js; views call them without importing app.js (no cycles).
export const actions = {};
