// The rebase of local commits onto a newer head (docs/plans/real-app.md §3, "When GitHub moved on:
// rebase"), and the diffs the Sync page, the conflict screen and the zip show. Pure, no DOM, tested
// in tests/merge.test.mjs.
//
// For each pending commit, in order, against the text the commits before it left (starting from
// the new head's):
//   1. keep      no file it touches changed upstream: the commit stays as it is;
//   2. replay    run its ops again (ops.js applyOp, headings found by title path). All its files are
//                replayed together, so a section moved from one file to another carries what the
//                Mac changed inside it. A commit with an opaque part (an undo) has no ops to replay;
//   3. merge     a 3-way merge per file (node-diff3): base = its `before`, ours = its `after`,
//                theirs = the new text. Clean only with no conflict, no new marker lines, and no
//                heading line that is in neither side;
//   4. conflict  anything else, or a file deleted upstream or now read-only there.
// A conflict stops the whole rebase; every file in conflict is listed, so the screen shows them all.

import { merge as diff3, diff3Merge, diffPatch } from "./vendor/diff3.mjs";
import { parseOrg, OPEN_STATES } from "./org.js";
import { joinLines } from "./org-edit.js";
import { applyOp, OpError } from "./ops.js";
import { edgeMemory, mergeMemory } from "./spacing.js";
import { restoreContext, commitMessage } from "./commits.js";

const STATES = [...OPEN_STATES, "DONE"];
const parse = (text) => parseOrg(text, { states: STATES });
const MARKER_RE = /^(<{7}|={7}|>{7})/;
const markers = (lines) => lines.filter((l) => MARKER_RE.test(l)).length;
const HEADING_RE = /^\*+\s/;
/** Two texts are the same file state; null and undefined both mean "no such file". */
const same = (x, y) => (x ?? null) === (y ?? null);

/** Whether a commit can be replayed: every part of it has ops (an undo is opaque). */
export const replayable = (c) => c.ops?.length > 0 && c.parts.every((p) => !p.opaque);

/**
 * Run a commit's ops again on `texts` (path → the text to replay on). Returns {files: path → text,
 * ops} (the ops as run: an insert after an extract carries the newly taken lines), or throws OpError.
 */
export function replayCommit(commit, texts) {
  const st = new Map();
  for (const path of Object.keys(commit.files)) {
    const text = texts[path];
    if (text == null) throw new OpError("lost", `${path} is gone`);
    if (text.includes("\r")) throw new OpError("invalid", `${path} has CR line endings`);
    const doc = parse(text);
    const before = commit.files[path].before;
    const ctx = restoreContext(commit.ctx?.[path], parse(before ?? ""));
    st.set(path, { doc, lines: doc.lines, ctx, nl: doc.finalNewline || !doc.lines.length });
  }
  const ops = [];
  let taken = null;
  for (const op of commit.ops) {
    const s = st.get(op.path);
    if (!s) throw new OpError("invalid", `an op on ${op.path}, which the commit doesn't touch`);
    let o = op;
    if (op.op === "insertSubtree" && taken) o = { ...op, args: { ...op.args, chunk: taken.chunk, fromLevel: taken.level } };
    taken = null;
    const r = applyOp(s.lines, s.doc, o, s.ctx);
    if (op.op === "extractSubtree") taken = { chunk: r.chunk, level: r.level };
    if (r.lines !== s.lines) {
      s.lines = r.lines;
      s.doc = parse(joinLines(r.lines, s.nl));
      s.ctx = { ...s.ctx, memory: mergeMemory(s.ctx.memory, edgeMemory(s.doc)) };
    }
    ops.push(o);
  }
  const files = {};
  for (const [path, s] of st) files[path] = joinLines(s.lines, s.nl);
  return { files, ops };
}

/**
 * A 3-way merge of one file: `before` → `after` here, `before` → `theirs` upstream. Returns the
 * merged text, or null when it doesn't merge cleanly.
 */
export function mergeText(before, after, theirs) {
  if (theirs === before) return after;
  if (after === before) return theirs;
  if (after === theirs) return after;
  const b = (before ?? "").split("\n");
  const a = after.split("\n");
  const t = theirs.split("\n");
  const r = diff3(a, b, t);
  if (r.conflict) return null;
  const out = r.result;
  if (markers(out) > Math.max(markers(a), markers(t))) return null;
  const known = new Set([...a, ...t]);
  if (out.some((l) => HEADING_RE.test(l) && !known.has(l))) return null;
  const text = out.join("\n");
  if (text.includes("\r")) return null;
  parse(text);
  return text;
}

/**
 * Rebase the pending commits onto a new head. `upstream(path)` gives {text, readOnly} of the new
 * head's file, or undefined when it is gone (deleted, or no longer one the app keeps).
 *
 * Returns {ok: true, commits, how, paths} with the rebased commits (same ids, `attempt` cleared on
 * those that changed) and per commit how each file went (kept | replayed | merged); or
 * {ok: false, conflicts: [{path, reason, base, mine, theirs}]}, `reason` being both | gone | readonly,
 * `base` the text before the first local commit on that file, `mine` the text after the last.
 */
export function rebasePending(pending, upstream, { onto = null } = {}) {
  const cur = {};
  const ro = new Set();
  const first = {};
  const last = {};
  for (const c of pending) {
    for (const [path, f] of Object.entries(c.files)) {
      if (!(path in cur)) {
        const u = upstream(path);
        cur[path] = u ? u.text : undefined;
        if (u?.readOnly) ro.add(path);
        first[path] = f.before;
      }
      last[path] = f.after;
    }
  }
  const failed = new Map();
  const fail = (path, reason) => failed.has(path) || failed.set(path, reason);

  const commits = [];
  const how = {};
  for (const c of pending) {
    const paths = Object.keys(c.files);
    const h = (how[c.id] = {});
    if (paths.every((p) => same(cur[p], c.files[p].before)) || paths.every((p) => failed.has(p))) {
      for (const p of paths) {
        h[p] = "kept";
        cur[p] = c.files[p].after;
      }
      commits.push(c);
      continue;
    }
    let out = null;
    let ops = c.ops;
    if (replayable(c) && !paths.some((p) => ro.has(p) || failed.has(p))) {
      try {
        const r = replayCommit(c, cur);
        out = r.files;
        ops = r.ops;
        for (const p of paths) h[p] = same(cur[p], c.files[p].before) && out[p] === c.files[p].after ? "kept" : "replayed";
      } catch (e) {
        if (!(e instanceof OpError)) throw e;
      }
    }
    if (!out) {
      out = {};
      for (const p of paths) {
        const f = c.files[p];
        if (failed.has(p)) continue;
        if (same(cur[p], f.before)) {
          out[p] = f.after;
          h[p] = "kept";
        } else if (cur[p] === undefined) fail(p, "gone");
        else if (ro.has(p)) fail(p, "readonly");
        else {
          const m = mergeText(f.before, f.after, cur[p]);
          if (m == null) fail(p, "both");
          else {
            out[p] = m;
            h[p] = "merged";
          }
        }
      }
    }
    const files = {};
    for (const p of paths) {
      if (failed.has(p)) continue;
      files[p] = { before: cur[p], after: out[p] };
      cur[p] = out[p];
    }
    commits.push({ ...c, ops, files, attempt: null, rebased: { onto, how: h } });
  }

  if (failed.size) {
    const conflicts = [...failed].map(([path, reason]) => ({ path, reason, base: first[path] ?? null, mine: last[path], theirs: cur[path] === undefined ? null : upstream(path)?.text ?? null }));
    return { ok: false, conflicts };
  }
  // A commit whose files all ended as they began leaves nothing to push.
  const kept = commits.filter((c) => Object.values(c.files).some((f) => f.before !== f.after));
  return { ok: true, commits: kept, dropped: commits.filter((c) => !kept.includes(c)).map((c) => c.id), how, paths: Object.keys(cur) };
}

// ---------------------------------------------------------------- dropping and keeping a file

/**
 * The pending commits without their changes to `path` (a conflict resolved as "Keep GitHub's"):
 * the file leaves each commit's files, ops and context; a commit left with nothing is dropped.
 * The message is recomputed from the parts that still touch something.
 */
export function withoutPath(pending, path, device = "") {
  const out = [];
  for (const c of pending) {
    if (!(path in c.files)) {
      out.push(c);
      continue;
    }
    const files = { ...c.files };
    delete files[path];
    if (!Object.values(files).some((f) => f.before !== f.after)) continue;
    const ctx = { ...(c.ctx || {}) };
    delete ctx[path];
    // Each part's ops, in order (part.n of them each), without those on `path`. A part that loses
    // half of a move across files can't be replayed any more: it becomes opaque.
    let k = 0;
    const parts = [];
    const ops = [];
    for (const p of c.parts) {
      const mine = c.ops.slice(k, k + p.n);
      k += p.n;
      const paths = (p.paths || []).filter((x) => x !== path);
      if (!paths.length) continue;
      const left = mine.filter((o) => o.path !== path);
      const split = left.length !== mine.length && mine.some((o) => o.op === "extractSubtree" || o.op === "insertSubtree");
      const keepOps = p.opaque || split ? [] : left;
      ops.push(...keepOps);
      parts.push({ ...p, paths, n: keepOps.length, opaque: p.opaque || split || !keepOps.length });
    }
    if (!parts.length) parts.push({ edit: `${c.id}-rest`, label: "", n: 0, opaque: true, summary: { verb: "Edit", text: "Edit" }, paths: Object.keys(files) });
    out.push({ ...c, files, ctx, ops, parts, message: commitMessage(parts, device), attempt: null });
  }
  return out;
}

// ---------------------------------------------------------------- what the owner reads

function linesOf(text) {
  if (text == null) return { lines: [], nl: true };
  const lines = text.split("\n");
  const nl = lines.at(-1) === "";
  if (nl) lines.pop();
  return { lines, nl };
}

/**
 * The clashes of a conflict, for the screen: [{before, mine, theirs, after}] with `context` lines
 * of agreed text around each. Mine against GitHub's, from the common base.
 */
export function clashes(base, mine, theirs, context = 2) {
  if (theirs == null || mine == null) return [];
  const regions = diff3Merge(mine.split("\n"), (base ?? "").split("\n"), theirs.split("\n"), { excludeFalseConflicts: true });
  const out = [];
  regions.forEach((r, i) => {
    if (!r.conflict) return;
    const prev = regions[i - 1]?.ok || [];
    const next = regions[i + 1]?.ok || [];
    out.push({ before: prev.slice(-context), mine: r.conflict.a, theirs: r.conflict.b, after: next.slice(0, context), line: r.conflict.bIndex + 1 });
  });
  return out;
}

/**
 * A git-style unified diff of one file, with `context` lines around each change. `before` null is a
 * new file, `after` null a deleted one. A change only in the final newline is marked as git marks it.
 */
export function unifiedDiff(path, before, after, context = 3) {
  if (before === after) return "";
  const a = linesOf(before);
  const b = linesOf(after);
  const head = [`diff --git a/${path} b/${path}`];
  if (before == null) head.push("new file mode 100644");
  if (after == null) head.push("deleted file mode 100644");
  head.push(before == null ? "--- /dev/null" : `--- a/${path}`, after == null ? "+++ /dev/null" : `+++ b/${path}`);

  const chunks = diffPatch(a.lines, b.lines);
  // A file whose only change is its final newline: show the last line as changed.
  if (!chunks.length && a.nl !== b.nl && a.lines.length) {
    const n = a.lines.length - 1;
    chunks.push({ buffer1: { offset: n, length: 1, chunk: [a.lines[n]] }, buffer2: { offset: b.lines.length - 1, length: 1, chunk: [b.lines.at(-1)] } });
  }
  const groups = [];
  for (const c of chunks) {
    const g = groups.at(-1);
    if (g && c.buffer1.offset - (g.at(-1).buffer1.offset + g.at(-1).buffer1.length) <= 2 * context) g.push(c);
    else groups.push([c]);
  }
  const body = [];
  const noNl = "\\ No newline at end of file";
  for (const g of groups) {
    const s1 = Math.max(0, g[0].buffer1.offset - context);
    const s2 = s1 + (g[0].buffer2.offset - g[0].buffer1.offset);
    const endC = g.at(-1);
    const e1 = Math.min(a.lines.length, endC.buffer1.offset + endC.buffer1.length + context);
    const out = [];
    let i = s1;
    let n1 = 0;
    let n2 = 0;
    const ctxLine = (k) => {
      out.push(` ${a.lines[k]}`);
      n1++;
      n2++;
      if (k === a.lines.length - 1 && !a.nl) out.push(noNl);
    };
    for (const c of g) {
      for (; i < c.buffer1.offset; i++) ctxLine(i);
      for (let k = 0; k < c.buffer1.length; k++) {
        out.push(`-${a.lines[c.buffer1.offset + k]}`);
        n1++;
        if (c.buffer1.offset + k === a.lines.length - 1 && !a.nl) out.push(noNl);
      }
      for (let k = 0; k < c.buffer2.chunk.length; k++) {
        out.push(`+${c.buffer2.chunk[k]}`);
        n2++;
        if (c.buffer2.offset + k === b.lines.length - 1 && !b.nl) out.push(noNl);
      }
      i = c.buffer1.offset + c.buffer1.length;
    }
    for (; i < e1; i++) ctxLine(i);
    const range = (s, n) => `${n ? s + 1 : s},${n}`;
    body.push(`@@ -${range(s1, n1)} +${range(s2, n2)} @@`, ...out);
  }
  return [...head, ...body].join("\n") + "\n";
}
