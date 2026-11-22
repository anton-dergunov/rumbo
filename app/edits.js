// Applying edits: run ops (ops.js) on a file's lines, rebuild the model, keep the reader's place
// (fold state, focus, open rows) on the re-parsed headings, record undo, and store the edit.
//
// Storing: the page changes at once; the edit then goes, in order, to store.recordEdit, which
// writes the file's new working text and the local commit holding it in one transaction (edits
// under 3 s apart fold into one commit). The sync engine pushes it (sync.js). If the store refuses
// (the file changed meanwhile, or IndexedDB didn't answer), the owner is told and the page is
// reloaded from what the store really holds. A pull that rebased the file under a queued edit
// makes the store refuse it as stale: the edit's ops then run again on the stored text (as a
// rebase replays them), and only if that fails is it refused. Undo goes the same way
// (store.undoEdit): before a push it takes the edit off its commit, after a push it is a new
// commit with the old text.

import { joinLines, headingKey, findHeading } from "./org-edit.js";
import { applyOps, OpError } from "./ops.js";
import { edgeMemory, mergeMemory } from "./spacing.js";
import { editRecord, undoSummary } from "./commits.js";
import { replayCommit } from "./merge.js";
import { StoreError } from "./store.js";
import { rebuildFile } from "./data.js";
import { state, overridesFor } from "./state.js";

let model = null;
let store = null;
let notify = () => {};
let redraw = () => {};
let committed = () => {};
let reload = () => {};

export function setEditModel(m) {
  model = m;
}
/** The replica's store, where edits become local commits. */
export function setStore(s) {
  store = s;
}
/** `fn(notice)` shows a notice: {text, kind, action?: {label, run}, sticky?}. */
export const onNotice = (fn) => (notify = fn);
/** `fn(idMap)` draws the page again; idMap takes the old heading ids to the re-parsed ones. */
export const onRedraw = (fn) => (redraw = fn);
/** `fn()` after each edit or undo is stored (the sync engine is asked to push, debounced). */
export const onCommitted = (fn) => (committed = fn);
/** `fn()` when an edit could not be stored: the page is built again from the store. */
export const onReload = (fn) => (reload = fn);

const undoStack = [];

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
  const why = cantEdit(file);
  if (why) {
    notify({ text: why, kind: "error" });
    return null;
  }
  let ops, result, ctx;
  try {
    ops = asList(build(file.doc)).map((op) => ({ ...op, path }));
    ctx = ctxFor(file);
    result = applyOps(file.doc.lines, file.doc, ops, ctx);
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
  const rec = editRecord({ id: nextId(), label, ops, files: [{ path, before, after, doc: oldDoc, ctx }] });
  pushUndo({ id: rec.id, label, summary: rec.summary, files: rec.files });
  persist(() => recordOrReplay(rec));
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
    const why = cantEdit(f);
    if (why) return notify({ text: why, kind: "error" }), null;
  }
  let a, b, opA, opB;
  const ctxA = ctxFor(src);
  const ctxB = ctxFor(dst);
  try {
    opA = { ...take(src.doc), path: srcPath };
    a = applyOps(src.doc.lines, src.doc, [opA], ctxA);
    opB = { ...put(dst.doc, a.results[0].chunk, a.results[0].level), path: dstPath };
    b = applyOps(dst.doc.lines, dst.doc, [opB], ctxB);
  } catch (err) {
    notify({ text: refusal(err), kind: "error" });
    return null;
  }
  const files = [];
  const idMap = new Map();
  for (const [f, r, ctx] of [[src, a, ctxA], [dst, b, ctxB]]) {
    const before = f.text;
    const after = joinLines(r.lines, f.doc.finalNewline || !f.doc.lines.length);
    const oldDoc = f.doc;
    rebuildFile(model, f.path, after);
    remember(f);
    for (const [k, v] of remap(f.path, oldDoc, f.doc, r.map)) idMap.set(k, v);
    files.push({ path: f.path, before, after, doc: oldDoc, ctx });
  }
  const rec = editRecord({ id: nextId(), label, ops: [opA, opB], files });
  pushUndo({ id: rec.id, label, summary: rec.summary, files: rec.files });
  persist(() => recordOrReplay(rec));
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
  }
  persist(() => store.undoEdit({ id: entry.id, label: `Undone: ${entry.label}`, summary: undoSummary(entry.summary), files: entry.files }));
  notify({ text: `Undone: ${entry.label.toLowerCase()}`, kind: "done" });
  redraw(idMap);
}

// ---------------------------------------------------------------- storing

const session = Date.now().toString(36);
let seq = 0;
const nextId = () => `${session}-${++seq}`;

function pushUndo(entry) {
  undoStack.push(entry);
  if (undoStack.length > 20) undoStack.shift();
}

/** Why a file can't be edited now, or null. */
function cantEdit(file) {
  if (!model.writable || !store) return "This copy of the vault can't be edited yet.";
  return readOnlyReason(file);
}

/**
 * Store an edit. If its files changed in the store since the page read them (a pull rebased them),
 * run its ops again on the stored text and store that; the page is then rebuilt from the store.
 */
async function recordOrReplay(rec) {
  try {
    return await store.recordEdit(rec);
  } catch (err) {
    if (!(err instanceof StoreError && err.code === "stale") || !rec.ops?.length) throw err;
    const stored = new Map((await store.allFiles()).map((f) => [f.path, f]));
    const texts = Object.fromEntries(rec.files.map((f) => [f.path, stored.get(f.path) ? (stored.get(f.path).work ?? stored.get(f.path).text) : undefined]));
    let r;
    try {
      r = replayCommit({ files: Object.fromEntries(rec.files.map((f) => [f.path, f])), ops: rec.ops, ctx: rec.ctx }, texts);
    } catch {
      throw err;
    }
    const files = rec.files.map((f) => ({ path: f.path, before: texts[f.path], after: r.files[f.path] }));
    const again = { ...rec, ops: r.ops, files };
    await store.recordEdit(again);
    const entry = undoStack.find((e) => e.id === rec.id);
    if (entry) entry.files = files;
    reload();
  }
}

// One write at a time, in the order the edits were made: each one's `before` is the text the one
// before it left.
let queue = Promise.resolve();
let queued = 0;

function persist(write) {
  queued += 1;
  queue = queue.then(write).then(
    () => committed(),
    (err) => {
      // The page shows an edit the store doesn't hold: say so, and show what it does hold.
      undoStack.length = 0;
      notify({ text: `Not saved on this device: ${err.message}`, kind: "error", sticky: true });
      reload();
    },
  );
}

/** Resolves once every edit made so far is stored (or refused). */
export const settled = () => queue;
/** How many edits have been sent to the store; a reload checks that none came in while it read. */
export const queuedCount = () => queued;
