// One shell: a navigation list (views, then files) and one main area that shows the chosen view or
// file. The navigation adapts to the width:
//   phone          the page alone; ☰ opens the list as a drawer
//   tablet         an icon rail beside the page (☰ on the rail opens the list with names),
//                  or with nav=drawer the page alone, as on the phone
//   landscape/desk the list as a sidebar

import { h, icon, legend } from "./ui.js";
import { state, update } from "./state.js";
import { renderNav, renderRail } from "./tree.js";
import { renderOutline, foldControl, contentsButton, trackSection, renderContents, closeBtn, goUp } from "./outline.js";
import { renderAgenda, agendaTools } from "./agenda.js";

export function sizeClass(width) {
  if (width < 600) return "phone";
  if (width < 1100) return "tablet";
  return "wide";
}

function pane(cls, head, body, scrollKey) {
  return h("section", { class: `pane ${cls}` }, h("header", { class: "pane-head" }, head), h("div", { class: "pane-scroll", "data-scroll": scrollKey }, body));
}

const menuBtn = () => h("button", { class: "btn icon-btn", "aria-label": "Views and files", onclick: () => update({ drawer: true }) }, icon("menu"));

function filePane(model, menu) {
  const file = model.byPath.get(state.file);
  if (!file) return pane("file-pane", [menu], h("p", { class: "empty pad" }, "Choose a file from the list."), "nofile");
  const crumb = h("div", { class: "pane-crumb" });
  const head = [
    menu,
    state.focus ? h("button", { class: "btn icon-btn back", title: "Up one level", "aria-label": "Back", onclick: goUp }, icon("arrow_back")) : null,
    crumb,
    h("span", { class: "spacer" }),
    foldControl(),
    contentsButton(),
  ];
  const p = pane("file-pane", head, renderOutline(file), `file:${file.path}:${state.focus || ""}`);
  queueMicrotask(() => trackSection(p.querySelector(".pane-scroll"), crumb, file));
  return p;
}

const agendaPane = (model, menu) => pane("agenda-pane", [menu, agendaTools()], renderAgenda(model), "agenda");

function overlay(content) {
  return h("div", { class: "overlay", onclick: (e) => e.target === e.currentTarget && update({ sheet: null, drawer: false }) }, content);
}

export function renderShell(model, width) {
  const size = sizeClass(width);
  const mode = size === "phone" ? "drawer" : size === "wide" ? "sidebar" : state.nav;
  const app = h("div", { class: `shell size-${size} nav-${mode}` });

  if (mode === "sidebar") {
    app.append(
      h(
        "section",
        { class: "pane side-pane" },
        h("header", { class: "pane-head" }, h("div", { class: "vault-chip" }, icon(model.sample ? "science" : "folder_special"), model.sample ? "sample vault" : model.name)),
        h("div", { class: "pane-scroll", "data-scroll": "side" }, renderNav(model)),
      ),
    );
  }
  if (mode === "rail") app.append(h("section", { class: "pane rail-pane" }, h("div", { class: "pane-scroll", "data-scroll": "rail" }, renderRail(model))));

  const menu = mode === "drawer" ? menuBtn() : null;
  app.append(h("div", { class: "main" }, state.view === "file" ? filePane(model, menu) : agendaPane(model, menu)));

  if (state.drawer) {
    app.append(
      overlay(
        h(
          "aside",
          { class: "drawer" },
          h("div", { class: "sheet-head" }, h("strong", null, model.sample ? "Sample vault" : "Plans"), h("span", { class: "muted" }), closeBtn()),
          h("div", { class: "drawer-scroll", "data-scroll": "drawer" }, renderNav(model)),
        ),
      ),
    );
  }
  const file = model.byPath.get(state.file);
  if (state.sheet === "contents" && file && state.view === "file") app.append(overlay(renderContents(file)));
  if (state.sheet === "legend") {
    app.append(overlay(h("div", { class: "sheet legend-sheet" }, h("div", { class: "sheet-head" }, h("strong", null, "Marks"), h("span", { class: "muted" }), closeBtn()), h("div", { class: "sheet-body" }, legend()))));
  }
  return app;
}
