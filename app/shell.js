// One shell: a navigation list (views, then files) and one main area that shows the chosen view,
// file, or the Sync page. The navigation adapts to the width:
//   phone          the page alone; ☰ opens the list as a drawer
//   tablet         an icon rail beside the page (☰ on the rail opens the list with names),
//                  or with nav=drawer the page alone, as on the phone
//   landscape/desk the list as a sidebar

import { h, icon, legend } from "./ui.js";
import { state, update, canGoBack, canGoForward, runtime, actions } from "./state.js";
import { renderNav, renderRail } from "./tree.js";
import { renderOutline, foldControl, contentsButton, crumbTrail, focusedHeading, renderContents, closeBtn, editToggle } from "./outline.js";
import { renderAgenda, agendaTools } from "./agenda.js";
import { syncMark, renderSync, when } from "./sync-ui.js";
import { VERSION, BUILD } from "./version.js";

const THEMES = [
  ["paper", "Paper", "Warm, serif text"],
  ["slate", "Slate", "Cool, sans-serif"],
  ["dusk", "Dusk", "Warm dark"],
  ["night", "Night", "Cool dark"],
];

const NAV_CHOICES = [
  ["rail", "Icon rail", "Icons beside the page; ☰ for names"],
  ["drawer", "Drawer", "The page alone; ☰ for the list"],
];

const setRow = (on, onclick, left, name, note, right = null) =>
  h("button", { class: `set-row${on ? " on" : ""}`, onclick }, left, h("span", { class: "set-txt" }, h("span", null, name), h("span", { class: "muted" }, note)), right || (on ? icon("check") : null));

/** What Settings says about the token: it never expires, or when it does (warned two weeks ahead). */
export function tokenNote(meta, now = Date.now()) {
  if (meta.noExpiry) return { text: "Never expires. To cut off a lost device, revoke the token on GitHub.", warn: false };
  if (!meta.tokenExpiry) return { text: "Expiry not given.", warn: false };
  const days = Math.ceil((new Date(`${meta.tokenExpiry}T00:00:00`).getTime() - now) / 86_400_000);
  if (days < 0) return { text: `Expired on ${meta.tokenExpiry}. Make a new one and sign in again.`, warn: true };
  return { text: `Expires on ${meta.tokenExpiry}${days <= 14 ? `, in ${days} day${days === 1 ? "" : "s"}. Make a new one soon.` : "."}`, warn: days <= 14 };
}

function settingsSheet() {
  const m = runtime.meta;
  const token = tokenNote(m);
  const sync = runtime.sync;
  return h(
    "div",
    { class: "sheet settings-sheet" },
    h("div", { class: "sheet-head" }, h("strong", null, "Settings"), h("span", { class: "muted" }), closeBtn()),
    h(
      "div",
      { class: "sheet-body" },
      runtime.updateWaiting
        ? h("button", { class: "set-row set-update", onclick: () => actions.applyUpdate() }, icon("system_update"), h("span", { class: "set-txt" }, h("span", null, "Update Rumbo"), h("span", { class: "muted" }, "A newer version has downloaded.")))
        : null,
      h("h4", { class: "set-label" }, "Theme"),
      THEMES.map(([k, name, note]) => setRow(state.theme === k, () => actions.setPref("theme", k), h("span", { class: "swatch", "data-theme": k }, h("i")), name, note)),
      h("h4", { class: "set-label" }, "Tablet navigation"),
      NAV_CHOICES.map(([k, name, note]) => setRow(state.nav === k, () => actions.setPref("nav", k), icon(k === "rail" ? "view_sidebar" : "menu"), name, note)),
      h("h4", { class: "set-label" }, "Vault"),
      setRow(false, () => actions.openSync(), icon("sync"), "Sync", `${m.repo || "—"} · ${sync.status === "synced" ? `checked ${when(m.lastCheck)}` : sync.status}`, icon("chevron_right")),
      h("div", { class: `set-row set-static${token.warn ? " warn" : ""}` }, icon("key"), h("span", { class: "set-txt" }, h("span", null, "Token"), h("span", { class: "muted" }, token.text))),
      h("div", { class: "set-row set-static" }, icon("devices"), h("span", { class: "set-txt" }, h("span", null, "This device"), h("span", { class: "muted" }, `${m.device || "—"}: the name in commit messages`))),
      h("h4", { class: "set-label" }, "About"),
      h(
        "a",
        { class: "set-row", href: "check/" },
        icon("monitor_heart"),
        h("span", { class: "set-txt" }, h("span", null, "Diagnostics"), h("span", { class: "muted" }, "The device check")),
        icon("chevron_right"),
      ),
      h("div", { class: "set-row set-static" }, icon("info"), h("span", { class: "set-txt" }, h("span", null, "Version"), h("span", { class: "muted" }, `${VERSION} (${BUILD})`))),
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
  if (!file) return pane("file-pane", [menu, historyBtns(), h("span", { class: "spacer" }), syncMark()], h("p", { class: "empty pad" }, model.files.length ? "Choose a file from the list." : "No files yet: they appear after the first sync."), "nofile");
  const crumb = h("div", { class: "pane-crumb" }, crumbTrail(file, focusedHeading(file)));
  const head = [
    menu,
    historyBtns(),
    crumb,
    h("span", { class: "spacer" }),
    syncMark(),
    foldControl(),
    contentsButton(),
    editToggle(),
  ];
  return pane("file-pane", head, renderOutline(file), `file:${file.path}:${state.focus || ""}`);
}

const agendaPane = (model, menu) => pane("agenda-pane", [menu, historyBtns(), agendaTools(), syncMark()], renderAgenda(model), "agenda");
const syncPane = (model, menu) => pane("sync-pane", [menu, historyBtns(), h("div", { class: "titlebar" }, h("span", { class: "view-title" }, icon("sync"), h("span", { class: "t" }, "Sync")))], renderSync(model), "sync");

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
  const main = state.view === "file" ? filePane : state.view === "sync" ? syncPane : agendaPane;
  app.append(h("div", { class: "main" }, main(model, menu)));

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
