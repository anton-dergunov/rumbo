// Entry point: load the vault, wire actions, and redraw on every state change.

import { state, readUrl, setRenderer, update, actions, FRAMES } from "./state.js";
import { loadVault } from "./data.js";
import { setModel, h } from "./ui.js";
import { setOutlineModel, reveal } from "./outline.js";
import { renderShell, sizeClass } from "./shell.js";
import { renderHarness } from "./harness.js";

const viewport = document.getElementById("viewport");
const models = new Map();
let model = null;
let loading = null;

function viewportWidth() {
  return FRAMES[state.frame] ? FRAMES[state.frame][0] : window.innerWidth;
}

function applyFrame() {
  const f = FRAMES[state.frame];
  document.body.classList.toggle("framed", !!f);
  if (f) {
    const [w, hgt] = f;
    const scale = Math.min(1, (window.innerWidth - 40) / (w + 20), (window.innerHeight - 90) / (hgt + 20));
    viewport.style.setProperty("--fw", `${w}px`);
    viewport.style.setProperty("--fh", `${hgt}px`);
    viewport.style.setProperty("--fscale", scale.toFixed(3));
  }
  document.documentElement.dataset.theme = state.theme;
  const dark = state.theme === "dusk" || state.theme === "night";
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || (dark ? "#000" : "#fff");
  viewport.className = `marks-${state.marks} outline-${state.outline} icons-${state.icons}`;
}

function pickDefaultFile() {
  if (state.file && model.byPath.has(state.file)) return;
  const pref = ["ML/Ranking.org", "ML/ML.org"].find((p) => model.byPath.has(p));
  state.file = pref || (model.files.find((f) => f.counts.NEXT) || model.files[0])?.path || null;
}

async function ensureModel() {
  if (models.has(state.data)) {
    model = models.get(state.data);
    return true;
  }
  if (loading) return false;
  loading = loadVault(state.data)
    .then((m) => {
      models.set(state.data, m);
      loading = null;
      render();
    })
    .catch((err) => {
      loading = null;
      viewport.replaceChildren(h("div", { class: "loading error" }, `Could not load the vault: ${err.message}`));
    });
  viewport.replaceChildren(h("div", { class: "loading" }, "Reading the vault…"));
  return false;
}

function render() {
  applyFrame();
  renderHarness();
  if (!models.has(state.data)) {
    ensureModel();
    return;
  }
  model = models.get(state.data);
  setModel(model);
  setOutlineModel(model);
  pickDefaultFile();

  // Keep scroll positions across redraws (each scroller names itself with data-scroll).
  const scrolls = new Map();
  for (const el of viewport.querySelectorAll("[data-scroll]")) scrolls.set(el.dataset.scroll, el.scrollTop);
  const width = viewportWidth();
  viewport.dataset.size = sizeClass(width);
  viewport.replaceChildren(renderShell(model, width));
  for (const el of viewport.querySelectorAll("[data-scroll]")) {
    if (scrolls.has(el.dataset.scroll)) el.scrollTop = scrolls.get(el.dataset.scroll);
  }
}

actions.openFile = (path) => {
  const narrow = ["phone", "portrait"].includes(sizeClass(viewportWidth()));
  const patch = { file: path, focus: null, drawer: false, sheet: null };
  if (state.shell === "home" || state.shell === "tabs" || narrow) patch.view = "file";
  update(patch);
};

actions.openHeading = (path, id) => {
  actions.openFile(path);
  requestAnimationFrame(() => requestAnimationFrame(() => reveal(id)));
};

readUrl();
if (window.innerWidth < 700 && state.frame === "none" && !new URLSearchParams(location.search).has("harness")) state.harness = false;
setRenderer(render);
let resizeRaf = 0;
window.addEventListener("resize", () => (resizeRaf ||= requestAnimationFrame(() => ((resizeRaf = 0), render()))));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && (state.sheet || state.drawer)) update({ sheet: null, drawer: false });
  if (e.key === "Tab" && e.shiftKey) {
    e.preventDefault();
    const order = ["overview", "tasks", "all"];
    state.overrides.delete(state.file);
    update({ fold: order[(order.indexOf(state.fold) + 1) % order.length] });
  }
});
update();
