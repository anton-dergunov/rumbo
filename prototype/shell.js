// How Files and Agenda share the screen.
//   panes  tree | file | agenda, like the Emacs frame; narrower screens fold the tree to an icon rail
//          and then put File and Agenda behind a switch
//   tabs   Agenda and Files as two tabs; Files is a split view on tablets, list -> page on a phone
//   home   the agenda is home; files come from a drawer and open as a pushed page

import { h, icon, legend } from "./ui.js";
import { state, update } from "./state.js";
import { renderTree, renderRail } from "./tree.js";
import { renderOutline, foldControl, contentsButton, trackSection, renderContents, closeBtn } from "./outline.js";
import { renderAgenda, agendaTools } from "./agenda.js";

export function sizeClass(width) {
  if (width < 600) return "phone";
  if (width < 1000) return "portrait";
  if (width < 1300) return "wide";
  return "xwide";
}

function pane(cls, head, body, scrollKey) {
  return h(
    "section",
    { class: `pane ${cls}` },
    head ? h("header", { class: "pane-head" }, head) : null,
    h("div", { class: "pane-scroll", "data-scroll": scrollKey }, body),
  );
}

function filePane(model, { back, lead } = {}) {
  const file = model.byPath.get(state.file);
  if (!file) return pane("file-pane", lead, h("p", { class: "empty" }, "Choose a file."), "nofile");
  const crumb = h("div", { class: "pane-crumb" });
  const head = [
    back ? h("button", { class: "btn back", onclick: back.go }, icon("chevron_left"), h("span", { class: "back-label" }, back.label)) : null,
    lead || null,
    crumb,
    h("span", { class: "spacer" }),
    foldControl(),
    contentsButton(),
  ];
  const p = pane("file-pane", head, renderOutline(file), `file:${file.path}:${state.focus || ""}`);
  queueMicrotask(() => trackSection(p.querySelector(".pane-scroll"), crumb, file));
  return p;
}

const agendaPane = (model, lead) => pane("agenda-pane", [lead || null, agendaTools()], renderAgenda(model), "agenda");

const treePane = (model) =>
  pane(
    "tree-pane",
    h("div", { class: "vault-chip" }, icon(model.sample ? "science" : "folder_special"), model.sample ? "sample vault" : model.name),
    renderTree(model),
    "tree",
  );

const railPane = (model) => h("section", { class: "pane rail-pane" }, h("div", { class: "pane-scroll", "data-scroll": "rail" }, renderRail(model)));

const switcher = (items, current, onPick, cls = "") =>
  h(
    "div",
    { class: `seg ${cls}`, role: "tablist" },
    items.map(([k, label, ic]) => h("button", { class: current === k ? "on" : "", role: "tab", title: label, onclick: () => onPick(k) }, ic ? icon(ic) : null, h("span", null, label))),
  );

const menuBtn = () => h("button", { class: "btn icon-btn", "aria-label": "Files", onclick: () => update({ drawer: true }) }, icon("menu"));

function overlay(content, close) {
  return h("div", { class: "overlay", onclick: (e) => e.target === e.currentTarget && close() }, content);
}

export function renderShell(model, width) {
  const size = sizeClass(width);
  const phone = size === "phone";
  const app = h("div", { class: `shell shell-${state.shell} size-${size}` });

  if (state.shell === "panes") {
    if (size === "xwide") app.append(treePane(model), filePane(model), agendaPane(model));
    else if (size === "wide") app.append(railPane(model), filePane(model), agendaPane(model));
    else {
      const view = state.view === "agenda" ? "agenda" : "file";
      const lead = [phone ? menuBtn() : null, switcher([["file", "File", "description"], ["agenda", "Agenda", "checklist"]], view, (k) => update({ view: k }), "icons")];
      if (!phone) app.append(railPane(model));
      app.append(h("div", { class: "main" }, view === "agenda" ? agendaPane(model, lead) : filePane(model, { lead })));
    }
  } else if (state.shell === "tabs") {
    const tab = state.view === "agenda" ? "agenda" : "files";
    const tabs = [["agenda", "Agenda", "checklist"], ["files", "Files", "folder_open"]];
    const pick = (k) => update({ view: k === "files" ? (phone ? "files" : "file") : "agenda" });
    if (!phone) app.append(h("header", { class: "topbar center" }, switcher(tabs, tab, pick)));
    let body;
    if (tab === "agenda") body = agendaPane(model);
    else if (phone) body = state.view === "file" ? filePane(model, { back: { label: "Files", go: () => update({ view: "files" }) } }) : treePane(model);
    else body = h("div", { class: "split" }, treePane(model), filePane(model));
    app.append(h("div", { class: "main" }, body));
    if (phone) app.append(h("footer", { class: "tabbar" }, switcher(tabs, tab, pick, "tabs")));
  } else {
    const filesBtn = h("button", { class: "btn", onclick: () => update({ drawer: true }) }, icon("menu"), h("span", { class: "btn-label" }, "Files"));
    const body =
      state.view === "file"
        ? filePane(model, { back: { label: "Today", go: () => update({ view: "agenda" }) }, lead: phone ? null : filesBtn })
        : agendaPane(model, filesBtn);
    app.append(h("div", { class: "main" }, body));
  }

  const close = () => update({ sheet: null, drawer: false });
  if (state.drawer) {
    app.append(
      overlay(
        h("aside", { class: "drawer" }, h("div", { class: "sheet-head" }, h("strong", null, "Files"), closeBtn()), h("div", { class: "drawer-scroll", "data-scroll": "drawer" }, renderTree(model))),
        close,
      ),
    );
  }
  const file = model.byPath.get(state.file);
  if (state.sheet === "contents" && file) app.append(overlay(renderContents(file), close));
  if (state.sheet === "legend") {
    app.append(overlay(h("div", { class: "sheet legend-sheet" }, h("div", { class: "sheet-head" }, h("strong", null, "Marks"), h("span", { class: "muted" }), closeBtn()), h("div", { class: "sheet-body" }, legend())), close));
  }
  return app;
}
