// The editing surfaces: action menu, state row, tag and date pickers, the task dialog, the move
// picker, the confirm box and the toast. They live in a layer of their own beside the app, which the
// app's redraws never touch, so a dialog keeps its text, focus and keyboard while the page under it
// redraws after a save.

import { h, icon, inline, stateGlyph, STATE_NAMES, relDay, append } from "./ui.js";
import { state, update, actions } from "./state.js";
import { countSubtree } from "./org.js";
import * as E from "./org-edit.js";
import { edit, editTwo, onNotice, readOnlyReason } from "./edits.js";
import { makeOp, keyOf, targetArg } from "./ops.js";

const STATES = ["TODO", "NEXT", "INPR", "WAIT", "MAYB", "DONE"];
const STATE_LABEL = { TODO: "To do", NEXT: "Next", INPR: "Doing", WAIT: "Waiting", MAYB: "Maybe", DONE: "Done" };

/** replaceChildren, but skipping null and false as h() does (replaceChildren would print "null"). */
const fill = (el, ...kids) => {
  el.replaceChildren();
  return append(el, kids);
};

let layer = null;
let model = null;
const stack = []; // open popovers, top last

export function setEditUiModel(m) {
  model = m;
}

/** The layer sits in the viewport beside the app root; created once. */
export function mountLayer(viewport) {
  layer = h("div", { id: "edit-layer" });
  viewport.append(layer);
  onNotice(showNotice);
  window.visualViewport?.addEventListener("resize", fitKeyboard);
  window.visualViewport?.addEventListener("scroll", fitKeyboard);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && stack.length) {
      e.preventDefault();
      e.stopImmediatePropagation();
      closeTop();
    }
  }, true);
  // A scroll of the page closes menus (not dialogs), so they never float over the wrong row.
  document.addEventListener("scroll", (e) => {
    if (e.target?.closest?.("#edit-layer")) return;
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].kind !== "dialog") stack[i].close();
  }, true);
  return layer;
}

export function setLayerSize(size) {
  if (layer) layer.dataset.size = size;
}

/**
 * Keep dialogs inside the part of the screen the on-screen keyboard leaves visible (after carrel's
 * screen.js): the visible height and offset go into CSS variables the dialog sizes against.
 */
function fitKeyboard() {
  const vv = window.visualViewport;
  if (!vv || !layer || document.body.classList.contains("framed")) return;
  layer.style.setProperty("--vv-h", `${vv.height}px`);
  layer.style.setProperty("--vv-top", `${vv.offsetTop}px`);
}

const isPhone = () => layer?.dataset.size === "phone";

/** An element's box in the viewport's own coordinates (the device frame may be scaled). */
export function localRect(el) {
  const vp = layer.parentElement;
  const v = vp.getBoundingClientRect();
  const s = v.width / vp.offsetWidth || 1;
  const r = el.getBoundingClientRect();
  return { left: (r.left - v.left) / s, top: (r.top - v.top) / s, right: (r.right - v.left) / s, bottom: (r.bottom - v.top) / s, width: r.width / s, height: r.height / s };
}
export function localPoint(x, y) {
  const vp = layer.parentElement;
  const v = vp.getBoundingClientRect();
  const s = v.width / vp.offsetWidth || 1;
  return { x: (x - v.left) / s, y: (y - v.top) / s };
}

// ---------------------------------------------------------------- popover stack

/**
 * Open a panel over a backdrop. kind: "menu" (beside an anchor or a point; a bottom sheet on a
 * phone), "sheet" (a bottom sheet on a phone, a card beside the anchor elsewhere), "dialog" (a
 * centred card; full height on a phone).
 */
export function openPanel(content, { kind = "menu", anchor = null, point = null, onClose = null, label = "" } = {}) {
  const phone = isPhone();
  const shape = kind === "dialog" ? (phone ? "full" : "card") : phone ? "bottom" : "pop";
  const back = h("div", { class: `ed-back ed-${kind}` });
  const panel = h("div", { class: `ed-panel ed-${shape} ed-kind-${kind}`, role: kind === "menu" ? "menu" : "dialog", "aria-modal": kind === "dialog" ? "true" : null, "aria-label": label || null });
  panel.append(content);
  back.append(panel);
  const entry = {
    kind,
    panel,
    close: () => {
      const i = stack.indexOf(entry);
      if (i < 0) return;
      stack.splice(i, 1);
      back.remove();
      document.body.classList.toggle("ed-open", stack.length > 0);
      onClose?.();
    },
  };
  back.addEventListener("pointerdown", (e) => {
    if (e.target === back) entry.dismissing = true;
  });
  back.addEventListener("click", (e) => {
    if (e.target === back && entry.dismissing && kind !== "dialog") entry.close();
    entry.dismissing = false;
  });
  stack.push(entry);
  layer.append(back);
  // The prototype's toolbar floats over the bottom corner; it steps aside while a panel is open.
  document.body.classList.add("ed-open");
  if (shape === "pop") place(panel, anchor, point);
  fitKeyboard();
  return entry;
}

function place(panel, anchor, point) {
  const vw = layer.clientWidth;
  const vh = layer.clientHeight;
  const w = Math.min(panel.offsetWidth || 300, vw - 16);
  const hgt = panel.offsetHeight || 200;
  let x, y;
  if (point) {
    const p = localPoint(point.x, point.y);
    x = p.x;
    y = p.y + 4;
  } else if (anchor) {
    const r = localRect(anchor);
    x = r.right - w;
    y = r.bottom + 6;
    if (x < 8) x = r.left;
    if (y + hgt > vh - 8 && r.top - hgt - 6 > 8) y = r.top - hgt - 6;
  } else {
    x = (vw - w) / 2;
    y = (vh - hgt) / 3;
  }
  x = Math.max(8, Math.min(x, vw - w - 8));
  y = Math.max(8, Math.min(y, vh - hgt - 8));
  panel.style.left = `${x}px`;
  panel.style.top = `${y}px`;
}

export function closeTop() {
  stack[stack.length - 1]?.close();
}
export const closeAll = () => [...stack].reverse().forEach((e) => e.close());
export const panelOpen = () => stack.length > 0;

// ---------------------------------------------------------------- the toast

let toastEl = null;
let toastTimer = 0;
let toastHasAction = false;

function showNotice(n) {
  if (!layer) return;
  clearTimeout(toastTimer);
  toastEl?.remove();
  toastHasAction = !!n.action;
  toastEl = h(
    "div",
    { class: `toast t-${n.kind}`, role: "status", "aria-live": "polite" },
    h("span", { class: "t-text" }, n.text),
    n.action
      ? h(
          "button",
          {
            class: "t-act",
            onclick: () => {
              hideToast();
              n.action.run();
            },
          },
          n.action.label,
        )
      : null,
    n.sticky ? h("button", { class: "t-x", "aria-label": "Dismiss", onclick: hideToast }, icon("close")) : null,
  );
  layer.append(toastEl);
  if (!n.sticky) toastTimer = setTimeout(hideToast, n.action ? 6000 : 4000);
}

function hideToast() {
  clearTimeout(toastTimer);
  toastEl?.remove();
  toastEl = null;
  toastHasAction = false;
}

// ---------------------------------------------------------------- small pieces

const stateBtn = (s, on, pick) =>
  h(
    "button",
    { class: `st-btn${on ? " on" : ""}`, "data-s": s, "aria-pressed": on ? "true" : "false", title: STATE_NAMES[s], onclick: () => pick(s) },
    h("span", { class: "st-shape" }, stateGlyph(s)),
    h("span", { class: "st-name" }, STATE_LABEL[s]),
  );

export function stateRow(current, pick) {
  return h("div", { class: "st-row", role: "group", "aria-label": "State" }, STATES.map((s) => stateBtn(s, s === current, pick)));
}

const menuItem = (ic, label, run, { danger = false, disabled = false, note = "" } = {}) =>
  h(
    "button",
    { class: `mi${danger ? " danger" : ""}`, role: "menuitem", disabled: disabled || null, onclick: run },
    icon(ic),
    h("span", { class: "mi-label" }, label),
    note ? h("span", { class: "mi-note" }, note) : null,
  );

const panelHead = (title, sub, right = null) => h("div", { class: "ed-head" }, h("strong", null, title), sub ? h("span", { class: "ed-sub" }, sub) : h("span", { class: "ed-sub" }), right);

function fmtDate(stamp) {
  if (!stamp) return "";
  const d = new Date(`${stamp.date}T00:00:00`);
  return `${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}${stamp.time ? " " + stamp.time : ""}`;
}

const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);


// ---------------------------------------------------------------- one-tap edits

export function setStateOf(file, hd, s) {
  const label = s === "DONE" ? "Marked done" : `Marked ${STATE_LABEL[s].toLowerCase()}`;
  return edit(file.path, label, (d) => makeOp(d, "setState", hd, { state: s }));
}

const togglePriority = (file, hd) => edit(file.path, hd.priority === "A" ? "Priority cleared" : "Marked high priority", (d) => makeOp(d, "setPriority", hd, { priority: hd.priority === "A" ? null : "A" }));

function deleteHeading(file, hd) {
  const label = hd.state ? "Task deleted" : "Section deleted";
  edit(file.path, label, (d) => makeOp(d, "deleteSubtree", hd));
}

function askDeleteSection(file, hd) {
  const c = countSubtree(hd.children);
  const what = c.tasks ? `the section and its ${c.tasks} task${c.tasks === 1 ? "" : "s"}` : "the section";
  confirmBox(`Delete ${what}?`, `“${hd.title}” and everything under it is removed from ${file.title}. You can undo it right after.`, "Delete", () => deleteHeading(file, hd));
}

export function confirmBox(title, text, okLabel, ok) {
  const p = openPanel(
    h(
      "div",
      { class: "confirm" },
      h("strong", null, title),
      h("p", null, text),
      h(
        "div",
        { class: "ed-foot" },
        h("span", { class: "spacer" }),
        h("button", { class: "btn", onclick: () => p.close() }, "Cancel"),
        h(
          "button",
          {
            class: "btn danger solid",
            onclick: () => {
              p.close();
              ok();
            },
          },
          okLabel,
        ),
      ),
    ),
    { kind: "dialog", label: title },
  );
}

// ---------------------------------------------------------------- action menu

/** The menu for one heading: the six states first (one tap each), then everything else. */
export function openMenu(file, hd, { anchor = null, point = null } = {}) {
  closeAll();
  const why = readOnlyReason(file);
  if (why) return showNotice({ text: why, kind: "error" });
  const run = (fn) => () => {
    m.close();
    fn();
  };
  const task = !!hd.state;
  const doc = file.doc;
  const sib = E.siblingsOf(doc, hd);
  const i = sib.indexOf(hd);
  const body = h("div", { class: "menu" });
  body.append(h("div", { class: "menu-title" }, task ? stateGlyph(hd.state) : icon("segment"), h("span", null, inline(hd.title))));
  if (task) {
    body.append(stateRow(hd.state, (s) => (m.close(), s !== hd.state && setStateOf(file, hd, s))));
    body.append(
      h(
        "div",
        { class: "chip-row" },
        h("button", { class: `chip${hd.priority === "A" ? " on" : ""}`, "aria-pressed": hd.priority === "A" ? "true" : "false", onclick: run(() => togglePriority(file, hd)) }, h("span", { class: "prio", "data-p": "A" }, "A"), "Priority"),
        h("button", { class: "chip", onclick: run(() => openTagSheet(file, hd, anchor, point)) }, icon("sell"), hd.tags.length ? hd.tags.join(" ") : "Tags"),
        h("button", { class: "chip", onclick: run(() => openDateSheet(file, hd, "scheduled", anchor, point)) }, icon("event"), hd.planning.scheduled ? fmtDate(hd.planning.scheduled) : "Schedule"),
        h("button", { class: "chip", onclick: run(() => openDateSheet(file, hd, "deadline", anchor, point)) }, icon("flag"), hd.planning.deadline ? fmtDate(hd.planning.deadline) : "Deadline"),
      ),
    );
  }
  const items = h("div", { class: "mi-list" });
  items.append(menuItem("edit", task ? "Edit task…" : "Edit section…", run(() => openTaskDialog({ file, hd }))));
  if (task) {
    items.append(menuItem("add", "Add task below", run(() => openTaskDialog({ file, ref: hd, where: "after", kind: "task" }))));
  } else {
    items.append(menuItem("add_task", "Add task", run(() => openTaskDialog({ file, ref: hd, where: "lastChild", kind: "task" }))));
    items.append(menuItem("playlist_add", "Add section below", run(() => openTaskDialog({ file, ref: hd, where: "after", kind: "section" }))));
    items.append(menuItem("subdirectory_arrow_right", "Add subsection", run(() => openTaskDialog({ file, ref: hd, where: "lastChild", kind: "section" }))));
  }
  items.append(menuItem("drive_file_move", "Move…", run(() => openMovePicker(file, hd))));
  items.append(
    h(
      "div",
      { class: "mi-pair" },
      menuItem("arrow_upward", "Up", run(() => edit(file.path, "Moved up", (d) => makeOp(d, "moveUp", hd))), { disabled: i <= 0 }),
      menuItem("arrow_downward", "Down", run(() => edit(file.path, "Moved down", (d) => makeOp(d, "moveDown", hd))), { disabled: i >= sib.length - 1 }),
    ),
  );
  items.append(
    h(
      "div",
      { class: "mi-pair" },
      menuItem("format_indent_decrease", "Promote", run(() => edit(file.path, "Promoted", (d) => makeOp(d, "promote", hd))), { disabled: hd.level <= 1 }),
      menuItem("format_indent_increase", "Demote", run(() => edit(file.path, "Demoted", (d) => makeOp(d, "demote", hd))), { disabled: i <= 0 }),
    ),
  );
  if (!task) {
    const done = countSubtree(hd.children).DONE;
    if (done) items.append(menuItem("remove_done", "Remove done tasks", run(() => edit(file.path, `Removed ${done} done task${done === 1 ? "" : "s"}`, (d) => makeOp(d, "removeDone", null, { scope: keyOf(d, hd) }))), { note: String(done) }));
  }
  items.append(menuItem("delete", task ? "Delete task" : "Delete section…", run(() => (task ? deleteHeading(file, hd) : askDeleteSection(file, hd))), { danger: true }));
  body.append(items);
  const m = openPanel(body, { kind: "menu", anchor, point, label: hd.title });
  return m;
}

/** Just the state row, from a tap on the state shape in edit mode. */
export function openStatePicker(file, hd, anchor) {
  closeAll();
  const m = openPanel(h("div", { class: "menu state-pop" }, stateRow(hd.state, (s) => (m.close(), s !== hd.state && setStateOf(file, hd, s)))), { kind: "menu", anchor, label: "State" });
}

// ---------------------------------------------------------------- tags

/** Every tag the vault knows: workspace.org's vocabulary first, then any other tag in use. */
function tagVocabulary() {
  const used = new Map();
  for (const f of model.files) for (const hd of f.doc.headings) for (const t of hd.tags) used.set(t, (used.get(t) || 0) + 1);
  const known = Object.keys(model.ws.tags || {});
  const rest = [...used.keys()].filter((t) => !known.includes(t)).sort((a, b) => used.get(b) - used.get(a));
  return [...known, ...rest].map((t) => ({ tag: t, means: model.ws.tags?.[t]?.means || "", count: used.get(t) || 0 }));
}

/** Tag chips and a filtered list (after carrel's tag picker). `onChange(tags)` on every change. */
export function tagPicker(initial, onChange) {
  let tags = [...initial];
  const chips = h("div", { class: "tag-chips" });
  const list = h("div", { class: "tag-list", role: "listbox", "aria-multiselectable": "true" });
  const filter = h("input", { class: "field tag-filter", type: "search", placeholder: "Find or add a tag", autocapitalize: "none", autocomplete: "off", spellcheck: "false", enterkeyhint: "done" });
  const vocab = tagVocabulary();
  const set = (next) => {
    tags = next;
    onChange(tags);
    draw();
  };
  const toggle = (t) => set(tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t]);
  function draw() {
    fill(
      chips,
      ...(tags.length
        ? tags.map((t) => h("span", { class: "tag-chip" }, t, h("button", { "aria-label": `Remove ${t}`, onclick: () => toggle(t) }, icon("close"))))
        : [h("span", { class: "muted" }, "No tags")]),
    );
    const q = filter.value.trim().toLowerCase();
    const rows = vocab.filter((v) => !q || v.tag.toLowerCase().includes(q) || v.means.toLowerCase().includes(q));
    const name = q.replace(/[^\w@#%]/g, "");
    fill(
      list,
      ...rows.map((v) =>
        h(
          "button",
          { class: `tag-opt${tags.includes(v.tag) ? " on" : ""}`, role: "option", "aria-selected": tags.includes(v.tag) ? "true" : "false", onclick: () => toggle(v.tag) },
          icon(tags.includes(v.tag) ? "check_box" : "check_box_outline_blank"),
          h("span", { class: "tag-name" }, v.tag),
          h("span", { class: "tag-means" }, v.means || (v.count ? `${v.count} in use` : "")),
        ),
      ),
      name && !vocab.some((v) => v.tag.toLowerCase() === name) ? h("button", { class: "tag-opt new", onclick: () => ((filter.value = ""), toggle(name)) }, icon("add"), h("span", { class: "tag-name" }, `New tag “${name}”`), h("span", { class: "tag-means" }, "not in workspace.org")) : null,
    );
  }
  filter.addEventListener("input", draw);
  filter.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const first = list.querySelector(".tag-opt");
    if (first && filter.value.trim()) {
      first.click();
      filter.value = "";
      draw();
    }
  });
  draw();
  return h("div", { class: "tag-picker" }, chips, filter, list);
}

function openTagSheet(file, hd, anchor, point) {
  let next = hd.tags;
  const p = openPanel(
    h(
      "div",
      { class: "sheet-pick" },
      panelHead("Tags", hd.title, h("button", { class: "btn solid", onclick: () => p.close() }, "Done")),
      tagPicker(hd.tags, (t) => (next = t)),
    ),
    {
      kind: "sheet",
      anchor,
      point,
      label: "Tags",
      onClose: () => {
        if (next.join(":") !== hd.tags.join(":")) edit(file.path, "Tags changed", (d) => makeOp(d, "setTags", hd, { tags: next }));
      },
    },
  );
}

// ---------------------------------------------------------------- dates

/** A month grid (after calorie-logger's MonthCalendar), quick days, an optional time. */
export function datePicker(initial, onChange) {
  let value = initial ? { ...initial } : null;
  const today = new Date();
  let month = value ? new Date(`${value.date}T00:00:00`) : today;
  month = new Date(month.getFullYear(), month.getMonth(), 1);
  const grid = h("div", { class: "cal-grid", role: "grid" });
  const title = h("strong", { class: "cal-title" });
  const time = h("input", { class: "field cal-time", type: "time", value: value?.time || "", "aria-label": "Time" });
  const quick = h("div", { class: "chip-row cal-quick" });
  const pick = (date) => {
    value = { ...(value || {}), date, time: time.value || null };
    onChange(value);
    draw();
  };
  time.addEventListener("change", () => {
    if (!value) value = { date: isoDay(today) };
    value.time = time.value || null;
    if (!value.time) value.end = null;
    onChange(value);
    draw();
  });
  const nextMon = addDays(today, ((8 - today.getDay()) % 7) || 7);
  const quickDays = [
    ["Today", today],
    ["Tomorrow", addDays(today, 1)],
    ["Next Mon", nextMon],
    ["In a week", addDays(today, 7)],
  ];
  function draw() {
    title.textContent = month.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
    quick.replaceChildren(...quickDays.map(([l, d]) => h("button", { class: `chip${value?.date === isoDay(d) ? " on" : ""}`, onclick: () => pick(isoDay(d)) }, l)));
    const first = new Date(month);
    const lead = (first.getDay() + 6) % 7; // Monday first
    const start = addDays(first, -lead);
    const cells = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((d) => h("span", { class: "cal-dow" }, d));
    for (let n = 0; n < 42; n++) {
      const d = addDays(start, n);
      const iso = isoDay(d);
      cells.push(
        h(
          "button",
          {
            class: `cal-day${d.getMonth() !== month.getMonth() ? " out" : ""}${iso === isoDay(today) ? " today" : ""}${iso === value?.date ? " on" : ""}`,
            "aria-pressed": iso === value?.date ? "true" : "false",
            "aria-label": d.toDateString(),
            onclick: () => pick(iso),
          },
          String(d.getDate()),
        ),
      );
    }
    grid.replaceChildren(...cells);
  }
  const shift = (n) => {
    month = new Date(month.getFullYear(), month.getMonth() + n, 1);
    draw();
  };
  draw();
  return h(
    "div",
    { class: "cal" },
    quick,
    h("div", { class: "cal-nav" }, h("button", { class: "btn icon-btn", "aria-label": "Previous month", onclick: () => shift(-1) }, icon("chevron_left")), title, h("button", { class: "btn icon-btn", "aria-label": "Next month", onclick: () => shift(1) }, icon("chevron_right"))),
    grid,
    h("label", { class: "cal-time-row" }, icon("schedule"), h("span", null, "Time"), time, value?.repeat ? h("span", { class: "muted" }, `repeats ${value.repeat}`) : null),
  );
}

const DATE_TITLES = { scheduled: "Scheduled", deadline: "Deadline" };

function openDateSheet(file, hd, key, anchor, point, { onPick = null } = {}) {
  const old = hd?.planning?.[key] || null;
  let next = old ? { date: old.date, time: old.time, end: old.end, repeat: old.repeat, active: old.active } : null;
  const apply = (value) => {
    if (onPick) return onPick(value);
    edit(file.path, value ? `${DATE_TITLES[key]} ${fmtDate(value)}` : `${DATE_TITLES[key]} cleared`, (d) => makeOp(d, "setPlanning", hd, { patch: { [key]: value } }));
  };
  const p = openPanel(
    h(
      "div",
      { class: "sheet-pick" },
      panelHead(DATE_TITLES[key], hd?.title || ""),
      datePicker(next, (v) => (next = v)),
      h(
        "div",
        { class: "ed-foot" },
        old || onPick ? h("button", { class: "btn danger", onclick: () => (p.close(), apply(null)) }, "Clear") : null,
        h("span", { class: "spacer" }),
        h("button", { class: "btn", onclick: () => p.close() }, "Cancel"),
        h("button", { class: "btn solid", onclick: () => (p.close(), next && apply(next)) }, "Set"),
      ),
    ),
    { kind: "sheet", anchor, point, label: DATE_TITLES[key] },
  );
}

// ---------------------------------------------------------------- the task dialog

/**
 * Edit a heading, or create one. For a new one: `ref` and `where` ("after", "lastChild",
 * "firstChild", "end") say where it lands, and `kind` is "task" or "section".
 */
export function openTaskDialog({ file, hd = null, ref = null, where = "after", kind = null }) {
  closeAll();
  const why = readOnlyReason(file);
  if (why) return showNotice({ text: why, kind: "error" });
  const creating = !hd;
  // The page may redraw while the dialog is open; find the heading again by its title path.
  const key = hd ? E.headingKey(file.doc, hd) : null;
  const refKey = ref ? E.headingKey(file.doc, ref) : null;
  const live = () => (key ? E.findHeading(file.doc, key) : null);
  const liveRef = () => (refKey ? E.findHeading(file.doc, refKey) : null);
  const isTask = creating ? kind === "task" : !!hd.state;
  const draft = {
    title: hd?.title || "",
    state: hd?.state || (isTask ? "TODO" : null),
    priority: hd?.priority || null,
    tags: hd ? [...hd.tags] : [],
    scheduled: hd?.planning.scheduled ? { ...hd.planning.scheduled } : null,
    deadline: hd?.planning.deadline ? { ...hd.planning.deadline } : null,
    body: hd ? E.bodyText(file.doc.lines, hd) : "",
  };
  const original = JSON.stringify(draft);

  const titleIn = h("textarea", { class: "field title-in", rows: "1", placeholder: isTask ? "Task" : "Section title", enterkeyhint: "done", "aria-label": "Title" });
  titleIn.value = draft.title;
  const grow = (el) => {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  titleIn.addEventListener("input", () => {
    draft.title = titleIn.value.replace(/\n/g, " ");
    grow(titleIn);
    problem.textContent = "";
  });
  titleIn.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), save()));

  const states = h("div");
  const drawStates = () => states.replaceChildren(stateRow(draft.state, (s) => ((draft.state = s), drawStates())));
  drawStates();

  const prioBtn = h("button", { class: "chip" });
  const drawPrio = () => {
    prioBtn.className = `chip${draft.priority === "A" ? " on" : ""}`;
    prioBtn.setAttribute("aria-pressed", draft.priority === "A" ? "true" : "false");
    prioBtn.replaceChildren(h("span", { class: "prio", "data-p": "A" }, "A"), "High priority");
  };
  prioBtn.onclick = () => ((draft.priority = draft.priority === "A" ? null : "A"), drawPrio());
  drawPrio();

  const dateRow = (key) => {
    const row = h("div", { class: "date-row" });
    const draw = () => {
      const v = draft[key];
      fill(
        row,
        h(
          "button",
          {
            class: `chip${v ? " on" : ""}`,
            // Over a dialog the picker opens centred rather than hanging off a row.
            onclick: () => openDateSheet(file, { title: draft.title, planning: { [key]: draft[key] } }, key, null, null, { onPick: (val) => ((draft[key] = val), draw()) }),
          },
          icon(key === "deadline" ? "flag" : "event"),
          v ? `${DATE_TITLES[key]} ${fmtDate(v)}` : DATE_TITLES[key],
          v ? h("em", null, relDay(v.date)) : null,
        ),
        v ? h("button", { class: "btn icon-btn small", "aria-label": `Clear ${DATE_TITLES[key]}`, onclick: () => ((draft[key] = null), draw()) }, icon("close")) : null,
      );
    };
    draw();
    return row;
  };

  const notes = h("textarea", { class: "field notes-in", rows: "6", placeholder: "Notes (Org text, kept exactly as typed)", spellcheck: "true", "aria-label": "Notes" });
  notes.value = draft.body;
  notes.addEventListener("input", () => {
    draft.body = notes.value;
    const bad = E.bodyProblems(notes.value);
    problem.textContent = bad.length ? `Line ${bad[0] + 1} starts with “* ”, which Org reads as a new heading. Indent it or change the star.` : "";
  });
  const problem = h("p", { class: "problem", role: "alert" });

  const head = h(
    "div",
    { class: "ed-head dlg-head" },
    h("button", { class: "btn", onclick: () => cancel() }, "Cancel"),
    h("strong", null, creating ? (isTask ? "New task" : "New section") : isTask ? "Edit task" : "Edit section"),
    h("span", { class: "ed-sub" }, creating ? whereText(file, ref, where) : file.title),
    h("button", { class: "btn solid", onclick: () => save() }, creating ? "Add" : "Save"),
  );

  const fields = h(
    "div",
    { class: "dlg-body" },
    titleIn,
    isTask ? states : null,
    h("div", { class: "chip-row" }, isTask ? prioBtn : null, isTask ? dateRow("scheduled") : null, isTask ? dateRow("deadline") : null),
    h("div", { class: "dlg-label" }, icon("sell"), "Tags"),
    tagPicker(draft.tags, (t) => (draft.tags = t)),
    h("div", { class: "dlg-label" }, icon("notes"), "Notes"),
    notes,
    problem,
  );
  const foot = creating
    ? null
    : h(
        "div",
        { class: "ed-foot dlg-foot" },
        h("button", { class: "btn danger", onclick: () => (dlg.close(), isTask ? deleteHeading(file, live()) : askDeleteSection(file, live())) }, icon("delete"), isTask ? "Delete" : "Delete section"),
        h("button", { class: "btn", onclick: () => (dlg.close(), openMovePicker(file, live())) }, icon("drive_file_move"), "Move…"),
      );

  const box = h("div", { class: "dlg" }, head, fields, foot);
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
    }
  });
  const dlg = openPanel(box, { kind: "dialog", label: creating ? "New" : "Edit" });
  requestAnimationFrame(() => {
    grow(titleIn);
    if (creating) titleIn.focus({ preventScroll: true });
  });

  function cancel() {
    if (JSON.stringify(draft) !== original && !confirm("Discard your changes?")) return;
    dlg.close();
  }

  function save() {
    const title = draft.title.trim();
    if (!title) {
      problem.textContent = "The title is empty.";
      titleIn.focus();
      return;
    }
    if (E.bodyProblems(draft.body).length) return;
    if (creating) {
      const fields = { state: isTask ? draft.state : null, priority: draft.priority, title, tags: draft.tags, scheduled: draft.scheduled, deadline: draft.deadline, body: draft.body, level: 1 };
      const r0 = liveRef();
      if (ref && !r0) return (problem.textContent = "The place for it is gone: the file changed. Cancel and try again.");
      const at = edit(file.path, isTask ? "Task added" : "Section added", (d) => makeOp(d, "insertHeading", null, { ref: keyOf(d, r0), where: ref ? where : "end", fields }));
      dlg.close();
      if (at) requestAnimationFrame(() => requestAnimationFrame(() => actions.reveal?.(at.id)));
      return;
    }
    if (JSON.stringify(draft) === original) return dlg.close();
    const patch = { title, tags: draft.tags };
    if (isTask) Object.assign(patch, { state: draft.state, priority: draft.priority });
    const plan = {};
    for (const k of ["scheduled", "deadline"]) {
      const a = (live() || hd).planning[k];
      const b = draft[k];
      if (JSON.stringify(a ? [a.date, a.time, a.repeat] : null) !== JSON.stringify(b ? [b.date, b.time, b.repeat] : null)) plan[k] = b;
    }
    const now = live();
    if (!now) return (problem.textContent = "This heading changed in the file meanwhile. Cancel and open it again.");
    // The heading goes last, so a new title can't hide the heading from the ops before it.
    const ok = edit(file.path, "Changes saved", (d) => [
      ...(Object.keys(plan).length ? [makeOp(d, "setPlanning", now, { patch: plan })] : []),
      makeOp(d, "setBody", now, { text: draft.body }),
      makeOp(d, "setHeading", now, { patch }),
    ]);
    if (ok) dlg.close();
  }
}

function whereText(file, ref, where) {
  if (!ref) return `end of ${file.title}`;
  if (where === "after") return `after “${ref.title}”`;
  return `in “${ref.title}”`;
}

// ---------------------------------------------------------------- move picker

/** Move a heading: up, down, promote, demote, or into any section of any file. */
export function openMovePicker(file, hd) {
  closeAll();
  const doc = file.doc;
  const sib = E.siblingsOf(doc, hd);
  const i = sib.indexOf(hd);
  const filterIn = h("input", { class: "field", type: "search", placeholder: "Find a file or section", autocomplete: "off", spellcheck: "false" });
  const list = h("div", { class: "move-list" });
  const go = (label, fn) => {
    p.close();
    fn();
  };
  const same = (f) => f.path === file.path;
  const moveTo = (f, target, label) =>
    go(label, () => {
      const where = (d) => targetArg(d, target.h ? { [target.how]: target.h, ...(target.at ? { at: target.at } : {}) } : { fileEnd: true, level: 1 });
      if (same(f)) edit(file.path, label, (d) => makeOp(d, "moveSubtree", hd, { target: where(d) }));
      else
        editTwo(
          file.path,
          f.path,
          label,
          (d) => makeOp(d, "extractSubtree", hd),
          (d, chunk, level) => makeOp(d, "insertSubtree", null, { chunk, fromLevel: level, target: where(d) }),
        );
    });
  function draw() {
    const q = filterIn.value.trim().toLowerCase();
    const files = [file, ...model.files.filter((f) => f !== file)];
    const rows = [];
    for (const f of files) {
      const secs = f.doc.headings.filter((x) => !x.state && x.level <= 3 && !(same(f) && x.line >= hd.line && x.line < hd.end));
      const fileHit = !q || f.title.toLowerCase().includes(q) || f.path.toLowerCase().includes(q);
      const hits = secs.filter((s) => fileHit || s.title.toLowerCase().includes(q));
      if (!fileHit && !hits.length) continue;
      rows.push(
        h(
          "button",
          { class: "mv-row mv-file", onclick: () => moveTo(f, {}, `Moved to ${f.title}`) },
          icon(f.icon),
          h("span", { class: "mv-t" }, f.title),
          h("span", { class: "mv-note" }, same(f) ? "this file · end" : "end of file"),
        ),
      );
      for (const s of q && !fileHit ? hits : secs) {
        rows.push(
          h(
            "button",
            { class: `mv-row lvl-${s.level}`, onclick: () => moveTo(f, { h: s, how: "into", at: "last" }, `Moved to ${s.title}`) },
            h("span", { class: "mv-t" }, inline(s.title)),
            s === hd.parent ? h("span", { class: "mv-note" }, "here now") : null,
          ),
        );
      }
      if (rows.length > 400) break;
    }
    list.replaceChildren(...(rows.length ? rows : [h("p", { class: "empty" }, "Nothing matches.")]));
  }
  filterIn.addEventListener("input", draw);
  const quick = h(
    "div",
    { class: "chip-row mv-quick" },
    h("button", { class: "chip", disabled: i <= 0 || null, onclick: () => go("Moved up", () => edit(file.path, "Moved up", (d) => makeOp(d, "moveUp", hd))) }, icon("arrow_upward"), "Up"),
    h("button", { class: "chip", disabled: i >= sib.length - 1 || null, onclick: () => go("Moved down", () => edit(file.path, "Moved down", (d) => makeOp(d, "moveDown", hd))) }, icon("arrow_downward"), "Down"),
    h("button", { class: "chip", disabled: hd.level <= 1 || null, onclick: () => go("Promoted", () => edit(file.path, "Promoted", (d) => makeOp(d, "promote", hd))) }, icon("format_indent_decrease"), "Promote"),
    h("button", { class: "chip", disabled: i <= 0 || null, onclick: () => go("Demoted", () => edit(file.path, "Demoted", (d) => makeOp(d, "demote", hd))) }, icon("format_indent_increase"), "Demote"),
  );
  draw();
  const p = openPanel(
    h("div", { class: "sheet-pick move" }, panelHead("Move", hd.title, h("button", { class: "btn", onclick: () => p.close() }, "Cancel")), quick, h("div", { class: "dlg-label" }, "To the end of…"), filterIn, list),
    { kind: "dialog", label: "Move" },
  );
}
