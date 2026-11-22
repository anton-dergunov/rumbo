// Local commits as the owner reads them (docs/plans/real-app.md §3, "Commit and push"): what an
// edit did, said from its ops, and the commit message for one or several folded edits; and the
// spacing context an edit used, kept small enough to store with each pending commit. Pure.
//
//   Rumbo: Done "Book dentist" (iPad)
//   Rumbo: Move "Buy stamps" to Errands (iPhone)
//   Rumbo: Move 3 headings in Inbox (iPad)
//   Rumbo: 4 edits in Inbox, Errands (iPad)

import { edgeMemory, mergeMemory } from "./spacing.js";

const MAX_TITLE = 50;

const cut = (t) => {
  const s = String(t ?? "").replace(/\s+/g, " ").trim();
  return s.length > MAX_TITLE ? `${s.slice(0, MAX_TITLE - 1).trimEnd()}…` : s;
};
const q = (t) => `"${cut(t)}"`;

/** A path as the navigation names it: the base name, without `.org`, underscores as spaces. */
export const fileLabel = (path) => String(path || "").split("/").pop().replace(/\.org$/, "").replace(/_/g, " ");

const STATE_WORDS = { TODO: "To do", NEXT: "Next", INPR: "In progress", WAIT: "Waiting", MAYB: "Maybe", DONE: "Done" };

/** What one op did: {verb, text}. */
function one(op) {
  const t = op.key?.title;
  const a = op.args || {};
  switch (op.op) {
    case "setState":
      return a.state ? { verb: STATE_WORDS[a.state] || a.state, text: `${STATE_WORDS[a.state] || a.state} ${q(t)}` } : { verb: "Clear state", text: `Clear the state of ${q(t)}` };
    case "setPriority":
      return a.priority ? { verb: "Prioritise", text: `Prioritise ${q(t)}` } : { verb: "Unprioritise", text: `Clear the priority of ${q(t)}` };
    case "setTitle":
      return { verb: "Rename", text: `Rename ${q(t)} to ${q(a.title)}` };
    case "setTags":
      return { verb: "Tag", text: `Tag ${q(t)}` };
    case "setPlanning":
      return { verb: "Date", text: `Date ${q(t)}` };
    case "setBody":
      return { verb: "Edit", text: `Edit the notes of ${q(t)}` };
    case "setHeading":
      return { verb: "Edit", text: `Edit ${q(a.patch?.title ?? t)}` };
    case "insertHeading":
      return { verb: "Add", text: `Add ${q(a.fields?.title)}` };
    case "deleteSubtree":
      return { verb: "Delete", text: `Delete ${q(t)}` };
    case "removeDone":
      return { verb: "Remove done", text: `Remove done tasks in ${a.scope ? q(a.scope.title) : fileLabel(op.path)}` };
    case "moveSubtree":
    case "moveUp":
    case "moveDown":
      return { verb: "Move", text: `Move ${q(t)}` };
    case "promote":
      return { verb: "Promote", text: `Promote ${q(t)}` };
    case "demote":
      return { verb: "Demote", text: `Demote ${q(t)}` };
    case "extractSubtree":
      return { verb: "Move", text: `Move ${q(t)} out of ${fileLabel(op.path)}` };
    case "insertSubtree":
      return { verb: "Move", text: `Move a section to ${fileLabel(op.path)}` };
    default:
      return { verb: "Edit", text: `Edit ${fileLabel(op.path)}` };
  }
}

/**
 * What one edit did, from its ops: {verb, text}. The task dialog's ops (planning, notes, heading)
 * are one "Edit"; a move across files (extract, then insert) is one "Move … to <file>".
 */
export function summarize(ops) {
  if (!ops?.length) return { verb: "Edit", text: "Edit" };
  const ex = ops.find((o) => o.op === "extractSubtree");
  const ins = ops.find((o) => o.op === "insertSubtree");
  if (ex && ins && ex.path !== ins.path) return { verb: "Move", text: `Move ${q(ex.key?.title)} to ${fileLabel(ins.path)}` };
  const head = ops.find((o) => o.op === "setHeading");
  if (ops.length > 1 && head) return one(head);
  return one(ops[0]);
}

/** An undo of an edit that said `summary`. */
export const undoSummary = (summary) => ({ verb: "Undo", text: `Undo: ${summary?.text || "an edit"}` });

/**
 * The message of a local commit from its parts [{summary: {verb, text}, paths}] and the device's
 * name. One part says what it did; several say how many and where.
 */
export function commitMessage(parts, device = "") {
  const tail = device ? ` (${device})` : "";
  if (parts.length === 1) return `Rumbo: ${parts[0].summary.text}${tail}`;
  const files = [...new Set(parts.flatMap((p) => p.paths || []))].map(fileLabel);
  const where = files.length ? ` in ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` and ${files.length - 3} more` : ""}` : "";
  const verbs = new Set(parts.map((p) => p.summary.verb));
  const what = verbs.size === 1 && !verbs.has("Undo") ? `${[...verbs][0]} ${parts.length} headings` : `${parts.length} edits`;
  return `Rumbo: ${what}${where}${tail}`;
}

// ---------------------------------------------------------------- the spacing context

/**
 * The context an edit resolved its seams with (spacing.js: the rule and the edge memory), to keep
 * with a pending commit for the replay after a rebase. The memory is kept only where it says more
 * than the file it ran on (`beforeDoc`) does, as entries, so a commit doesn't carry the whole file
 * again. It is a hint for placing blank lines; the invariants guard the result either way.
 */
export function saveContext(ctx, beforeDoc) {
  const own = edgeMemory(beforeDoc);
  const memory = [];
  for (const [k, v] of ctx?.memory || []) {
    const o = own.get(k);
    if (!o || o.length !== v.length || o.some((x, i) => x !== v[i])) memory.push([k, v]);
  }
  return { rule: ctx?.rule ?? null, memory };
}

/** A saved context folded into the one kept so far for the same file: the later entries win. */
export function foldContext(older, newer) {
  if (!older) return newer;
  const m = new Map(older.memory);
  for (const [k, v] of newer.memory) m.set(k, v);
  return { rule: newer.rule ?? older.rule, memory: [...m] };
}

/** The context for ops on `doc` (the text a replay runs on): its own memory, then the saved one on top. */
export function restoreContext(saved, doc) {
  return { rule: saved?.rule ?? null, memory: mergeMemory(edgeMemory(doc), new Map(saved?.memory || [])) };
}

/**
 * The record of one edit for store.recordEdit: `files` [{path, before, after, doc, ctx}] with the
 * parsed text each ran on (`doc`) and the spacing context it used. The same for the app and tests.
 */
export function editRecord({ id, label = "", ops, files }) {
  return {
    id,
    label,
    summary: summarize(ops),
    ops,
    files: files.map(({ path, before, after }) => ({ path, before, after })),
    ctx: Object.fromEntries(files.filter((f) => f.ctx && f.doc).map((f) => [f.path, saveContext(f.ctx, f.doc)])),
  };
}
