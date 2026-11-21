// The file view: a reading page of the outline.
//
// Folding mirrors Org's Shift-Tab: a file-wide depth (sections / tasks / all), and a tap on any
// heading opens or closes that heading alone, on top of the file-wide depth. A section can also be
// focused (like org-narrow-to-subtree): the page then shows only that section, with a breadcrumb.

import { h, icon, inline, blocks, stateGlyph, prioMark, tagList, planningChips, signal } from "./ui.js";
import { countSubtree } from "./org.js";
import { state, update, overridesFor } from "./state.js";
import { openMenu, openStatePicker, openTaskDialog, openMovePicker, setStateOf, stateRow } from "./edit-ui.js";
import { edit, canUndo, undo } from "./edits.js";
import { attachGestures } from "./gestures.js";
import * as E from "./org-edit.js";

// Which way into editing is being tried (the harness switch `edit`), and whether edit mode is on.
const editMode = () => state.edit === "mode" && state.editing;
const actsVariant = () => state.edit === "open";

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
  // The "open row" variant: a task opened by a tap shows a slim row of actions under its notes.
  if (actsVariant() && hd.state) {
    const on = ov.get(hd.id) === "open";
    el.classList.toggle("acts-on", on);
    const box = el.querySelector(":scope > .acts");
    if (on && box && !box.childElementCount) box.append(actsRow(el._file, hd, el));
  }
}

function toggle(el, hd, path) {
  const ov = overridesFor(path);
  if (actsVariant() && hd.state) {
    // A tap opens the task with its action row, and the next tap closes it.
    ov.set(hd.id, ov.get(hd.id) === "open" ? "shut" : "open");
    applyFold(el, hd, ov);
    return;
  }
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
  // Task icons are shown in the agenda only; in a file the right margin holds just the priority.
  const focusBtn = !task && hasKids
    ? h(
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
      )
    : null;
  const editing = editMode();
  const marks = [task ? prioMark(hd.priority) : focusBtn];
  if (editing) {
    marks.push(
      h("button", { class: "more-btn", title: "Actions", "aria-label": "Actions", onclick: (e) => (e.stopPropagation(), openMenu(file, hd, { anchor: e.currentTarget })) }, icon("more_horiz")),
      h("span", { class: "handle", title: "Drag to move", "aria-label": "Drag to move" }, icon("drag_indicator")),
    );
  }
  const aside = marks.some(Boolean) ? h("span", { class: "aside" }, marks) : null;
  return h(
    "div",
    {
      class: "head",
      onclick: (e) => {
        if (e.target.closest("a, button, .handle")) return;
        if (editMode() && task) {
          // In edit mode a tap on the shape changes the state, and a tap on the task edits it.
          if (e.target.closest(".slot")) return openStatePicker(file, hd, e.target.closest(".slot"));
          return openTaskDialog({ file, hd });
        }
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
      // Shown only while the section is collapsed: tells the reader there is more inside.
      !task && hasKids ? h("span", { class: "folded", title: "Collapsed — tap to open" }, icon("expand_more", "fold-ic"), signal(countsOf(hd), { total: true }) || h("span", { class: "sg total" }, "more")) : null,
    ),
    aside,
  );
}

function buildKids(el, hd, ov) {
  el._kidsBuilt = true;
  const box = el.querySelector(":scope > .kids");
  for (const c of hd.children) box.append(nodeEl(c, el._file, ov, el._depth + 1));
  if (editMode() && !hd.state) box.append(addRow(el._file, hd));
}

// ---------------------------------------------------------------- editing pieces

const addRow = (file, hd) =>
  h("button", { class: "add-row", onclick: () => openTaskDialog({ file, ref: hd, where: "lastChild", kind: "task" }) }, icon("add"), h("span", null, "Add task"));

/** The "open row" variant's actions under an opened task: the states, A, edit, move, more. */
function actsRow(file, hd, el) {
  return h(
    "div",
    { class: "acts-row" },
    stateRow(hd.state, (s) => s !== hd.state && setStateOf(file, hd, s)),
    h(
      "div",
      { class: "acts-btns" },
      h("button", { class: `chip${hd.priority === "A" ? " on" : ""}`, title: "High priority", "aria-pressed": hd.priority === "A" ? "true" : "false", onclick: () => edit(file.path, hd.priority === "A" ? "Priority cleared" : "Marked high priority", { hd }, (l, d, r) => E.setPriority(l, r.hd, hd.priority === "A" ? null : "A")) }, h("span", { class: "prio", "data-p": "A" }, "A")),
      h("button", { class: "chip", onclick: () => openTaskDialog({ file, hd }) }, icon("edit"), "Edit"),
      h("button", { class: "chip", onclick: () => openMovePicker(file, hd) }, icon("drive_file_move"), "Move"),
      h("button", { class: "chip", title: "More", "aria-label": "More", onclick: (e) => openMenu(file, hd, { anchor: e.currentTarget }) }, icon("more_horiz")),
    ),
  );
}

/** Gesture hooks for this file: the menu, drops and swipe buttons. */
function gestureHooks(file) {
  const headingOf = (node) => model.headingById.get(node.dataset.id)?.heading || null;
  return {
    headingOf,
    menu: (hd, node, point) => hd && openMenu(file, hd, { point }),
    drop: (hd, t) => {
      if (!hd || !t.target || t.target === hd) return;
      edit(file.path, "Moved", { hd, t: t.target }, (l, d, r) => E.moveSubtree(l, r.hd, t.how === "into" ? { into: r.t, at: "first" } : { [t.how]: r.t }));
    },
    swipeActions: (hd, side) => {
      if (!hd) return [];
      const task = !!hd.state;
      if (side === "left") {
        return task
          ? [
              hd.state === "DONE"
                ? { icon: "undo", label: "To do", cls: "sw-todo", run: () => setStateOf(file, hd, "TODO") }
                : { icon: "check", label: "Done", cls: "sw-done", run: () => setStateOf(file, hd, "DONE") },
              { icon: "radio_button_checked", label: "State", cls: "sw-state", run: () => openStatePicker(file, hd, document.querySelector(`.node[data-id="${hd.id}"] > .head .slot`)) },
            ]
          : [{ icon: "add", label: "Task", cls: "sw-state", run: () => openTaskDialog({ file, ref: hd, where: "lastChild", kind: "task" }) }];
      }
      return [
        { icon: "more_horiz", label: "More", cls: "sw-more", run: () => openMenu(file, hd, { anchor: document.querySelector(`.node[data-id="${hd.id}"] > .head`) }) },
        { icon: "delete", label: "Delete", cls: "sw-del", run: () => (task ? edit(file.path, "Task deleted", { hd }, (l, d, r) => E.deleteSubtree(l, r.hd)) : openMenu(file, hd, {})) },
      ];
    },
  };
}

/** The header's way into edit mode (the "mode" variant only): a pencil, then Done and Undo. */
export function editToggle() {
  if (state.edit !== "mode") return null;
  if (!state.editing) return h("button", { class: "btn icon-btn edit-toggle", title: "Edit (E)", "aria-label": "Edit", onclick: () => update({ editing: true }) }, icon("edit"));
  return [
    h("button", { class: "btn icon-btn", title: "Undo (⌘Z)", "aria-label": "Undo", disabled: !canUndo() || null, onclick: () => undo() }, icon("undo")),
    h("button", { class: "btn done-btn", onclick: () => update({ editing: false }) }, "Done"),
  ];
}

function nodeEl(hd, file, ov, depth) {
  const task = !!hd.state;
  const el = h("section", {
    class: `node d-${Math.min(depth, 5)} ${task ? "task" : "sect"}${hd.state === "DONE" ? " done" : ""}${hd.blocks.length ? " has-body" : ""}${hd.children.length ? " has-kids" : " leaf"}`,
    "data-id": hd.id,
  });
  el._file = file;
  el._depth = depth;
  el.append(headEl(hd, file, el), h("div", { class: "body" }));
  if (actsVariant() && task) el.append(h("div", { class: "acts" }));
  el.append(h("div", { class: "kids" }));
  // In edit mode an empty section still offers "Add task".
  if (editMode() && !task && !hd.children.length) {
    el._kidsBuilt = true;
    el.querySelector(":scope > .kids").append(addRow(file, hd));
  }
  applyFold(el, hd, ov);
  return el;
}

export function focusedHeading(file) {
  const entry = state.focus && model.headingById.get(state.focus);
  return entry && entry.file === file ? entry.heading : null;
}

/**
 * The file's sections. The file name lives in the header bar, not on the page. A focused section
 * is drawn as an ordinary top-level section with its contents beneath it, so it looks exactly as it
 * does in the whole file.
 */
export function renderOutline(file) {
  const ov = overridesFor(file.path);
  const focus = focusedHeading(file);
  const root = h("article", { class: `doc fold-${state.fold}${focus ? " focused" : ""} g-${state.edit}${editMode() ? " editing" : ""}`, "data-path": file.path });
  const list = h("div", { class: "nodes" });
  if (focus) {
    if (!ov.has(focus.id)) ov.set(focus.id, "open");
    const el = nodeEl(focus, file, ov, 1);
    el.classList.add("focus-root");
    list.append(el);
  } else {
    for (const hd of file.doc.children) list.append(nodeEl(hd, file, ov, 1));
    if (!file.doc.children.length) list.append(h("p", { class: "empty" }, "No headings in this file yet."));
  }
  root.append(list);
  if (editMode()) {
    list.append(
      focus
        ? h("button", { class: "add-row add-sect", onclick: () => openTaskDialog({ file, ref: focus, where: "lastChild", kind: "section" }) }, icon("add"), h("span", null, "Add subsection"))
        : h("button", { class: "add-row add-sect", onclick: () => openTaskDialog({ file, ref: null, where: "end", kind: "section" }) }, icon("add"), h("span", null, "Add section")),
    );
  }
  attachGestures(root, gestureHooks(file));
  return root;
}

// ---------------------------------------------------------------- toolbar, breadcrumb, contents

const FOLD_LABELS = { overview: "Sections", tasks: "Tasks", all: "All" };
const FOLD_ICONS = { overview: "unfold_less_double", tasks: "unfold_less", all: "unfold_more" };

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
      { class: "btn icon-btn fold-cycle", title: `Fold depth: ${FOLD_LABELS[state.fold]}`, "aria-label": `Fold depth: ${FOLD_LABELS[state.fold]}`, onclick: () => setFold(order[(order.indexOf(state.fold) + 1) % order.length]) },
      icon(FOLD_ICONS[state.fold]),
    ),
  ];
}

export function contentsButton() {
  return h("button", { class: "btn icon-btn", title: "Contents", "aria-label": "Contents", onclick: () => update({ sheet: "contents" }) }, icon("list_alt"));
}

/** Go to a level of the file: null = the whole file, else focus on that section. */
export function goTo(id) {
  if (id === state.focus) {
    document.querySelector(".file-pane .pane-scroll")?.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  update({ focus: id });
}

/** The header breadcrumb: the file, then the focused section's path. It does not follow scrolling. */
export function crumbTrail(file, hd) {
  const out = h("div", { class: "crumbs" });
  out.append(h("button", { class: "cr-file", onclick: () => goTo(null) }, icon(file.icon), h("span", { class: "t" }, file.title)));
  for (const p of hd ? [...hd.path, hd] : []) {
    out.append(h("span", { class: "sep" }, "›"), h("button", { class: "cr", onclick: () => goTo(p.id) }, inline(p.title)));
  }
  return out;
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
