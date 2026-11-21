// The file view. O1 document, O2 outliner and O3 cards share one DOM shape and differ in CSS;
// O4 navigator is a drill-down (phone) / master-detail (wide) view of the same tree.
//
// Folding mirrors Org's Shift-Tab: a file-wide depth (sections / tasks / all), and a tap on any
// heading opens or closes that heading alone, on top of the file-wide depth.

import { h, icon, inline, blocks, stateMark, prioMark, tagList, planningChips, signal, crumbs } from "./ui.js";
import { countSubtree } from "./org.js";
import { plainText } from "./inline.js";
import { state, update, overridesFor, actions } from "./state.js";

const charterOpen = new Set();
const countCache = new WeakMap();
const countsOf = (hd) => {
  if (!countCache.has(hd)) countCache.set(hd, countSubtree(hd.children));
  return countCache.get(hd);
};

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
  // Children are built on first show: a 1,000-line file opens without building every body.
  if (!kidsHidden && hasKids && !el._kidsBuilt) buildKids(el, hd, ov);
  if (!bodyHidden && hasBody && !el._bodyBuilt) buildBody(el, hd);
}

function toggle(el, hd, file) {
  const ov = overridesFor(file.path);
  const hasBody = hd.blocks.length > 0;
  const hasKids = hd.children.length > 0;
  if (!hasBody && !hasKids) return;
  const e = effective(hd, ov);
  const fullyOpen = (!hasBody || e.body) && (!hasKids || e.kids);
  ov.set(hd.id, fullyOpen ? "shut" : "open");
  applyFold(el, hd, ov);
}

// ---------------------------------------------------------------- nodes

function firstLine(hd) {
  for (const b of hd.blocks) {
    if (b.type === "para") return plainText(b.lines.join(" "));
    if (b.type === "list") return plainText(b.items.map((i) => i.text).join(" · "));
  }
  return "";
}

function headEl(hd, model, file, el) {
  const task = !!hd.state;
  const hasBody = hd.blocks.length > 0;
  const hasKids = hd.children.length > 0;
  const tIcon = task ? model.taskIcon(hd) : null;
  return h(
    "div",
    {
      class: "head",
      onclick: (e) => {
        if (e.target.closest("a")) return;
        toggle(el, hd, file);
      },
    },
    h("span", { class: "chev" }, hasBody || hasKids ? icon("chevron_right") : null),
    h("span", { class: "slot" }, task ? stateMark(hd.state) : h("i", { class: "bullet" })),
    hd.priority ? h("span", { class: "slot" }, prioMark(hd.priority)) : null,
    tIcon ? h("span", { class: "slot ticon" }, icon(tIcon)) : null,
    h(
      "span",
      { class: "title" },
      inline(hd.title),
      planningChips(hd.planning),
      tagList(hd.tags),
      hasBody ? icon("notes", "more") : null,
      !task && hasKids ? h("span", { class: "count" }, signal(countsOf(hd), { total: true })) : null,
    ),
  );
}

function buildBody(el, hd) {
  el._bodyBuilt = true;
  el.querySelector(":scope > .body").append(blocks(hd.blocks));
}

function buildKids(el, hd, ov) {
  el._kidsBuilt = true;
  const box = el.querySelector(":scope > .kids");
  for (const c of hd.children) box.append(nodeEl(c, el._model, el._file, ov));
}

function nodeEl(hd, model, file, ov) {
  const task = !!hd.state;
  const el = h("section", {
    class: `node lvl-${Math.min(hd.level, 5)} ${task ? "task" : "sect"}${hd.blocks.length ? " has-body" : ""}${hd.children.length ? " has-kids" : " leaf"}`,
    "data-id": hd.id,
    "data-s": hd.state || null,
  });
  el._model = model;
  el._file = file;
  el.append(headEl(hd, model, file, el));
  if (hd.blocks.length) el.append(h("div", { class: "preview" }, firstLine(hd)));
  el.append(h("div", { class: "body" }));
  el.append(h("div", { class: "kids" }));
  applyFold(el, hd, ov);
  return el;
}

function docHead(file) {
  const open = charterOpen.has(file.path);
  const charter = file.doc.preamble.length
    ? h(
        "div",
        { class: `charter${open ? " open" : ""}` },
        h("div", { class: "charter-body" }, blocks(file.doc.preamble)),
        h(
          "button",
          {
            class: "charter-toggle",
            onclick: (e) => {
              const box = e.currentTarget.parentElement;
              box.classList.toggle("open");
              if (box.classList.contains("open")) charterOpen.add(file.path);
              else charterOpen.delete(file.path);
              e.currentTarget.textContent = box.classList.contains("open") ? "Show less" : "About this file";
            },
          },
          open ? "Show less" : "About this file",
        ),
      )
    : null;
  return h(
    "header",
    { class: "doc-head" },
    h("div", { class: "doc-icon" }, icon(file.icon)),
    h("h1", null, file.title),
    file.subtitle ? h("p", { class: "subtitle" }, inline(file.subtitle)) : null,
    h("p", { class: "doc-stats" }, signal(file.counts, { total: true }), h("span", null, file.path)),
    charter,
  );
}

export function renderOutline(model, file, width) {
  if (state.outline === "navigator") return renderNavigator(model, file, width);
  const ov = overridesFor(file.path);
  const root = h("article", { class: `doc o-${state.outline} fold-${state.fold}`, "data-path": file.path });
  root.append(docHead(file));
  const list = h("div", { class: "nodes" });
  for (const hd of file.doc.children) list.append(nodeEl(hd, model, file, ov));
  if (!file.doc.children.length) list.append(h("p", { class: "empty" }, "No headings in this file yet."));
  root.append(list);
  return root;
}

// ---------------------------------------------------------------- toolbar, breadcrumb, contents

export function foldControl() {
  if (state.outline === "navigator") return null;
  const labels = { overview: "Sections", tasks: "Tasks", all: "All" };
  return h(
    "div",
    { class: "seg fold", role: "group", "aria-label": "Fold depth" },
    Object.entries(labels).map(([k, v]) =>
      h(
        "button",
        {
          class: state.fold === k ? "on" : "",
          onclick: () => {
            state.overrides.delete(state.file);
            update({ fold: k });
          },
        },
        v,
      ),
    ),
  );
}

export function contentsButton() {
  if (state.outline === "navigator") return null;
  return h("button", { class: "btn icon-btn", title: "Contents", "aria-label": "Contents", onclick: () => update({ sheet: "contents" }) }, icon("toc"));
}

/** Keep `crumbEl` showing the section the reader is in. */
export function trackSection(scrollEl, crumbEl, model, file) {
  let raf = 0;
  const run = () => {
    raf = 0;
    const top = scrollEl.getBoundingClientRect().top + 8;
    const heads = scrollEl.querySelectorAll(".node.sect.lvl-1 > .head, .node.sect.lvl-2 > .head, .node.sect.lvl-3 > .head");
    let current = null;
    for (const hEl of heads) {
      const r = hEl.getBoundingClientRect();
      if (!r.height) continue;
      if (r.top <= top) current = hEl.parentElement;
      else break;
    }
    crumbEl.replaceChildren();
    if (!current) {
      crumbEl.append(h("span", { class: "cr-file" }, icon(file.icon), file.title));
      return;
    }
    const hd = model.headingById.get(current.dataset.id).heading;
    crumbEl.append(crumbs({ path: [...hd.path, hd] }, { file }));
  };
  scrollEl.addEventListener("scroll", () => (raf ||= requestAnimationFrame(run)), { passive: true });
  run();
}

export function renderContents(model, file) {
  const rows = [];
  const add = (hd) => {
    rows.push(
      h(
        "button",
        {
          class: `toc-row lvl-${hd.level}${hd.state ? " task" : ""}`,
          onclick: () => {
            update({ sheet: null });
            requestAnimationFrame(() => reveal(hd.id));
          },
        },
        hd.state ? stateMark(hd.state) : null,
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
  const entry = actionsModel()?.headingById.get(id);
  if (!entry) return;
  const { heading: hd, file } = entry;
  if (state.outline === "navigator") {
    const parent = hd.path[hd.path.length - 1];
    update({ nav: hd.children.length ? hd.id : parent ? parent.id : null, task: hd.children.length ? null : hd.id });
    return;
  }
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

let modelRef = null;
export const setOutlineModel = (m) => (modelRef = m);
const actionsModel = () => modelRef;

// ---------------------------------------------------------------- O4 navigator

function navRow(model, file, hd) {
  const task = !!hd.state;
  const hasKids = hd.children.length > 0;
  const tIcon = task ? model.taskIcon(hd) : null;
  const preview = firstLine(hd);
  return h(
    "button",
    {
      class: `nav-row${task ? " task" : " sect"}${state.task === hd.id ? " on" : ""}`,
      "data-id": hd.id,
      onclick: () => (hasKids ? update({ nav: hd.id, task: null }) : update({ task: hd.id })),
    },
    h("span", { class: "slot" }, task ? stateMark(hd.state) : h("i", { class: "bullet" })),
    h(
      "span",
      { class: "nav-txt" },
      h(
        "span",
        { class: "nav-title" },
        hd.priority ? prioMark(hd.priority) : null,
        tIcon ? icon(tIcon, "ticon") : null,
        inline(hd.title),
        planningChips(hd.planning),
        tagList(hd.tags),
      ),
      preview ? h("span", { class: "nav-prev" }, preview) : null,
    ),
    hasKids ? h("span", { class: "nav-side" }, signal(countsOf(hd), { total: true }), icon("chevron_right")) : null,
  );
}

export function taskDetail(model, hd, file, { back } = {}) {
  const tIcon = hd.state ? model.taskIcon(hd) : null;
  return h(
    "article",
    { class: "detail" },
    back ? h("button", { class: "btn back", onclick: back }, icon("chevron_left"), "Back") : null,
    h("div", { class: "detail-crumbs" }, crumbs(hd, { file })),
    h(
      "h2",
      null,
      hd.state ? stateMark(hd.state) : null,
      prioMark(hd.priority),
      tIcon ? icon(tIcon, "ticon") : null,
      h("span", null, inline(hd.title)),
    ),
    h("div", { class: "detail-meta" }, planningChips(hd.planning), tagList(hd.tags)),
    hd.blocks.length ? h("div", { class: "detail-body" }, blocks(hd.blocks)) : h("p", { class: "empty" }, "No notes on this task."),
    hd.children.length
      ? h("div", { class: "detail-kids" }, hd.children.map((c) => navRow(model, file, c)))
      : null,
  );
}

function renderNavigator(model, file, width) {
  const wide = width >= 760;
  const cur = state.nav ? model.headingById.get(state.nav)?.heading : null;
  const valid = cur && model.headingById.get(state.nav).file === file;
  const node = valid ? cur : null;
  const list = node ? node.children : file.doc.children;
  const taskEntry = state.task ? model.headingById.get(state.task) : null;
  const task = taskEntry && taskEntry.file === file ? taskEntry.heading : null;

  const trail = h("div", { class: "nav-crumbs" });
  trail.append(h("button", { class: "crumb-btn", onclick: () => update({ nav: null, task: null }) }, icon(file.icon), file.name));
  if (node)
    for (const p of [...node.path, node]) {
      trail.append(h("span", { class: "sep" }, "›"));
      trail.append(h("button", { class: "crumb-btn", onclick: () => update({ nav: p.id, task: null }) }, inline(p.title)));
    }

  const listEl = h(
    "div",
    { class: "nav-list" },
    trail,
    node ? null : docHead(file),
    node && node.blocks.length ? h("div", { class: "nav-intro" }, blocks(node.blocks)) : null,
    list.map((c) => navRow(model, file, c)),
  );

  if (wide) {
    return h(
      "div",
      { class: "nav nav-wide" },
      listEl,
      h("div", { class: "nav-detail", "data-scroll": "navdetail" }, task ? taskDetail(model, task, file) : h("div", { class: "nav-empty" }, icon("touch_app"), "Choose a task to read it here.")),
    );
  }
  if (task) return h("div", { class: "nav" }, taskDetail(model, task, file, { back: () => update({ task: null }) }));
  return h("div", { class: "nav" }, listEl);
}

export { actions };
