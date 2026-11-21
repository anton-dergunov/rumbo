// How Files and Agenda share the screen.
//   S1 panes  tree | file | agenda, like the Emacs frame; narrower screens fold the tree to an icon rail
//             and then put File and Agenda behind a switch
//   S2 tabs   Agenda and Files as two tabs; Files is a split view on tablets, list -> page on a phone
//   S3 home   the agenda is home; files come from a drawer and open as a pushed page

import { h, icon } from "./ui.js";
import { state, update } from "./state.js";
import { renderTree, renderRail } from "./tree.js";
import { renderOutline, foldControl, contentsButton, trackSection, renderContents, closeBtn } from "./outline.js";
import { renderAgenda } from "./agenda.js";

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

function filePane(model, width, { back, lead } = {}) {
  const file = model.byPath.get(state.file);
  if (!file) return pane("file-pane", null, h("p", { class: "empty" }, "Choose a file."), "nofile");
  const crumb = h("div", { class: "pane-crumb" });
  const head = [
    back ? h("button", { class: "btn back", onclick: back.go }, icon("chevron_left"), h("span", { class: "back-label" }, back.label)) : null,
    lead || null,
    crumb,
    h("span", { class: "spacer" }),
    foldControl(),
    contentsButton(),
  ];
  const paneWidth = width;
  const bare = state.outline === "navigator" && !back && !lead;
  const p = pane(`file-pane o-${state.outline}-pane`, bare ? null : head, renderOutline(model, file, paneWidth), `file:${file.path}:${state.outline}:${state.nav || ""}`);
  if (state.outline !== "navigator") {
    queueMicrotask(() => trackSection(p.querySelector(".pane-scroll"), crumb, model, file));
  } else crumb.append(h("span", { class: "cr-file" }, file.title));
  return p;
}

function agendaPane(model, lead) {
  return pane("agenda-pane", lead ? [lead, h("span", { class: "spacer" })] : null, renderAgenda(model), "agenda");
}

function treePane(model, variant) {
  return pane(
    "tree-pane",
    h("div", { class: "vault-chip" }, icon(model.sample ? "science" : "folder_special"), model.sample ? "sample vault" : model.name),
    renderTree(model, variant),
    "tree",
  );
}

const switcher = (items, current, onPick, cls = "") =>
  h(
    "div",
    { class: `seg ${cls}`, role: "tablist" },
    items.map(([k, label, ic]) => h("button", { class: current === k ? "on" : "", role: "tab", onclick: () => onPick(k) }, ic ? icon(ic) : null, h("span", null, label))),
  );

function drawer(model) {
  return h(
    "div",
    { class: "overlay", onclick: (e) => e.target === e.currentTarget && update({ drawer: false }) },
    h("aside", { class: "drawer" }, h("div", { class: "sheet-head" }, h("strong", null, "Files"), closeBtn()), h("div", { class: "drawer-scroll", "data-scroll": "drawer" }, renderTree(model, state.tree === "grid" ? "index" : state.tree))),
  );
}

export function renderShell(model, width) {
  const size = sizeClass(width);
  const narrow = size === "phone" || size === "portrait";
  const app = h("div", { class: `shell shell-${state.shell} size-${size}` });

  if (state.shell === "panes") {
    if (size === "xwide") app.append(treePane(model, state.tree), filePane(model, width - 700), agendaPane(model));
    else if (size === "wide") app.append(renderRailPane(model), filePane(model, width - 470), agendaPane(model));
    else {
      const view = state.view === "agenda" ? "agenda" : "file";
      const phone = size === "phone";
      const lead = [
        phone ? h("button", { class: "btn icon-btn", "aria-label": "Files", onclick: () => update({ drawer: true }) }, icon("menu")) : null,
        switcher([["file", "File", "description"], ["agenda", "Agenda", "checklist"]], view, (k) => update({ view: k }), phone ? "icons" : ""),
      ];
      const main = h("div", { class: "main" }, view === "agenda" ? agendaPane(model, lead) : filePane(model, width - (phone ? 0 : 64), { lead }));
      if (!phone) app.append(renderRailPane(model));
      app.append(main);
    }
  } else if (state.shell === "tabs") {
    const tab = state.view === "agenda" ? "agenda" : "files";
    const tabs = [["agenda", "Agenda", "checklist"], ["files", "Files", "folder_open"]];
    const pages = size === "phone" || state.tree === "grid"; // Files is list -> page instead of a split
    const pick = (k) => update({ view: k === "files" ? (pages ? "files" : "file") : "agenda" });
    if (size !== "phone") app.append(h("header", { class: "topbar center" }, switcher(tabs, tab, pick)));
    let body;
    if (tab === "agenda") body = agendaPane(model);
    else if (pages) {
      body = state.view === "file" ? filePane(model, width, { back: { label: "Files", go: () => update({ view: "files" }) } }) : treePane(model, state.tree);
    } else {
      body = h("div", { class: "split" }, treePane(model, state.tree), filePane(model, width - (size === "portrait" ? 280 : 340)));
    }
    app.append(h("div", { class: "main" }, body));
    if (size === "phone") app.append(h("footer", { class: "tabbar" }, switcher(tabs, tab, pick, "tabs")));
  } else {
    const filesBtn = h("button", { class: "btn", onclick: () => update({ drawer: true }) }, icon("menu"), h("span", { class: "btn-label" }, "Files"));
    if (state.view === "file") {
      app.append(
        h(
          "div",
          { class: "main" },
          filePane(model, width, { back: { label: "Today", go: () => update({ view: "agenda" }) }, lead: narrow ? null : filesBtn }),
        ),
      );
    } else {
      app.append(h("div", { class: "main home" }, agendaPane(model, filesBtn)));
    }
  }

  if (state.drawer) app.append(drawer(model));
  if (state.sheet === "contents" && model.byPath.get(state.file)) {
    app.append(
      h(
        "div",
        { class: "overlay", onclick: (e) => e.target === e.currentTarget && update({ sheet: null }) },
        renderContents(model, model.byPath.get(state.file)),
      ),
    );
  }
  return app;
}

function renderRailPane(model) {
  return h("section", { class: "pane rail-pane" }, h("div", { class: "pane-scroll", "data-scroll": "rail" }, renderRail(model)));
}
