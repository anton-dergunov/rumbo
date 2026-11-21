// The navigation list: views first (Agenda now; Calendar and situations later), then the vault's
// folders and files. The same list fills the sidebar and the drawer; the rail is its icon-only form.

import { h, icon, signal } from "./ui.js";
import { state, update, actions } from "./state.js";

// Views are the Emacs agenda-style views. Only Agenda exists so far.
export const VIEWS = [{ key: "agenda", name: "Agenda", icon: "checklist" }];

const isOn = (view, path) => (path ? state.view === "file" && state.file === path : state.view === view);

export function renderNav(model) {
  return h(
    "nav",
    { class: "tree" },
    h(
      "section",
      { class: "tfolder views" },
      h("h3", { class: "tfolder-head" }, "Views"),
      VIEWS.map((v) =>
        h("button", { class: `tf${isOn(v.key) ? " on" : ""}`, onclick: () => actions.openView(v.key) }, icon(v.icon, "fi"), h("span", { class: "name" }, v.name)),
      ),
    ),
    model.folders.map((folder) =>
      h(
        "section",
        { class: `tfolder${folder.name ? "" : " loose"}` },
        folder.name ? h("h3", { class: "tfolder-head" }, folder.icon !== "folder" ? icon(folder.icon) : null, folder.name) : null,
        folder.files.map((f) =>
          h(
            "button",
            { class: `tf${isOn(null, f.path) ? " on" : ""}`, onclick: () => actions.openFile(f.path) },
            icon(f.icon, "fi"),
            h("span", { class: "name" }, f.name),
            signal(f.counts),
          ),
        ),
      ),
    ),
    h(
      "div",
      { class: "nav-foot" },
      h("button", { class: "foot-link", onclick: () => update({ sheet: "legend", drawer: false }) }, icon("info"), "What the marks mean"),
      h("button", { class: "foot-link", onclick: () => update({ sheet: "settings", drawer: false }) }, icon("settings"), "Settings"),
    ),
  );
}

export function renderRail(model) {
  const out = h("nav", { class: "rail" });
  out.append(h("button", { class: "rail-btn", title: "All files", "aria-label": "Show names", onclick: () => update({ drawer: true }) }, icon("menu")));
  out.append(h("span", { class: "rail-sep" }));
  for (const v of VIEWS) {
    out.append(h("button", { class: `rail-btn${isOn(v.key) ? " on" : ""}`, title: v.name, "aria-label": v.name, onclick: () => actions.openView(v.key) }, icon(v.icon)));
  }
  for (const folder of model.folders) {
    out.append(h("span", { class: "rail-sep" }));
    for (const f of folder.files) {
      const sig = f.counts.INPR ? "INPR" : f.counts.A ? "A" : f.counts.NEXT ? "NEXT" : null;
      out.append(
        h(
          "button",
          { class: `rail-btn${isOn(null, f.path) ? " on" : ""}`, title: f.name, "aria-label": f.name, onclick: () => actions.openFile(f.path) },
          icon(f.icon),
          sig ? h("i", { class: "rail-dot", "data-s": sig }) : null,
        ),
      );
    }
  }
  return out;
}
