// Task icons from Emacs: the keys of `.ps/task-icons.json` (docs/plans/real-app.md §7). Pure.
//
// Emacs keys each task by the fields its icon model reads, as JSON in a fixed order: the title
// as `org-get-heading t t t t` gives it (Org markup kept; keyword, priority, tags and COMMENT
// dropped) and, when the model reads them, the parents as `org-get-outline-path` gives them
// (each heading without its keyword, priority, COMMENT and tags, statistics cookies removed,
// links shown as their description). Checked against Org 9.7.11; `tools/icon-check.mjs` checks
// the keys against the real Emacs cache.

/** The fields Emacs's current bundle reads, for a file that doesn't say. */
export const DEFAULT_INPUTS = ["title", "parents"];

const COMMENT_RE = /^COMMENT(?:[ \t]+|$)/;
// org--get-outline-path-1 removes statistics cookies such as [2/5] and [40%], leaving the spaces.
const COOKIE_RE = /\[[0-9]*(?:%|\/[0-9]*)\]/g;
// org-link-display-format: a bracket link shows its description, else its target.
const LINK_RE = /\[\[((?:[^\]\\]|\\.)+)\](?:\[([^\]]*)\])?\]/g;

/** A heading's title as Emacs's key holds it. */
export const emacsTitle = (h) => h.title.replace(COMMENT_RE, "").trim();

/** One outline-path entry, as `org-get-outline-path` gives it. */
export const outlineEntry = (h) =>
  emacsTitle(h)
    .replace(COOKIE_RE, "")
    .replace(LINK_RE, (_, target, desc) => desc || target)
    .trim();

/** The headings above `h`, outermost first, as Emacs's key holds them. */
export const outlinePath = (h) => (h.path || []).map(outlineEntry);

/** The task fields `inputs` asks for, in Emacs's order (title, parents). Null for an empty title. */
export function iconTask(h, inputs = DEFAULT_INPUTS) {
  const title = emacsTitle(h);
  if (!title) return null;
  const task = { title };
  if (inputs.includes("parents")) task.parents = outlinePath(h);
  return task;
}

/** The canonical key for a task's fields: JSON with the fields in a fixed order. */
export function keyOf(task) {
  const out = { title: task.title };
  if (task.parents) out.parents = task.parents;
  if (task.body) out.body = task.body;
  return JSON.stringify(out);
}

/** The key of heading `h`, or null when the inputs can't be built here (a body) or the title is empty. */
export function iconKey(h, inputs = DEFAULT_INPUTS) {
  if (inputs.includes("body")) return null;
  const task = iconTask(h, inputs);
  return task ? keyOf(task) : null;
}

/**
 * `.ps/task-icons.json` → `{tag, inputs, map}`, where `map` is canonical key → icon name, or ""
 * for Emacs's "no icon". Each key is parsed and written again, so the way Emacs's JSON writer
 * escapes a string never decides whether a key matches. A bad file gives an empty map.
 */
export function parseIconFile(text) {
  const empty = { tag: null, inputs: DEFAULT_INPUTS, map: new Map() };
  if (!text) return empty;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return empty;
  }
  if (!data || typeof data.map !== "object" || data.map === null) return empty;
  const map = new Map();
  for (const [raw, icon] of Object.entries(data.map)) {
    if (typeof icon !== "string") continue;
    let task;
    try {
      task = JSON.parse(raw);
    } catch {
      continue;
    }
    if (task && typeof task.title === "string") map.set(keyOf(task), icon);
  }
  const inputs = Array.isArray(data.inputs) && data.inputs.length ? data.inputs.map(String) : DEFAULT_INPUTS;
  return { tag: typeof data.tag === "string" ? data.tag : null, inputs, map };
}
