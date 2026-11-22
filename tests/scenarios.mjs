// The sync scenario harness (docs/plans/real-app.md §8, "Sync scenarios"): replicas of Rumbo on the
// fake GitHub, each with its own IndexedDB; Emacs as another writer; edits made the way edits.js
// makes them (ops on the stored working text, then store.recordEdit), without the DOM; and a kill
// switch that stops a sync at any request, so the app can be "restarted" from its database.

import { createFakeGitHub } from "./fake-github.mjs";
import { freshIdb } from "./idb.mjs";
import { createRemote } from "../app/remote-github.js";
import { openStore } from "../app/store.js";
import { pull, syncOnce } from "../app/sync.js";
import { parseOrg, OPEN_STATES } from "../app/org.js";
import { applyOps } from "../app/ops.js";
import { joinLines } from "../app/org-edit.js";
import { edgeMemory } from "../app/spacing.js";
import { editRecord, undoSummary } from "../app/commits.js";

export const STATES = [...OPEN_STATES, "DONE"];
export const parse = (text) => parseOrg(text, { states: STATES });

/** A fake GitHub with one first commit of `files`. */
export function github(files) {
  const gh = createFakeGitHub();
  gh.push(files, "First");
  return gh;
}

/** A Rumbo replica on `gh`: its own database, set up and cloned. `clock` drives folding. */
export async function replica(gh, { device = "iPad" } = {}) {
  const r = { gh, device, idb: freshIdb(), clock: 1_000_000, edits: 0 };
  open(r);
  await r.store.setMeta({ repo: `${gh.owner}/${gh.repo}`, branch: gh.branch, token: "t", device });
  await pull({ remote: r.remote, store: r.store });
  return r;
}

function open(r, fetch = r.gh.fetch) {
  r.store = openStore({ indexedDB: r.idb });
  r.remote = createRemote({ owner: r.gh.owner, repo: r.gh.repo, branch: r.gh.branch, token: "t", fetch });
}

/** The app was killed and opened again: a new store on the same database, a new remote. */
export function restart(r, fetch) {
  r.store.close();
  open(r, fetch);
}

/** The working text of `path` on this replica. */
export async function textOf(r, path) {
  const f = (await r.store.allFiles()).find((x) => x.path === path);
  return f ? (f.work ?? f.text) : undefined;
}

const asList = (x) => (Array.isArray(x) ? x : [x]);

/**
 * An edit on one file, as edits.js makes it: `build(doc)` gives the op(s). `gap` is the time since
 * the last edit (under 3 s folds it into the same local commit). Returns the stored edit record.
 */
export async function edit(r, path, build, { label = "Edited", gap = 10_000 } = {}) {
  const before = await textOf(r, path);
  const doc = parse(before);
  const ctx = { rule: null, memory: edgeMemory(doc) };
  const ops = asList(build(doc)).map((op) => ({ ...op, path }));
  const res = applyOps(doc.lines, doc, ops, ctx);
  const after = joinLines(res.lines, doc.finalNewline);
  const rec = editRecord({ id: `${r.device}-${++r.edits}`, label, ops, files: [{ path, before, after, doc, ctx }] });
  r.clock += gap;
  await r.store.recordEdit(rec, { now: r.clock });
  return rec;
}

/** A move across files: `take(srcDoc)` the extract op, `put(dstDoc, chunk, level)` the insert op. */
export async function editTwo(r, src, dst, take, put, { label = "Moved", gap = 10_000 } = {}) {
  const out = [];
  const ops = [];
  let chunk, level;
  for (const [path, mk] of [[src, (d) => take(d)], [dst, (d) => put(d, chunk, level)]]) {
    const before = await textOf(r, path);
    const doc = parse(before);
    const ctx = { rule: null, memory: edgeMemory(doc) };
    const op = { ...mk(doc), path };
    const res = applyOps(doc.lines, doc, [op], ctx);
    if (path === src) ({ chunk, level } = res.results[0]);
    ops.push(op);
    out.push({ path, before, after: joinLines(res.lines, doc.finalNewline || !doc.lines.length), doc, ctx });
  }
  const rec = editRecord({ id: `${r.device}-${++r.edits}`, label, ops, files: out });
  r.clock += gap;
  await r.store.recordEdit(rec, { now: r.clock });
  return rec;
}

/** Undo an edit made by `edit` or `editTwo`. */
export async function undo(r, rec, { gap = 1000 } = {}) {
  r.clock += gap;
  return r.store.undoEdit({ id: rec.id, label: "Undone", summary: undoSummary(rec.summary), files: rec.files }, { now: r.clock });
}

/** One sync pass. */
export const sync = (r) => syncOnce({ remote: r.remote, store: r.store });

/** Sync until a pass has nothing left to do. */
export async function settle(r, max = 6) {
  for (let i = 0; i < max; i++) {
    const res = await sync(r);
    if (!res.pushed && !res.changed) return;
  }
  throw new Error("the replica did not settle");
}

/**
 * A fetch that works for requests before the `n`th (counting from 1) and hangs from it on, as if
 * the app were killed while waiting. With `processed`, the `n`th request reaches the fake first and
 * only its answer is lost. `hit` resolves when the kill happens.
 */
export function killAt(gh, n, { processed = false } = {}) {
  let count = 0;
  let resolveHit;
  const hit = new Promise((r) => (resolveHit = r));
  const fetch = async (url, init) => {
    count += 1;
    if (count < n) return gh.fetch(url, init);
    if (count === n) {
      if (processed) await gh.fetch(url, init);
      resolveHit();
    }
    return new Promise(() => {});
  };
  return { fetch, hit };
}

/** Commits on `main` made by Rumbo, oldest first. */
export const rumboCommits = (gh) => gh.log().filter((c) => c.author === "Rumbo").reverse();

/** Every replica file equals `main`, and nothing is waiting. */
export async function converged(r) {
  const head = r.gh.filesAt(r.gh.head());
  const files = await r.store.allFiles();
  const pending = await r.store.pending();
  const meta = await r.store.getMeta();
  const mismatch = files.filter((f) => f.work !== null || head[f.path] !== f.text).map((f) => f.path);
  return { ok: !pending.length && !mismatch.length && meta.base === r.gh.head(), pending: pending.length, mismatch, base: meta.base };
}
