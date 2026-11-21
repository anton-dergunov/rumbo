// One shell: a navigation list (views, then files) and one main area that shows the chosen view or
// file. The navigation adapts to the width:
//   phone          the page alone; ☰ opens the list as a drawer
//   tablet         an icon rail beside the page (☰ on the rail opens the list with names),
//                  or with nav=drawer the page alone, as on the phone
//   landscape/desk the list as a sidebar

import { h, icon, legend } from "./ui.js";
import { state, update, canGoBack, canGoForward } from "./state.js";
import { renderNav, renderRail } from "./tree.js";
import { renderOutline, foldControl, contentsButton, crumbTrail, focusedHeading, renderContents, closeBtn, editToggle } from "./outline.js";
import { renderAgenda, agendaTools } from "./agenda.js";

const THEMES = [
  ["paper", "Paper", "Warm, serif text"],
  ["slate", "Slate", "Cool, sans-serif"],
  ["dusk", "Dusk", "Warm dark"],
  ["night", "Night", "Cool dark"],
];

/** Settings: only the theme for now; more will join it. */
function settingsSheet() {
  return h(
    "div",
    { class: "sheet settings-sheet" },
    h("div", { class: "sheet-head" }, h("strong", null, "Settings"), h("span", { class: "muted" }), closeBtn()),
    h(
      "div",
      { class: "sheet-body" },
      h("h4", { class: "set-label" }, "Theme"),
      THEMES.map(([k, name, note]) =>
        h(
          "button",
          { class: `set-row${state.theme === k ? " on" : ""}`, onclick: () => update({ theme: k }) },
          h("span", { class: "swatch", "data-theme": k }, h("i")),
          h("span", { class: "set-txt" }, h("span", null, name), h("span", { class: "muted" }, note)),
          state.theme === k ? icon("check") : null,
        ),
      ),
    ),
  );
}

export function sizeClass(width) {
  if (width < 600) return "phone";
  if (width < 1100) return "tablet";
  return "wide";
}

function pane(cls, head, body, scrollKey) {
  return h("section", { class: `pane ${cls}` }, h("header", { class: "pane-head" }, head), h("div", { class: "pane-scroll", "data-scroll": scrollKey }, body));
}

/** Back and forward through the places visited (files, sections, views). Hidden until there is history. */
function historyBtns() {
  const back = canGoBack();
  const fwd = canGoForward();
  if (!back && !fwd) return null;
  return h(
    "span",
    { class: "hist" },
    h("button", { class: "btn icon-btn", title: "Back", "aria-label": "Back", disabled: !back, onclick: () => history.back() }, icon("chevron_left")),
    h("button", { class: "btn icon-btn", title: "Forward", "aria-label": "Forward", disabled: !fwd, onclick: () => history.forward() }, icon("chevron_right")),
  );
}

const menuBtn = () => h("button", { class: "btn icon-btn", "aria-label": "Views and files", onclick: () => update({ drawer: true }) }, icon("menu"));

function filePane(model, menu) {
  const file = model.byPath.get(state.file);
  if (!file) return pane("file-pane", [menu, historyBtns()], h("p", { class: "empty pad" }, "Choose a file from the list."), "nofile");
  const crumb = h("div", { class: "pane-crumb" }, crumbTrail(file, focusedHeading(file)));
  const head = [
    menu,
    historyBtns(),
    crumb,
    h("span", { class: "spacer" }),
    foldControl(),
    contentsButton(),
    editToggle(),
  ];
  return pane("file-pane", head, renderOutline(file), `file:${file.path}:${state.focus || ""}`);
}

const agendaPane = (model, menu) => pane("agenda-pane", [menu, historyBtns(), agendaTools()], renderAgenda(model), "agenda");

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
  if (state.sheet === "settings") app.append(overlay(settingsSheet()));
  if (state.sheet === "legend") {
    app.append(overlay(h("div", { class: "sheet legend-sheet" }, h("div", { class: "sheet-head" }, h("strong", null, "Marks"), h("span", { class: "muted" }), closeBtn()), h("div", { class: "sheet-body" }, legend()))));
  }
  return app;
}
