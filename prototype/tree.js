// The vault's folders and files: D1 list, D2 grid, D3 index, plus the icon rail used by narrow shells.

import { h, icon, signal } from "./ui.js";
import { state, actions } from "./state.js";

function fileRow(file, variant) {
  const on = state.file === file.path;
  const open = () => actions.openFile(file.path);
  if (variant === "grid") {
    return h(
      "button",
      { class: `tf tile${on ? " on" : ""}`, onclick: open },
      h("span", { class: "tile-top" }, icon(file.icon, "fi"), signal(file.counts)),
      h("span", { class: "name" }, file.name),
      file.subtitle ? h("span", { class: "sub" }, file.subtitle) : null,
      h("span", { class: "foot" }, `${file.counts.open} open`),
    );
  }
  if (variant === "index") {
    return h(
      "button",
      { class: `tf irow${on ? " on" : ""}`, onclick: open },
      icon(file.icon, "fi"),
      h(
        "span",
        { class: "txt" },
        h("span", { class: "name" }, file.name, signal(file.counts)),
        file.subtitle ? h("span", { class: "sub" }, file.subtitle) : null,
      ),
    );
  }
  return h(
    "button",
    { class: `tf lrow${on ? " on" : ""}`, onclick: open },
    icon(file.icon, "fi"),
    h("span", { class: "name" }, file.name),
    signal(file.counts),
  );
}

export function renderTree(model, variant = state.tree) {
  return h(
    "nav",
    { class: `tree tree-${variant}` },
    model.folders.map((folder) =>
      h(
        "section",
        { class: `tfolder${folder.name ? "" : " loose"}` },
        folder.name
          ? h("h3", { class: "tfolder-head" }, folder.icon !== "folder" ? icon(folder.icon) : null, folder.name)
          : null,
        h("div", { class: "tfiles" }, folder.files.map((f) => fileRow(f, variant))),
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
          {
            class: `rail-btn${state.file === f.path ? " on" : ""}`,
            title: f.name,
            "aria-label": f.name,
            onclick: () => actions.openFile(f.path),
          },
          icon(f.icon),
          sig ? h("i", { class: "rail-dot", "data-s": sig }) : null,
        ),
      );
    }
  });
  return out;
}
