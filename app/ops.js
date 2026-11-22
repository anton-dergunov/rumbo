// Edits as data (docs/plans/real-app.md §5): `{path, op, key, args, v}`, run by one entry point for
// an edit and for a replay after a rebase alike, and checked before anything is written. Pure, no
// DOM, tested in tests/ops.test.mjs and tests/edit-properties.test.mjs.
//
//   op    the name of an org-edit.js operation (OPS below)
//   key   headingKey of the heading it is about (null for an insert at the end, removeDone of a file)
//   args  plain JSON; headings in args are keys too
//   v     the format's version
//
// applyOp finds the headings by key, runs the edit, then checks the invariants of §5 against a plan
// made from the op and the old text alone, not from the edit code:
//   1. lines outside the op's own hunks are byte-identical and in order;
//   2. with blank lines removed, the new text is what a content-only model of the op expects;
//   3. no new conflict markers;
//   4. the edited part parses as asked (the heading's fields, the stamps, the notes, the moved block).
// A failure throws OpError and nothing is returned to be written.

import { parseOrg, parseHeadingLine, parsePlanning } from "./org.js";
import * as E from "./org-edit.js";
import { isBlank } from "./spacing.js";

export const OP_VERSION = 1;

export class OpError extends Error {
  /** code: "lost" (a heading isn't found), "invalid" (the op can't run), "invariant" (the result broke a rule). */
  constructor(code, message) {
    super(message);
    this.name = "OpError";
    this.code = code;
  }
}

// ---------------------------------------------------------------- making ops

/** The key of heading `hd` of `doc`; a heading from an older parse is refused. */
export function keyOf(doc, hd) {
  if (!hd) return null;
  if (!doc.headings.includes(hd)) throw new OpError("lost", "that heading is from an older version of the file");
  return E.headingKey(doc, hd);
}

/** An op about heading `hd` (or null) of `doc`. edits.js fills in `path`. */
export function makeOp(doc, op, hd = null, args = {}, path = null) {
  return { path, op, key: keyOf(doc, hd), args, v: OP_VERSION };
}

/** A move or insert target with headings in it, as keys: {before|after: h} | {into: h, at} | {fileEnd, level}. */
export function targetArg(doc, target) {
  for (const how of ["before", "after", "into"]) {
    if (target[how]) return { [how]: keyOf(doc, target[how]), ...(how === "into" ? { at: target.at || "first" } : {}) };
  }
  if (target.fileEnd) return { fileEnd: true, level: target.level || 1 };
  throw new OpError("invalid", "bad target");
}

// ---------------------------------------------------------------- helpers for the plans

const nb = (lines, s, e) => lines.slice(s, e).filter((l) => !isBlank(l));

function contentEnd(lines, s, e) {
  while (e > s && isBlank(lines[e - 1])) e--;
  return e;
}

function runBefore(lines, i) {
  let s = i;
  while (s > 0 && isBlank(lines[s - 1])) s--;
  return [s, i];
}

const isHeadingLine = (l) => l.startsWith("*") && !!parseHeadingLine(l);

function relevelLine(line, delta) {
  if (!delta || !isHeadingLine(line)) return line;
  const m = /^(\*+)/.exec(line);
  return "*".repeat(Math.max(1, m[1].length + delta)) + line.slice(m[1].length);
}

const cleanTags = (tags) => [...new Set(tags.map((t) => String(t).trim()).filter((t) => /^[\w@#%]+$/.test(t)))];
const cleanTitle = (s) => String(s).replace(/[\r\n]+/g, " ").trim();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The old lines a delete may touch: the subtree and the blank runs on both sides of it. */
function deleteHunk(lines, hd) {
  return [runBefore(lines, hd.line)[0], hd.end];
}

/** Where a target puts things in the old lines: {p, run, level}; `run` is the blank run there. */
function targetPlace(lines, doc, target) {
  const n = lines.length;
  if (target.before) {
    const run = runBefore(lines, target.before.line);
    return { p: run[0], run, level: target.before.level };
  }
  if (target.after || (target.into && target.at !== "first")) {
    const t = target.after || target.into;
    const q = contentEnd(lines, t.line, t.end);
    return { p: q, run: [q, t.end], level: t.level + (target.into ? 1 : 0) };
  }
  if (target.into) {
    const t = target.into;
    const q = contentEnd(lines, t.line, t.bodyEnd);
    return { p: q, run: [q, t.bodyEnd], level: t.level + 1 };
  }
  if (target.fileEnd) {
    const q = contentEnd(lines, 0, n);
    return { p: q, run: [q, n], level: target.level || 1 };
  }
  throw new OpError("invalid", "bad target");
}

/** The heading's fields as they should read after a patch. */
function checkHeadingPatch(line, oldHd, patch) {
  const h = isHeadingLine(line) ? parseHeadingLine(line) : null;
  if (!h) return "the edited line is not a heading";
  if (h.level !== ("level" in patch ? Math.max(1, patch.level) : oldHd.level)) return "the heading's level changed";
  if ("state" in patch && h.state !== (patch.state || null)) return "the state is not the one asked for";
  if ("priority" in patch && h.priority !== (patch.priority || null)) return "the priority is not the one asked for";
  if ("title" in patch && h.title !== cleanTitle(patch.title)) return "the title is not the one asked for";
  if ("tags" in patch && !same(h.tags, cleanTags(patch.tags))) return "the tags are not the ones asked for";
  for (const k of ["state", "priority", "title"]) if (!(k in patch) && h[k] !== oldHd[k]) return `the ${k} changed`;
  if (!("tags" in patch) && !same(h.tags, oldHd.tags)) return "the tags changed";
  return null;
}

/** The new lines that took the place of old lines [s, e), found through the line map. */
function image(result, lines, s, e) {
  let a = 0;
  for (let i = s - 1; i >= 0; i--) {
    const m = result.map(i);
    if (m >= 0) {
      a = m + 1;
      break;
    }
  }
  let b = result.lines.length;
  for (let i = e; i < lines.length; i++) {
    const m = result.map(i);
    if (m >= 0) {
      b = m;
      break;
    }
  }
  return result.lines.slice(a, b);
}

// ---------------------------------------------------------------- the ops
//
// Each op: `key` (does it need a heading), `run(c)` the edit, and `plan(c, result)`:
//   hunks     old [start, end) ranges the op may change
//   moved     {start, end, delta}: old lines that must reappear together at result.at, stars shifted
//   expected  the new text's non-blank lines, from the content-only model
//   verify()  a message when the edited part doesn't read as asked, else null

const headingOp = (field) => ({
  key: true,
  run: (c) => E.setHeading(c.lines, c.hd, field ? { [field]: c.args[field] ?? null } : c.args.patch || {}),
  plan: (c, r) => {
    const { lines, hd } = c;
    const patch = field ? { [field]: c.args[field] ?? null } : c.args.patch || {};
    const nl = r.lines[r.map(hd.line)];
    return {
      hunks: [[hd.line, hd.line + 1]],
      expected: [...nb(lines, 0, hd.line), nl, ...nb(lines, hd.line + 1, lines.length)],
      verify: () => (nl == null ? "the heading line is gone" : checkHeadingPatch(nl, hd, patch)),
    };
  },
});

function deletePlan(c, hds) {
  const { lines } = c;
  const hunks = hds.map((hd) => deleteHunk(lines, hd));
  const gone = new Uint8Array(lines.length);
  for (const hd of hds) gone.fill(1, hd.line, hd.end);
  return { hunks, expected: lines.filter((l, i) => !gone[i] && !isBlank(l)) };
}

function insertPlan(c, place, newLines, r) {
  const { lines } = c;
  const before = nb(lines, 0, place.p);
  const after = nb(lines, place.p, lines.length);
  return { hunks: [place.run], expected: [...before, ...newLines.filter((l) => !isBlank(l)), ...after] };
}

/** Find the target's headings in args by key. */
function resolveTarget(c, t) {
  if (!t || typeof t !== "object") throw new OpError("invalid", "bad target");
  for (const how of ["before", "after", "into"]) if (t[how]) return { [how]: c.find(t[how]), ...(how === "into" ? { at: t.at || "first" } : {}) };
  if (t.fileEnd) return { fileEnd: true, level: t.level || 1 };
  throw new OpError("invalid", "bad target");
}

function movePlan(c, hd, target, r) {
  const { lines, doc } = c;
  const place = targetPlace(lines, doc, target);
  const cEnd = contentEnd(lines, hd.line, hd.end);
  const delta = place.level - hd.level;
  const block = nb(lines, hd.line, hd.end).map((l) => relevelLine(l, delta));
  const rest = lines.filter((l, i) => (i < hd.line || i >= hd.end) && !isBlank(l));
  let at = nb(lines, 0, place.p).length;
  if (place.p >= cEnd) at -= block.length;
  return {
    hunks: [runBefore(lines, hd.line), [cEnd, hd.end], place.run],
    moved: { start: hd.line, end: cEnd, delta },
    expected: [...rest.slice(0, at), ...block, ...rest.slice(at)],
  };
}

export const OPS = {
  setState: headingOp("state"),
  setPriority: headingOp("priority"),
  setTitle: headingOp("title"),
  setTags: headingOp("tags"),
  setHeading: headingOp(null),

  setPlanning: {
    key: true,
    run: (c) => E.setPlanning(c.lines, c.hd, c.args.patch || {}),
    plan: (c, r) => {
      const { lines, hd } = c;
      const patch = c.args.patch || {};
      const hunk = hd.planningLine != null ? [hd.planningLine, hd.planningLine + 1] : [hd.line + 1, hd.line + 1];
      const x = image(r, lines, hunk[0], hunk[1]);
      return {
        hunks: [hunk],
        expected: [...nb(lines, 0, hunk[0]), ...x.filter((l) => !isBlank(l)), ...nb(lines, hunk[1], lines.length)],
        verify: () => {
          if (x.length > 1) return "more than one planning line";
          const got = x.length ? parsePlanning(x[0]).planning : {};
          for (const k of ["scheduled", "deadline"]) {
            if (!(k in patch)) continue;
            const want = patch[k];
            if (!want ? got[k] : !got[k] || got[k].date !== want.date || (got[k].time || null) !== (want.time || null)) return `the ${k} date is not the one asked for`;
          }
          return null;
        },
      };
    },
  },

  setBody: {
    key: true,
    run: (c) => E.setBody(c.lines, c.hd, c.args.text ?? ""),
    plan: (c, r) => {
      const { lines, hd } = c;
      const { start, contentEnd: ce } = E.bodySpan(lines, hd);
      const x = image(r, lines, start, ce);
      const want = String(c.args.text ?? "").replace(/\r\n?/g, "\n").split("\n").filter((l) => !isBlank(l));
      return {
        hunks: [[start, ce]],
        expected: [...nb(lines, 0, start), ...want, ...nb(lines, ce, lines.length)],
        verify: () => (same(x.filter((l) => !isBlank(l)), want) ? null : "the notes are not the ones asked for"),
      };
    },
  },

  insertHeading: {
    key: false,
    run: (c) => E.insertHeading(c.lines, c.doc, c.args.ref ? c.find(c.args.ref) : null, c.args.ref ? c.args.where || "after" : "end", c.args.fields || {}, c.ctx),
    plan: (c, r) => {
      const ref = c.args.ref ? c.find(c.args.ref) : null;
      const where = ref ? c.args.where || "after" : "end";
      const fields = c.args.fields || {};
      const target = !ref || where === "end" ? { fileEnd: true, level: fields.level || 1 } : where === "after" ? { after: ref } : { into: ref, at: where === "firstChild" ? "first" : "last" };
      const place = targetPlace(c.lines, c.doc, target);
      const want = E.formatHeadingLine({ ...fields, level: place.level });
      const p = insertPlan(c, place, [want, ...newBodyLines(fields)], r);
      return { ...p, verify: () => (r.lines[r.at] === want ? null : "the new heading is not where it should be") };
    },
  },

  deleteSubtree: {
    key: true,
    run: (c) => E.deleteSubtree(c.lines, c.doc, c.hd, c.ctx),
    plan: (c) => deletePlan(c, [c.hd]),
  },

  removeDone: {
    key: false,
    run: (c) => E.removeDone(c.lines, c.doc, c.args.scope ? c.find(c.args.scope) : null, c.ctx),
    plan: (c) => deletePlan(c, E.doneIn(c.doc, c.args.scope ? c.find(c.args.scope) : null)),
  },

  moveSubtree: {
    key: true,
    run: (c) => E.moveSubtree(c.lines, c.doc, c.hd, resolveTarget(c, c.args.target), c.ctx),
    plan: (c, r) => movePlan(c, c.hd, resolveTarget(c, c.args.target), r),
  },

  moveUp: {
    key: true,
    run: (c) => E.moveUp(c.lines, c.doc, c.hd, c.ctx),
    plan: (c, r) => {
      const sib = E.siblingsOf(c.doc, c.hd);
      const i = sib.indexOf(c.hd);
      return i <= 0 ? { hunks: [], expected: nb(c.lines, 0, c.lines.length) } : movePlan(c, c.hd, { before: sib[i - 1] }, r);
    },
  },

  moveDown: {
    key: true,
    run: (c) => E.moveDown(c.lines, c.doc, c.hd, c.ctx),
    plan: (c, r) => {
      const sib = E.siblingsOf(c.doc, c.hd);
      const i = sib.indexOf(c.hd);
      return i < 0 || i >= sib.length - 1 ? { hunks: [], expected: nb(c.lines, 0, c.lines.length) } : movePlan(c, c.hd, { after: sib[i + 1] }, r);
    },
  },

  promote: { key: true, run: (c) => E.promote(c.lines, c.hd), plan: (c) => shiftPlan(c, -1) },
  demote: { key: true, run: (c) => E.demote(c.lines, c.hd), plan: (c) => shiftPlan(c, +1) },

  extractSubtree: {
    key: true,
    run: (c) => E.extractSubtree(c.lines, c.doc, c.hd, c.ctx),
    plan: (c, r) => {
      const { lines, hd } = c;
      const want = lines.slice(hd.line, contentEnd(lines, hd.line, hd.end));
      return { ...deletePlan(c, [hd]), verify: () => (same(r.chunk, want) && r.level === hd.level ? null : "the taken text is not the subtree") };
    },
  },

  insertSubtree: {
    key: false,
    run: (c) => E.insertSubtree(c.lines, c.doc, chunkOf(c.args), c.args.fromLevel, resolveTarget(c, c.args.target), c.ctx),
    plan: (c, r) => {
      const place = targetPlace(c.lines, c.doc, resolveTarget(c, c.args.target));
      const chunk = chunkOf(c.args).map((l) => relevelLine(l, place.level - c.args.fromLevel));
      const p = insertPlan(c, place, chunk, r);
      return { ...p, verify: () => (same(r.lines.slice(r.at, r.at + chunk.length), chunk) ? null : "the moved text did not arrive whole") };
    },
  },
};

function chunkOf(args) {
  if (!Array.isArray(args.chunk) || !args.chunk.every((l) => typeof l === "string")) throw new OpError("invalid", "the moved text is missing");
  return args.chunk;
}

/** The notes and planning of a new heading, as insertHeading writes them (the content model only needs the non-blank lines). */
function newBodyLines(fields) {
  const out = [];
  const planning = [];
  if (fields.deadline) planning.push(`DEADLINE: ${E.orgStamp(fields.deadline)}`);
  if (fields.scheduled) planning.push(`SCHEDULED: ${E.orgStamp(fields.scheduled)}`);
  if (planning.length) out.push(planning.join(" "));
  if (fields.body) out.push(...String(fields.body).replace(/\r\n?/g, "\n").split("\n"));
  return out;
}

function shiftPlan(c, delta) {
  const { lines, hd } = c;
  const hunks = [];
  for (let i = hd.line; i < hd.end; i++) if (isHeadingLine(lines[i])) hunks.push([i, i + 1]);
  const expected = lines.map((l, i) => (i >= hd.line && i < hd.end ? relevelLine(l, delta) : l)).filter((l) => !isBlank(l));
  return { hunks, expected };
}

// ---------------------------------------------------------------- running and checking

const MARKER_RE = /^(<{7}|={7}|>{7})/;

/** The invariants of §5 for one op's result; returns a message, or null when they all hold. */
export function checkResult(lines, plan, result) {
  const n = lines.length;
  const free = new Uint8Array(n);
  for (const [s, e] of plan.hunks) free.fill(1, Math.max(0, s), Math.min(n, e));
  if (plan.moved) free.fill(1, plan.moved.start, plan.moved.end);
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (free[i]) continue;
    const m = result.map(i);
    if (m < 0 || result.lines[m] !== lines[i]) return `line ${i + 1} changed, outside the edit`;
    if (m <= last) return `line ${i + 1} moved, outside the edit`;
    last = m;
  }
  if (plan.moved) {
    const { start, end, delta } = plan.moved;
    const want = lines.slice(start, end).map((l) => relevelLine(l, delta));
    if (result.at < 0 || !same(result.lines.slice(result.at, result.at + want.length), want)) return "the moved section did not arrive whole";
  }
  if (!same(result.lines.filter((l) => !isBlank(l)), plan.expected)) return "the text changed beyond the edit";
  const markers = (ls) => ls.filter((l) => MARKER_RE.test(l)).length;
  if (markers(result.lines) > markers(lines)) return "the result has conflict markers";
  const headings = parseOrg(result.lines.join("\n")).headings.length;
  if (headings !== plan.expected.filter(isHeadingLine).length) return "the result does not parse to the expected headings";
  return plan.verify ? plan.verify() : null;
}

/**
 * Run one op on a file's lines (with `doc` parsed from them). `ctx`: {rule, memory} for the blank
 * lines at new seams (spacing.js). Returns org-edit's {lines, map, at, ...}, or throws OpError.
 */
export function applyOp(lines, doc, op, ctx = {}) {
  if (!op || typeof op !== "object" || op.v !== OP_VERSION) throw new OpError("invalid", `unknown op format ${op?.v}`);
  const spec = OPS[op.op];
  if (!spec) throw new OpError("invalid", `unknown op ${op.op}`);
  const find = (key) => {
    const h = key ? E.findHeading(doc, key) : null;
    if (!h) throw new OpError("lost", `“${key?.title ?? "?"}” is no longer in the file`);
    return h;
  };
  const c = { lines, doc, args: op.args || {}, find, ctx, hd: spec.key ? find(op.key) : null };
  let result, plan;
  try {
    result = spec.run(c);
    plan = spec.plan(c, result);
  } catch (err) {
    if (err instanceof OpError) throw err;
    throw new OpError("invalid", err.message);
  }
  const why = checkResult(lines, plan, result);
  if (why) throw new OpError("invariant", `${op.op}: ${why}`);
  return result;
}

/**
 * Several ops on one file as one edit (the task dialog's planning, notes and heading). Each op finds
 * its headings again in the text the one before it left. Returns {lines, map, at, results}.
 */
export function applyOps(lines, doc, ops, ctx = {}) {
  const oldLength = lines.length;
  let index = Array.from({ length: oldLength }, (_, i) => i);
  let cur = lines;
  let curDoc = doc;
  let at = -1;
  const results = [];
  for (const op of ops) {
    const r = applyOp(cur, curDoc, op, ctx);
    results.push(r);
    index = index.map((x) => (x >= 0 ? r.map(x) : -1));
    at = r.at;
    if (r.lines !== cur) {
      cur = r.lines;
      curDoc = parseOrg(E.joinLines(cur, doc.finalNewline));
    }
  }
  const map = (old) => (old >= 0 && old < oldLength ? index[old] : -1);
  return { lines: cur, map, at, results };
}
