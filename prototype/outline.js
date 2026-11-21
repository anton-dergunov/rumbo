// The file view: a reading page of the outline.
//
// Folding mirrors Org's Shift-Tab: a file-wide depth (sections / tasks / all), and a tap on any
// heading opens or closes that heading alone, on top of the file-wide depth. A section can also be
// focused (like org-narrow-to-subtree): the page then shows only that section, with a breadcrumb.

import { h, icon, inline, blocks, stateGlyph, prioMark, tagList, planningChips, signal } from "./ui.js";
import { countSubtree } from "./org.js";
import { state, update, overridesFor } from "./state.js";

const countCache = new WeakMap();
const countsOf = (hd) => {
  if (!countCache.has(hd)) countCache.set(hd, countSubtree(hd.children));
  return countCache.get(hd);
};

let model = null;
export const setOutlineModel = (m) => (model = m);

// ---------------------------------------------------------------- folding

function effective(hd, ov) {
  const o = ov.get(hd.id);
  const fold = state.fold;
  const base = fold === "overview" ? { body: false, kids: false } : fold === "tasks" ? { body: false, kids: true } : { body: true, kids: true };
  if (o === "open") return { body: true, kids: true };
  if (o === "shut") return { body: false, kids: false };
  if (o === "kids") return { body: base.body, kids: true };
  return base;
}

function applyFold(el, hd, ov) {
  const hasBody = hd.blocks.length > 0;
  const hasKids = hd.children.length > 0;
  const e = effective(hd, ov);
  const bodyHidden = hasBody && !e.body;
  const kidsHidden = hasKids && !e.kids;
  el.classList.toggle("body-hidden", bodyHidden);
  el.classList.toggle("kids-hidden", kidsHidden);
  el.classList.toggle("collapsed", bodyHidden || kidsHidden);
  // Built on first show, so a 1,000-line file opens without building every body.
  if (!kidsHidden && hasKids && !el._kidsBuilt) buildKids(el, hd, ov);
  if (!bodyHidden && hasBody && !el._bodyBuilt) {
    el._bodyBuilt = true;
    el.querySelector(":scope > .body").append(blocks(hd.blocks));
  }
}

function toggle(el, hd, path) {
  const ov = overridesFor(path);
  const hasBody = hd.blocks.length > 0;
  const hasKids = hd.children.length > 0;
  if (!hasBody && !hasKids) return;
  const e = effective(hd, ov);
  const fullyOpen = (!hasBody || e.body) && (!hasKids || e.kids);
  ov.set(hd.id, fullyOpen ? "shut" : "open");
  applyFold(el, hd, ov);
}

// ---------------------------------------------------------------- nodes

function headEl(hd, file, el) {
  const task = !!hd.state;
  const hasBody = hd.blocks.length > 0;
  const hasKids = hd.children.length > 0;
  const tIcon = task ? model.taskIcon(hd) : null;
  const aside = task
    ? h("span", { class: "aside" }, prioMark(hd.priority), h("span", { class: "ticon" }, tIcon ? icon(tIcon) : null))
    : hasKids
      ? h(
          "span",
          { class: "aside" },
          h(
            "button",
            {
              class: "focus-btn",
              title: "Focus on this section",
              "aria-label": "Focus on this section",
              onclick: (e) => {
                e.stopPropagation();
                update({ focus: hd.id });
              },
            },
            icon("chevron_right"),
          ),
        )
      : null;
  return h(
    "div",
    {
      class: "head",
      onclick: (e) => {
        if (e.target.closest("a, button")) return;
        toggle(el, hd, file.path);
      },
    },
    task ? h("span", { class: "slot" }, stateGlyph(hd.state)) : null,
    h(
      "span",
      { class: "title" },
      inline(hd.title),
      planningChips(hd.planning),
      tagList(hd.tags),
      hasBody ? icon("notes", "more") : null,
      !task && hasKids ? h("span", { class: "count" }, signal(countsOf(hd), { total: true })) : null,
    ),
    aside,
  );
}

function buildKids(el, hd, ov) {
  el._kidsBuilt = true;
  const box = el.querySelector(":scope > .kids");
  for (const c of hd.children) box.append(nodeEl(c, el._file, ov, el._depth + 1));
}

function nodeEl(hd, file, ov, depth) {
  const task = !!hd.state;
  const el = h("section", {
    class: `node d-${Math.min(depth, 5)} ${task ? "task" : "sect"}${hd.blocks.length ? " has-body" : ""}${hd.children.length ? " has-kids" : " leaf"}`,
    "data-id": hd.id,
  });
  el._file = file;
  el._depth = depth;
  el.append(headEl(hd, file, el), h("div", { class: "body" }), h("div", { class: "kids" }));
  applyFold(el, hd, ov);
  return el;
}

function fileTitle(file) {
  return h("header", { class: "doc-head" }, h("h1", null, icon(file.icon, "doc-icon"), h("span", null, file.title)));
}

function focusTitle(file, hd) {
  const trail = h("nav", { class: "focus-trail" });
  trail.append(h("button", { class: "crumb-btn", onclick: () => update({ focus: null }) }, icon(file.icon), file.title));
  for (const p of hd.path) {
    trail.append(h("span", { class: "sep" }, "›"));
    trail.append(h("button", { class: "crumb-btn", onclick: () => update({ focus: p.id }) }, inline(p.title)));
  }
  return h(
    "header",
    { class: "doc-head focus-head" },
    trail,
    h("h1", null, hd.state ? stateGlyph(hd.state) : null, h("span", null, inline(hd.title))),
    hd.blocks.length ? h("div", { class: "focus-intro" }, blocks(hd.blocks)) : null,
  );
}

export function focusedHeading(file) {
  const entry = state.focus && model.headingById.get(state.focus);
  return entry && entry.file === file ? entry.heading : null;
}

export function renderOutline(file) {
  const ov = overridesFor(file.path);
  const focus = focusedHeading(file);
  const root = h("article", { class: `doc fold-${state.fold}`, "data-path": file.path });
  root.append(focus ? focusTitle(file, focus) : fileTitle(file));
  const list = h("div", { class: "nodes" });
  const top = focus ? focus.children : file.doc.children;
  for (const hd of top) list.append(nodeEl(hd, file, ov, 1));
  if (!top.length) list.append(h("p", { class: "empty" }, focus ? "Nothing under this heading." : "No headings in this file yet."));
  root.append(list);
  return root;
}

// ---------------------------------------------------------------- toolbar, breadcrumb, contents

const FOLD_LABELS = { overview: "Sections", tasks: "Tasks", all: "All" };
const FOLD_ICONS = { overview: "unfold_less", tasks: "format_list_bulleted", all: "unfold_more" };

function setFold(k) {
  state.overrides.delete(state.file);
  update({ fold: k });
}

/** Fold depth: a three-way control, or on a phone one button that cycles through the three. */
export function foldControl() {
  const order = Object.keys(FOLD_LABELS);
  return [
    h(
      "div",
      { class: "seg fold", role: "group", "aria-label": "Fold depth" },
      order.map((k) => h("button", { class: state.fold === k ? "on" : "", onclick: () => setFold(k) }, FOLD_LABELS[k])),
    ),
    h(
      "button",
      { class: "btn fold-cycle", title: "Fold depth", onclick: () => setFold(order[(order.indexOf(state.fold) + 1) % order.length]) },
      icon(FOLD_ICONS[state.fold]),
      FOLD_LABELS[state.fold],
    ),
  ];
}

export function contentsButton() {
  return h("button", { class: "btn icon-btn", title: "Contents", "aria-label": "Contents", onclick: () => update({ sheet: "contents" }) }, icon("toc"));
}

/** Go to a level of the file: null = the whole file, else focus on that section. */
export function goTo(id) {
  if (id === state.focus) {
    document.querySelector(".file-pane .pane-scroll")?.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  update({ focus: id });
}

/** One level up from the focused section (to the whole file at the top). */
export function goUp() {
  const entry = state.focus && model.headingById.get(state.focus);
  if (!entry) return;
  const parent = entry.heading.path[entry.heading.path.length - 1];
  update({ focus: parent ? parent.id : null });
}

function crumbTrail(file, hd) {
  const out = h("div", { class: "crumbs" });
  out.append(h("button", { class: "cr-file", onclick: () => goTo(null) }, icon(file.icon), h("span", { class: "t" }, file.title)));
  for (const p of hd ? [...hd.path, hd] : []) {
    out.append(h("span", { class: "sep" }, "›"), h("button", { class: "cr", onclick: () => goTo(p.id) }, inline(p.title)));
  }
  return out;
}

/** Keep `crumbEl` showing where the reader is: the file, the focused section, then the section in view. */
export function trackSection(scrollEl, crumbEl, file) {
  let raf = 0;
  let last = "";
  const run = () => {
    raf = 0;
    const top = scrollEl.getBoundingClientRect().top + 8;
    const heads = scrollEl.querySelectorAll(".node.sect.d-1 > .head, .node.sect.d-2 > .head, .node.sect.d-3 > .head");
    let current = null;
    for (const hEl of heads) {
      const r = hEl.getBoundingClientRect();
      if (!r.height) continue;
      if (r.top <= top) current = hEl.parentElement;
      else break;
    }
    const hd = current ? model.headingById.get(current.dataset.id).heading : focusedHeading(file);
    const key = hd ? hd.id : "";
    if (key === last && crumbEl.firstChild) return;
    last = key;
    crumbEl.replaceChildren(crumbTrail(file, hd));
  };
  scrollEl.addEventListener("scroll", () => (raf ||= requestAnimationFrame(run)), { passive: true });
  run();
}

export function renderContents(file) {
  const rows = [];
  const add = (hd) => {
    rows.push(
      h(
        "button",
        {
          class: `toc-row lvl-${hd.level}${hd.state ? " task" : ""}`,
          onclick: () => {
            update({ sheet: null, focus: null });
            requestAnimationFrame(() => reveal(hd.id));
          },
        },
        hd.state ? stateGlyph(hd.state) : null,
        h("span", { class: "toc-title" }, inline(hd.title)),
        hd.children.length ? signal(countsOf(hd), { total: true }) : null,
      ),
    );
  };
  for (const s of file.doc.children) {
    add(s);
    for (const c of s.children) if (!c.state || s.children.length <= 12) add(c);
  }
  return h(
    "div",
    { class: "sheet contents" },
    h("div", { class: "sheet-head" }, h("strong", null, "Contents"), h("span", { class: "muted" }, file.title), closeBtn()),
    h("div", { class: "sheet-body" }, rows.length ? rows : h("p", { class: "empty" }, "No headings.")),
  );
}

export const closeBtn = () => h("button", { class: "btn icon-btn", "aria-label": "Close", onclick: () => update({ sheet: null, drawer: false }) }, icon("close"));

/** Open the ancestors of a heading, open the heading itself, scroll it into view and flash it. */
export function reveal(id) {
  const entry = model?.headingById.get(id);
  if (!entry) return;
  const { heading: hd, file } = entry;
  const ov = overridesFor(file.path);
  for (const anc of hd.path) {
    const el = document.querySelector(`.node[data-id="${anc.id}"]`);
    if (!el) continue;
    if (!effective(anc, ov).kids) {
      ov.set(anc.id, "kids");
      applyFold(el, anc, ov);
    }
  }
  const el = document.querySelector(`.node[data-id="${id}"]`);
  if (!el) return;
  if (hd.blocks.length && !effective(hd, ov).body) {
    ov.set(hd.id, "open");
    applyFold(el, hd, ov);
  }
  el.scrollIntoView({ block: "start" });
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}
