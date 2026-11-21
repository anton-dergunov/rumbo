// Prototype-only toolbar: cycle through every design variant and device frame.
// Tap a button to move to the next option, or long-press / right-click it to move back.

import { h } from "./ui.js";
import { state, update, VARIANTS, LABELS } from "./state.js";

const NAMES = { frame: "Frame", theme: "Theme", nav: "Tablet nav", folded: "Folded", data: "Data" };

function cycle(key, dir) {
  const list = VARIANTS[key];
  const next = list[(list.indexOf(state[key]) + dir + list.length) % list.length];
  update({ [key]: next });
}

export function renderHarness() {
  const root = document.getElementById("harness");
  root.replaceChildren();
  root.classList.toggle("collapsed", !state.harness);
  if (!state.harness) {
    root.append(h("button", { class: "h-toggle", title: "Show prototype switches", onclick: () => update({ harness: true }) }, "⚙"));
    return;
  }
  root.append(h("span", { class: "h-label" }, "prototype"));
  for (const key of Object.keys(VARIANTS)) {
    const value = state[key];
    const label = LABELS[key]?.[value] || value;
    let timer = 0;
    root.append(
      h(
        "button",
        {
          title: `${NAMES[key]}: ${VARIANTS[key].join(" · ")}`,
          onclick: () => cycle(key, 1),
          oncontextmenu: (e) => {
            e.preventDefault();
            cycle(key, -1);
          },
          ontouchstart: () => (timer = setTimeout(() => cycle(key, -1), 550)),
          ontouchend: () => clearTimeout(timer),
        },
        h("span", { class: "k" }, NAMES[key]),
        h("span", { class: "v" }, label),
      ),
    );
  }
  root.append(h("button", { class: "h-toggle", title: "Hide", onclick: () => update({ harness: false }) }, "×"));
}
