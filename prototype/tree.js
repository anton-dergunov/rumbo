// The vault's folders and files: a compact list, and the icon rail used when the list is folded away.

import { h, icon, signal } from "./ui.js";
import { state, actions } from "./state.js";

export function renderTree(model) {
  return h(
    "nav",
    { class: "tree" },
    model.folders.map((folder) =>
      h(
        "section",
        { class: `tfolder${folder.name ? "" : " loose"}` },
        folder.name ? h("h3", { class: "tfolder-head" }, folder.icon !== "folder" ? icon(folder.icon) : null, folder.name) : null,
        folder.files.map((f) =>
          h(
            "button",
            { class: `tf${state.file === f.path ? " on" : ""}`, onclick: () => actions.openFile(f.path) },
            icon(f.icon, "fi"),
            h("span", { class: "name" }, f.name),
            signal(f.counts),
          ),
        ),
      ),
    ),
  );
}

export function renderRail(model) {
  const out = h("nav", { class: "rail" });
  model.folders.forEach((folder, i) => {
    if (i) out.append(h("span", { class: "rail-sep" }));
    for (const f of folder.files) {
      const sig = f.counts.INPR ? "INPR" : f.counts.A ? "A" : f.counts.NEXT ? "NEXT" : null;
      out.append(
        h(
          "button",
          { class: `rail-btn${state.file === f.path ? " on" : ""}`, title: f.name, "aria-label": f.name, onclick: () => actions.openFile(f.path) },
          icon(f.icon),
          sig ? h("i", { class: "rail-dot", "data-s": sig }) : null,
        ),
      );
    }
  });
  return out;
}
