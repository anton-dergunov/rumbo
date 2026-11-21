// The agenda: the three pull sections of the Emacs agenda `c` (high priority, in progress, next up).
// Each task is a two-line row: the title, then where it lives. "By file" groups the same rows
// under their files.

import { h, icon, inline, blocks, stateGlyph, stateLabel, prioMark, tagList, planningChips, crumbs } from "./ui.js";
import { state, update, actions } from "./state.js";

const SECTION_ICONS = { high: "priority_high", inpr: "progress_activity", next: "arrow_forward" };

function toggleRow(id, el) {
  if (state.agendaOpen.has(id)) state.agendaOpen.delete(id);
  else state.agendaOpen.add(id);
  el.classList.toggle("open", state.agendaOpen.has(id));
}

function detail(item) {
  const { heading: hd, file } = item;
  return h(
    "div",
    { class: "ag-detail" },
    hd.blocks.length ? h("div", { class: "ag-body" }, blocks(hd.blocks)) : null,
    h(
      "button",
      {
        class: "btn open-in",
        onclick: (e) => {
          e.stopPropagation();
          actions.openHeading(file.path, hd.id);
        },
      },
      icon("open_in_new"),
      "Open in ",
      file.name,
    ),
  );
}

function row(model, item, grouped) {
  const { heading: hd, file } = item;
  const tIcon = state.icons === "right" ? model.taskIcon(hd) : null;
  const square = grouped ? tIcon : tIcon || file.icon;
  const el = h("div", { class: `ag-item${state.agendaOpen.has(hd.id) ? " open" : ""}` });
  el.append(
    h(
      "button",
      { class: "ag-row", onclick: () => toggleRow(hd.id, el) },
      h("span", { class: `ag-icon${square ? "" : " blank"}` }, square ? icon(square) : null),
      h("span", { class: "ag-glyph" }, stateGlyph(hd.state)),
      h("span", { class: "ag-title" }, inline(hd.title), hd.blocks.length ? icon("notes", "more") : null),
      h("span", { class: "aside" }, stateLabel(hd.state), prioMark(hd.priority)),
      h("span", { class: "ag-meta" }, crumbs(hd, { file: grouped ? null : file }), planningChips(hd.planning), tagList(hd.tags)),
    ),
    detail(item),
  );
  return el;
}

function sectionBody(model, sec) {
  if (state.group !== "file") return h("div", { class: "ag-list" }, sec.items.map((it) => row(model, it, false)));
  const groups = new Map();
  for (const it of sec.items) {
    if (!groups.has(it.file)) groups.set(it.file, []);
    groups.get(it.file).push(it);
  }
  return h(
    "div",
    { class: "ag-list grouped" },
    [...groups].map(([file, items]) =>
      h(
        "div",
        { class: "ag-group" },
        h("button", { class: "ag-gh", onclick: () => actions.openFile(file.path) }, icon(file.icon), h("span", null, file.name), h("span", { class: "n" }, items.length)),
        items.map((it) => row(model, it, true)),
      ),
    ),
  );
}

/** Header items for the agenda pane: the date, the List / By file toggle and the legend. */
export function agendaTools() {
  const today = new Date();
  const long = today.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  const short = today.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  return [
    h("span", { class: "ag-date" }, h("span", { class: "long" }, long), h("span", { class: "short" }, short)),
    h("span", { class: "spacer" }),
    h(
      "div",
      { class: "seg group", role: "group", "aria-label": "Group" },
      [["list", "List", "view_agenda"], ["file", "By file", "folder"]].map(([k, label, ic]) =>
        h("button", { class: state.group === k ? "on" : "", title: label, onclick: () => update({ group: k }) }, icon(ic), h("span", null, label)),
      ),
    ),
    h("button", { class: "btn icon-btn", title: "What the marks mean", "aria-label": "Legend", onclick: () => update({ sheet: "legend" }) }, icon("info")),
  ];
}

export function renderAgenda(model) {
  const root = h("div", { class: "agenda" });
  if (model.sample) root.append(h("p", { class: "ag-sample" }, "Sample data"));
  for (const sec of model.agenda) {
    if (!sec.items.length) continue;
    const shut = state.agendaShut.has(sec.key);
    const secEl = h("section", { class: `ag-sec${shut ? " shut" : ""}`, "data-key": sec.key });
    secEl.append(
      h(
        "button",
        {
          class: "ag-sec-head",
          onclick: () => {
            if (state.agendaShut.has(sec.key)) state.agendaShut.delete(sec.key);
            else state.agendaShut.add(sec.key);
            secEl.classList.toggle("shut");
          },
        },
        icon("expand_more", "fold-ic"),
        icon(SECTION_ICONS[sec.key], "sec-ic"),
        h("span", null, sec.title),
        h("span", { class: "n" }, sec.items.length),
      ),
      sectionBody(model, sec),
    );
    root.append(secEl);
  }
  if (!model.agenda.some((s) => s.items.length)) root.append(h("p", { class: "empty" }, "Nothing in progress, prioritised or next."));
  return root;
}
