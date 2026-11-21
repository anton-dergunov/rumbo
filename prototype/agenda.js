// The agenda: the three pull sections of the Emacs agenda `c`, drawn three ways.
//   A1 columns  aligned slots like the Emacs agenda (file icon | state | priority | task icon | title | tags)
//   A2 rows     two-line rows: title, then where it lives
//   A3 grouped  each section grouped by file

import { h, icon, inline, blocks, stateMark, prioMark, tagList, planningChips, crumbs } from "./ui.js";
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
    h("div", { class: "ag-where" }, crumbs(hd, { file })),
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

function rowColumns(model, item, withPrio, withIcon) {
  const { heading: hd, file } = item;
  const tIcon = model.taskIcon(hd);
  const el = h("div", { class: `ag-item${state.agendaOpen.has(hd.id) ? " open" : ""}` });
  el.append(
    h(
      "button",
      { class: "ag-row", onclick: () => toggleRow(hd.id, el) },
      h("span", { class: "c-file", title: file.name }, icon(file.icon)),
      h("span", { class: "c-state" }, stateMark(hd.state)),
      withPrio ? h("span", { class: "c-prio" }, prioMark(hd.priority)) : null,
      withIcon ? h("span", { class: "c-ticon" }, tIcon ? icon(tIcon) : null) : null,
      h("span", { class: "c-title" }, inline(hd.title), h("span", { class: "inline-meta" }, planningChips(hd.planning), tagList(hd.tags))),
      h("span", { class: "c-tags" }, planningChips(hd.planning), tagList(hd.tags)),
    ),
    detail(item),
  );
  return el;
}

function rowTwoLine(model, item) {
  const { heading: hd, file } = item;
  const tIcon = model.taskIcon(hd);
  const el = h("div", { class: `ag-item ag2${state.agendaOpen.has(hd.id) ? " open" : ""}` });
  el.append(
    h(
      "button",
      { class: "ag-row", onclick: () => toggleRow(hd.id, el) },
      h("span", { class: "ag2-icon" }, icon(tIcon || file.icon)),
      h(
        "span",
        { class: "ag2-main" },
        h("span", { class: "ag2-l1" }, stateMark(hd.state), prioMark(hd.priority), h("span", { class: "ag2-title" }, inline(hd.title))),
        h("span", { class: "ag2-l2" }, crumbs(hd, { file }), planningChips(hd.planning), tagList(hd.tags)),
      ),
    ),
    detail(item),
  );
  return el;
}

function rowGrouped(model, item) {
  const { heading: hd } = item;
  const tIcon = model.taskIcon(hd);
  const el = h("div", { class: `ag-item ag3${state.agendaOpen.has(hd.id) ? " open" : ""}` });
  el.append(
    h(
      "button",
      { class: "ag-row", onclick: () => toggleRow(hd.id, el) },
      h("span", { class: "slot" }, stateMark(hd.state)),
      hd.priority ? h("span", { class: "slot" }, prioMark(hd.priority)) : null,
      h("span", { class: "ag3-title" }, tIcon ? icon(tIcon, "ticon") : null, inline(hd.title), planningChips(hd.planning), tagList(hd.tags)),
    ),
    detail(item),
  );
  return el;
}

function sectionBody(model, sec) {
  const variant = state.agenda;
  if (variant === "rows") return h("div", { class: "ag-list ag-rows" }, sec.items.map((it) => rowTwoLine(model, it)));
  if (variant === "grouped") {
    const groups = new Map();
    for (const it of sec.items) {
      if (!groups.has(it.file)) groups.set(it.file, []);
      groups.get(it.file).push(it);
    }
    return h(
      "div",
      { class: "ag-list ag-grouped" },
      [...groups].map(([file, items]) =>
        h(
          "div",
          { class: "ag3-group" },
          h(
            "button",
            { class: "ag3-gh", onclick: () => actions.openFile(file.path) },
            icon(file.icon),
            h("span", null, file.name),
            h("span", { class: "n" }, items.length),
          ),
          items.map((it) => rowGrouped(model, it)),
        ),
      ),
    );
  }
  // Like the Emacs agenda, a column only exists when some row in the section fills it.
  const withPrio = sec.items.some((it) => it.heading.priority);
  const withIcon = sec.items.some((it) => model.taskIcon(it.heading));
  const cols = ["30px", "max-content", withPrio && "max-content", withIcon && "26px", "minmax(0, 1fr)", "auto"].filter(Boolean);
  return h(
    "div",
    { class: "ag-list ag-columns", style: `grid-template-columns: ${cols.join(" ")}` },
    sec.items.map((it) => rowColumns(model, it, withPrio, withIcon)),
  );
}

export function agendaHeader(model) {
  const today = new Date();
  const date = today.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).replace(/^(\w+),? /, "$1 · ");
  return h("div", { class: "ag-date" }, h("span", null, date));
}

export function renderAgenda(model) {
  const root = h("div", { class: `agenda agenda-${state.agenda}` });
  root.append(
    h(
      "header",
      { class: "ag-head" },
      h("h2", null, agendaHeader(model)),
      h(
        "p",
        { class: "ag-sum" },
        model.agenda.map((s) => `${s.items.length} ${s.title.toLowerCase()}`).join(" · "),
        model.sample ? " · sample data" : "",
      ),
    ),
  );
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

export { update };
