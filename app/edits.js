// Applying edits: run ops (ops.js) on a file's lines, rebuild the model, keep the
// reader's place (fold state, focus, open rows) on the re-parsed headings, record undo, and save.
//
// Saving: one save in flight at a time; edits made meanwhile go in the next one. A save sends each
// file with the version it was read at. If the file changed underneath (409), the edits made since
// the last save are applied again to the new text (the journal holds ops, ops.js), finding each heading by its title path; if any of
// them cannot be placed, the file is reloaded and the owner is told. Only the sample vault's working
// copy is written; edits to the real vault stay in memory in this prototype.
//
// In the app (plan step 2) the model is never writable, so edits stay on the page and save() is
// never reached; plan step 4 replaces it with local commits through store.js.

import { joinLines, headingKey, findHeading } from "./org-edit.js";
import { applyOps, OpError } from "./ops.js";
import { edgeMemory, mergeMemory } from "./spacing.js";
import { parseOrg } from "./org.js";
import { rebuildFile } from "./data.js";
import { state, overridesFor } from "./state.js";

let model = null;
let notify = () => {};
let redraw = () => {};

export function setEditModel(m) {
  model = m;
}
/** `fn(notice)` shows a notice: {text, kind, action?: {label, run}, sticky?}. */
export const onNotice = (fn) => (notify = fn);
/** `fn(idMap)` draws the page again; idMap takes the old heading ids to the re-parsed ones. */
export const onRedraw = (fn) => (redraw = fn);

const undoStack = [];
const journal = new Map(); // path -> edits not yet saved, to re-apply after a conflict
const dirty = new Set();
let saving = false;
let again = false;

export const canUndo = () => undoStack.length > 0;
export const readOnlyReason = (file) =>
  file.readOnly === "not-utf8" ? "This file is not valid UTF-8; it is shown but not edited." : file.doc.hasCR ? "This file has Windows line endings; it is shown but not edited." : null;

// ---------------------------------------------------------------- keeping the reader's place

/** Carry ids from the old parse to the new one through the edit's line map. */
function remap(path, oldDoc, newDoc, map) {
  const byLine = new Map(newDoc.headings.map((h) => [h.line, h]));
  const idMap = new Map();
  for (const h of oldDoc.headings) {
    const n = byLine.get(map(h.line));
    if (n) idMap.set(h.id, n.id);
  }
  const ov = overridesFor(path);
  const next = new Map();
  for (const [id, v] of ov) if (idMap.has(id)) next.set(idMap.get(id), v);
  state.overrides.set(path, next);
  if (state.file === path && state.focus) state.focus = idMap.get(state.focus) || null;
  for (const set of [state.agendaOpen, state.agendaShut]) {
    const keep = [...set].filter((id) => !oldDoc.headings.some((h) => h.id === id));
    const moved = [...set].map((id) => idMap.get(id)).filter(Boolean);
    set.clear();
    for (const id of [...keep, ...moved]) set.add(id);
  }
  // The history entries' URLs may hold old focus ids; the current one is rewritten on the next update().
  return idMap;
}

/** Ids for the same file parsed again without an edit map (a reload): match by title path. */
function remapByKey(path, oldDoc, newDoc) {
  const idMap = new Map();
  for (const h of oldDoc.headings) {
    const n = findHeading(newDoc, headingKey(oldDoc, h));
    if (n) idMap.set(h.id, n.id);
  }
  const ov = overridesFor(path);
  const next = new Map();
  for (const [id, v] of ov) if (idMap.has(id)) next.set(idMap.get(id), v);
  state.overrides.set(path, next);
  if (state.file === path && state.focus) state.focus = idMap.get(state.focus) || null;
  return idMap;
}

// ---------------------------------------------------------------- applying

/** The edge memory of a file (spacing.js): its runs as loaded and after every edit here, newest winning. */
const memories = new Map();
function ctxFor(file) {
  if (!memories.has(file.path)) memories.set(file.path, edgeMemory(file.doc));
  return { rule: model.spacing || null, memory: memories.get(file.path) };
}
const remember = (file) => memories.set(file.path, mergeMemory(memories.get(file.path), edgeMemory(file.doc)));

const asList = (x) => (Array.isArray(x) ? x : [x]);

function refusal(err) {
  if (err instanceof OpError && err.code === "lost") return "The file changed meanwhile; nothing was edited. Try again.";
  if (err instanceof OpError && err.code === "invariant") return `Not edited: the change would have touched more of the file than it should (${err.message}).`;
  return err.message;
}

/**
 * Apply one edit to one file.
 *   path   the file
 *   label  what the toast says, e.g. "Marked done"
 *   build  (doc) => op or [ops] (ops.js makeOp), made against the file as it is now; a heading from
 *          before a redraw makes makeOp refuse
 * Returns the heading at `at` in the new parse (the edited or new heading), or null.
 */
export function edit(path, label, build, { quiet = false } = {}) {
  const file = model.byPath.get(path);
  const why = readOnlyReason(file);
  if (why) {
    notify({ text: why, kind: "error" });
    return null;
  }
  let ops, result;
  try {
    ops = asList(build(file.doc)).map((op) => ({ ...op, path }));
    result = applyOps(file.doc.lines, file.doc, ops, ctxFor(file));
  } catch (err) {
    notify({ text: refusal(err), kind: "error" });
    return null;
  }
  const before = file.text;
  const after = joinLines(result.lines, file.doc.finalNewline);
  if (after === before) return headingAt(file, result.at);
  const oldDoc = file.doc;
  rebuildFile(model, path, after);
  remember(file);
  const idMap = remap(path, oldDoc, file.doc, result.map);
  undoStack.push({ label, files: [{ path, before, after }] });
  if (undoStack.length > 20) undoStack.shift();
  if (!journal.has(path)) journal.set(path, []);
  journal.get(path).push({ ops });
  queueSave([path]);
  if (!quiet) notify({ text: label, kind: "done", action: { label: "Undo", run: undo } });
  redraw(idMap);
  return headingAt(file, result.at);
}

const headingAt = (file, at) => (at >= 0 ? file.doc.headings.find((h) => h.line === at) || null : null);

/**
 * A move from one file to another, as one edit in both: `take(srcDoc)` makes the extractSubtree op,
 * `put(dstDoc, chunk, level)` the insertSubtree op that carries the taken lines.
 */
export function editTwo(srcPath, dstPath, label, take, put) {
  const src = model.byPath.get(srcPath);
  const dst = model.byPath.get(dstPath);
  for (const f of [src, dst]) {
    const why = readOnlyReason(f);
    if (why) return notify({ text: why, kind: "error" }), null;
  }
  let a, b, opA, opB;
  try {
    opA = { ...take(src.doc), path: srcPath };
    a = applyOps(src.doc.lines, src.doc, [opA], ctxFor(src));
    opB = { ...put(dst.doc, a.results[0].chunk, a.results[0].level), path: dstPath };
    b = applyOps(dst.doc.lines, dst.doc, [opB], ctxFor(dst));
  } catch (err) {
    notify({ text: refusal(err), kind: "error" });
    return null;
  }
  const entry = { label, files: [] };
  const idMap = new Map();
  for (const [f, r, op] of [[src, a, opA], [dst, b, opB]]) {
    const before = f.text;
    const after = joinLines(r.lines, f.doc.finalNewline || !f.doc.lines.length);
    const oldDoc = f.doc;
    rebuildFile(model, f.path, after);
    remember(f);
    for (const [k, v] of remap(f.path, oldDoc, f.doc, r.map)) idMap.set(k, v);
    entry.files.push({ path: f.path, before, after });
    if (!journal.has(f.path)) journal.set(f.path, []);
    journal.get(f.path).push({ ops: [op] });
  }
  undoStack.push(entry);
  queueSave([srcPath, dstPath]);
  notify({ text: label, kind: "done", action: { label: "Undo", run: undo } });
  redraw(idMap);
  return headingAt(dst, b.at);
}

/** Undo the last edit: put back each file's text from before it, if nothing changed it since. */
export function undo() {
  const entry = undoStack.pop();
  if (!entry) return;
  for (const f of entry.files) {
    if (model.byPath.get(f.path).text !== f.after) {
      notify({ text: "Can't undo: the file has changed since.", kind: "error" });
      return;
    }
  }
  const idMap = new Map();
  for (const f of entry.files) {
    const file = model.byPath.get(f.path);
    const oldDoc = file.doc;
    rebuildFile(model, f.path, f.before);
    for (const [k, v] of remapByKey(f.path, oldDoc, file.doc)) idMap.set(k, v);
    if (!journal.has(f.path)) journal.set(f.path, []);
    journal.get(f.path).push({ ops: null, restore: f });
  }
  queueSave(entry.files.map((f) => f.path));
  notify({ text: `Undone: ${entry.label.toLowerCase()}`, kind: "done" });
  redraw(idMap);
}

// ---------------------------------------------------------------- saving

function queueSave(paths) {
  for (const p of paths) dirty.add(p);
  if (!model.writable) {
    // Until the write path (plan step 4), edits stay on this page.
    journal.clear();
    dirty.clear();
    setTimeout(() => notify({ text: "Changed on this page only: this version of Rumbo doesn't save edits yet.", kind: "memory" }), 1600);
    return;
  }
  save();
}

let slowTimer = 0;
async function save() {
  if (saving) {
    again = true;
    return;
  }
  if (!dirty.size) return;
  saving = true;
  const paths = [...dirty];
  dirty.clear();
  const sent = new Map(paths.map((p) => [p, model.byPath.get(p).text]));
  clearTimeout(slowTimer);
  slowTimer = setTimeout(() => notify({ text: "Saving…", kind: "saving", sticky: true }), 600);
  try {
    const res = await fetch("/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: model.data, files: paths.map((p) => ({ path: p, version: model.byPath.get(p).version, text: sent.get(p) })) }),
    });
    const reply = await res.json().catch(() => ({}));
    clearTimeout(slowTimer);
    if (res.status === 409) {
      resolveConflicts(reply.conflicts || [], paths);
    } else if (!res.ok) {
      throw new Error(reply.error || `HTTP ${res.status}`);
    } else {
      for (const s of reply.saved || []) {
        const f = model.byPath.get(s.path);
        f.version = s.version;
        // Edits made while this save was in flight stay in the journal for the next save.
        if (f.text === sent.get(s.path)) journal.delete(s.path);
      }
      notify({ text: "Saved", kind: "saved", quietIfActive: true });
    }
  } catch (err) {
    clearTimeout(slowTimer);
    for (const p of paths) dirty.add(p);
    notify({ text: `Not saved: ${err.message}`, kind: "error", sticky: true, action: { label: "Retry", run: save } });
  } finally {
    saving = false;
    if (again) {
      again = false;
      save();
    }
  }
}

/** The files changed underneath: apply this page's unsaved edits again to their new text, or reload. */
function resolveConflicts(conflicts, paths) {
  const lost = [];
  const idMap = new Map();
  for (const c of conflicts) {
    const file = model.byPath.get(c.path);
    const pending = journal.get(c.path) || [];
    let doc = parseOrg(c.text);
    let lines = doc.lines;
    let ok = pending.length > 0;
    for (const j of pending) {
      if (!j.ops) {
        ok = false;
        break;
      }
      try {
        lines = applyOps(lines, doc, j.ops, ctxFor(file)).lines;
        doc = parseOrg(joinLines(lines, doc.finalNewline));
      } catch {
        ok = false;
        break;
      }
    }
    const oldDoc = file.doc;
    const mine = file.text;
    if (ok) {
      rebuildFile(model, c.path, joinLines(doc.lines, doc.finalNewline), c.version);
      for (const [k, v] of remapByKey(c.path, oldDoc, file.doc)) idMap.set(k, v);
      dirty.add(c.path);
    } else {
      rebuildFile(model, c.path, c.text, c.version);
      for (const [k, v] of remapByKey(c.path, oldDoc, file.doc)) idMap.set(k, v);
      journal.delete(c.path);
      lost.push({ path: c.path, mine });
    }
    // An undo entry no longer matches a file that was reloaded.
    for (let i = undoStack.length - 1; i >= 0; i--) if (undoStack[i].files.some((f) => f.path === c.path)) undoStack.splice(i, 1);
  }
  // Files of the same save that did not conflict were not written either: send them again.
  for (const p of paths) if (!conflicts.some((c) => c.path === p)) dirty.add(p);
  if (lost.length) {
    const names = lost.map((l) => model.byPath.get(l.path).title).join(", ");
    notify({
      text: `${names} changed on another device. It was reloaded; your last change could not be applied.`,
      kind: "conflict",
      sticky: true,
      action: { label: "Copy my version", run: () => navigator.clipboard?.writeText(lost.map((l) => l.mine).join("\n\n")) },
    });
  } else {
    notify({ text: "The file changed on another device; your change was applied to the new version.", kind: "conflict" });
  }
  redraw(idMap);
  save();
}

window.addEventListener("online", () => save());
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && save());
