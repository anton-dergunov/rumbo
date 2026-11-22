// Edits on the raw lines of an Org file. Pure functions, no DOM, tested in tests/org-edit.test.mjs.
//
// Every edit is a span edit: it replaces exactly the lines it owns (a heading line, a planning line,
// a body, a subtree) and leaves every other line byte for byte as it was. The parsed tree is only
// used to find spans; it is never written back as text.
//
// Each function takes the file's `lines` (from parseOrg) and headings parsed from those same lines,
// and returns {lines, map, at}:
//   lines  the new lines
//   map    old line index -> new line index, or -1 for a removed line. The UI uses it to carry fold
//          state, focus and open rows over to the re-parsed headings.
//   at     the new line index of the heading the edit was about (for a new heading, where it landed)
//
// Headings are written the way Emacs writes them in this vault: `** TODO [#A] Title :a:b:`, the
// tags one space after the title with no column alignment (org-auto-align-tags nil), the planning
// line directly under the heading, and no CLOSED line (org-log-done nil).
//
// Edits inside an entry (its heading line, planning line or notes) never touch a blank line around
// it. Insert, delete and move resolve only the seams they create, with the Emacs blank-line model
// (see "subtrees and seams" below). They take the parsed doc and a `ctx` of {rule, memory}
// (spacing.js). ops.js runs all of them from serialisable ops and checks the result.

import { ALL_STATES, parseHeadingLine, parseOrg } from "./org.js";
import { partition, nodeIdentity, identity, cellOf, predict, ambiguous, recall, START } from "./spacing.js";

const HEAD_RE = /^(\*+)([ \t]+)(.*)$/;
const TAGS_RE = /([ \t]+)(:(?:[\w@#%]+:)+)([ \t]*)$/;
const PRIO_RE = /^\[#([A-Z0-9])\]([ \t]*)/;
const STAMP_KEY_RE = /(SCHEDULED|DEADLINE|CLOSED):[ \t]*[<[][^>\]]*[>\]]/g;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const isBlank = (line) => !/\S/.test(line);
export const joinLines = (lines, finalNewline = true) => lines.join("\n") + (finalNewline && lines.length ? "\n" : "");

// ---------------------------------------------------------------- the line builder

/**
 * Lines tagged with where they came from, so a chain of splices still knows each line's old index.
 * Inserted lines carry src = -1.
 */
function tagged(lines) {
  return lines.map((t, i) => ({ t, src: i }));
}

function finish(tlines, oldLength, at = -1) {
  const index = new Int32Array(oldLength).fill(-1);
  tlines.forEach((x, n) => {
    if (x.src >= 0) index[x.src] = n;
  });
  const map = (old) => (old >= 0 && old < oldLength ? index[old] : -1);
  return { lines: tlines.map((x) => x.t), map, at };
}

const fresh = (texts) => texts.map((t) => ({ t, src: -1 }));

/** Replace one line's text, keeping its identity (it maps to its own new position). */
function replaceLine(lines, n, text) {
  const t = tagged(lines);
  t[n] = { t: text, src: n };
  return finish(t, lines.length, n);
}

const unchanged = (lines, at = -1) => finish(tagged(lines), lines.length, at);

// ---------------------------------------------------------------- heading lines

/** Split a heading line into its parts, keeping the original separators so untouched parts survive. */
export function splitHeading(line, states = ALL_STATES) {
  const m = HEAD_RE.exec(line);
  if (!m) return null;
  const parts = { stars: m[1], sp: m[2], state: "", stateSp: "", prio: "", prioSp: "", title: m[3], tagSp: "", tags: "", tail: "" };
  let rest = m[3];
  const word = /^(\S+)([ \t]+|$)/.exec(rest);
  if (word && states.has(word[1])) {
    parts.state = word[1];
    parts.stateSp = word[2];
    rest = rest.slice(word[0].length);
  }
  const p = PRIO_RE.exec(rest);
  if (p) {
    parts.prio = p[1];
    parts.prioSp = p[2];
    rest = rest.slice(p[0].length);
  }
  const t = TAGS_RE.exec(rest);
  if (t) {
    parts.tagSp = t[1];
    parts.tags = t[2];
    parts.tail = t[3];
    rest = rest.slice(0, t.index);
  }
  parts.title = rest;
  return parts;
}

function joinHeading(p) {
  return p.stars + p.sp + (p.state ? p.state + p.stateSp : "") + (p.prio ? `[#${p.prio}]` + p.prioSp : "") + p.title + (p.tags ? p.tagSp + p.tags + p.tail : "");
}

const cleanTitle = (s) => String(s).replace(/[\r\n]+/g, " ").trim();
const cleanTags = (tags) => [...new Set(tags.map((t) => String(t).trim()).filter((t) => /^[\w@#%]+$/.test(t)))];

/**
 * Change parts of one heading line. `patch` may hold `state` (a keyword or null), `priority`
 * ("A" or null), `title`, `tags` (an array) and `level`. Parts not in the patch keep their exact text,
 * including old column-aligned tags.
 */
export function editHeadingLine(line, patch) {
  const p = splitHeading(line);
  if (!p) throw new Error("not a heading line");
  const before = joinHeading(p);
  if ("level" in patch) p.stars = "*".repeat(Math.max(1, patch.level));
  if ("state" in patch && (patch.state || "") !== p.state) {
    if (patch.state && !ALL_STATES.has(patch.state)) throw new Error(`unknown state ${patch.state}`);
    if (!patch.state) p.stateSp = "";
    else if (!p.state) p.stateSp = " ";
    p.state = patch.state || "";
  }
  if ("priority" in patch && (patch.priority || "") !== p.prio) {
    if (!patch.priority) p.prioSp = "";
    else if (!p.prio) p.prioSp = " ";
    p.prio = patch.priority || "";
  }
  if ("title" in patch && cleanTitle(patch.title) !== p.title.trim()) {
    p.title = cleanTitle(patch.title);
  }
  if ("tags" in patch) {
    const next = cleanTags(patch.tags);
    const old = p.tags ? p.tags.split(":").filter(Boolean) : [];
    if (next.join(":") !== old.join(":")) {
      // Emacs with org-auto-align-tags nil: one space, no alignment, nothing after.
      p.title = p.title.replace(/[ \t]+$/, "");
      p.tags = next.length ? `:${next.join(":")}:` : "";
      p.tagSp = next.length ? " " : "";
      p.tail = "";
    }
  }
  let out = joinHeading(p);
  if (out !== before && !p.title && !p.tags) out = out.replace(/[ \t]+$/, "");
  return out === before ? line : out;
}

/** A new heading line, written as Emacs writes it in this vault. */
export function formatHeadingLine({ level = 1, state = null, priority = null, title = "", tags = [] }) {
  const words = [state, priority ? `[#${priority}]` : null, cleanTitle(title)].filter(Boolean);
  const t = cleanTags(tags);
  return `${"*".repeat(Math.max(1, level))} ${words.join(" ")}${t.length ? ` :${t.join(":")}:` : ""}`.replace(/[ \t]+$/, "");
}

const headingEdit = (lines, hd, patch) => {
  const text = editHeadingLine(lines[hd.line], patch);
  return text === lines[hd.line] ? unchanged(lines, hd.line) : replaceLine(lines, hd.line, text);
};

export const setState = (lines, hd, state) => headingEdit(lines, hd, { state });
export const setPriority = (lines, hd, priority) => headingEdit(lines, hd, { priority });
export const setTitle = (lines, hd, title) => headingEdit(lines, hd, { title });
export const setTags = (lines, hd, tags) => headingEdit(lines, hd, { tags });
export const setHeading = (lines, hd, patch) => headingEdit(lines, hd, patch);

// ---------------------------------------------------------------- planning

/** `<2027-01-10 Sun>`, `<2027-01-10 Sun 09:30-10:00 +1w>`. The weekday is always English, as Emacs writes it here. */
export function orgStamp({ date, time = null, end = null, repeat = null, active = true }) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "");
  if (!m) throw new Error(`bad date ${date}`);
  const day = WEEKDAYS[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
  const parts = [date, day];
  if (time) parts.push(end ? `${time}-${end}` : time);
  if (repeat) parts.push(repeat);
  return active ? `<${parts.join(" ")}>` : `[${parts.join(" ")}]`;
}

const KEY_ORDER = ["DEADLINE", "SCHEDULED"];

/**
 * Set or clear SCHEDULED and DEADLINE. `patch` = {scheduled?, deadline?}, each a stamp object for
 * orgStamp, or null to clear. Keys not in the patch are left alone, as is CLOSED and any text after
 * the stamps. The planning line is inserted directly under the heading when missing and removed when
 * nothing is left on it.
 */
export function setPlanning(lines, hd, patch) {
  const has = hd.planningLine != null;
  let line = has ? lines[hd.planningLine] : "";
  for (const key of KEY_ORDER) {
    const k = key.toLowerCase();
    if (!(k in patch)) continue;
    const stamp = patch[k] ? `${key}: ${orgStamp(patch[k])}` : "";
    const re = new RegExp(`${key}:[ \\t]*[<[][^>\\]]*[>\\]]`);
    const found = re.exec(line);
    if (found) {
      if (stamp === found[0]) continue;
      if (stamp) line = line.slice(0, found.index) + stamp + line.slice(found.index + found[0].length);
      else {
        // Remove the stamp and one space beside it.
        let a = found.index;
        let b = found.index + found[0].length;
        if (line[b] === " ") b++;
        else if (a > 0 && line[a - 1] === " ") a--;
        line = line.slice(0, a) + line.slice(b);
      }
    } else if (stamp) {
      // After the last stamp, so text after the stamps stays at the end. DEADLINE goes before SCHEDULED.
      const stamps = [...line.matchAll(STAMP_KEY_RE)];
      if (key === "DEADLINE" && stamps.length && stamps[0][1] === "SCHEDULED") {
        const at = stamps[0].index;
        line = line.slice(0, at) + stamp + " " + line.slice(at);
      } else if (stamps.length) {
        const last = stamps[stamps.length - 1];
        const at = last.index + last[0].length;
        line = line.slice(0, at) + " " + stamp + line.slice(at);
      } else {
        const lead = /^[ \t]*/.exec(line)[0];
        const restText = line.slice(lead.length);
        line = lead + stamp + (restText ? " " + restText : "");
      }
    }
  }
  if (has && line === lines[hd.planningLine]) return unchanged(lines, hd.line);
  const t = tagged(lines);
  const stillPlanning = /(SCHEDULED|DEADLINE|CLOSED):/.test(line);
  if (has) {
    if (stillPlanning) t[hd.planningLine] = { t: line, src: hd.planningLine };
    else if (line.trim()) t[hd.planningLine] = { t: line.trim(), src: hd.planningLine }; // leftover text becomes body
    else t.splice(hd.planningLine, 1);
  } else {
    if (!line.trim()) return unchanged(lines, hd.line);
    t.splice(hd.line + 1, 0, ...fresh([line]));
  }
  return finish(t, lines.length, hd.line);
}

// ---------------------------------------------------------------- body

/**
 * The heading's own notes: from after the heading (and planning) line up to its first child or the
 * next heading. The run of blank lines at the end separates it from what follows; it is kept as it
 * is and not shown for editing.
 */
export function bodySpan(lines, hd) {
  const start = (hd.planningLine ?? hd.line) + 1;
  let contentEnd = hd.bodyEnd;
  while (contentEnd > start && isBlank(lines[contentEnd - 1])) contentEnd--;
  return { start, contentEnd, end: hd.bodyEnd };
}

export function bodyText(lines, hd) {
  const { start, contentEnd } = bodySpan(lines, hd);
  return lines.slice(start, contentEnd).join("\n");
}

/** Lines of `text` that Org would read as headings, which notes must not contain. */
export function bodyProblems(text) {
  return String(text)
    .split("\n")
    .map((l, i) => (/^\*+[ \t]/.test(l) ? i : -1))
    .filter((i) => i >= 0);
}

/** Replace the notes with `text`. Trailing blank lines in `text` are dropped; the separator after the notes stays. */
export function setBody(lines, hd, text) {
  const { start, contentEnd } = bodySpan(lines, hd);
  const next = String(text).replace(/\r\n?/g, "\n").split("\n");
  while (next.length && isBlank(next[next.length - 1])) next.pop();
  if (bodyProblems(next.join("\n")).length) throw new Error("A line in the notes starts with '* ', which Org reads as a new heading.");
  const old = lines.slice(start, contentEnd);
  if (old.length === next.length && old.every((l, i) => l === next[i])) return unchanged(lines, hd.line);
  const t = tagged(lines);
  t.splice(start, contentEnd - start, ...fresh(next));
  return finish(t, lines.length, hd.line);
}

// ---------------------------------------------------------------- subtrees and seams
//
// Insert, delete and move follow the Emacs ownership model (spacing.js, real-app.md §5). The file is
// read as a sequence of headings, each a block (its heading line, its lead and its body, all kept as
// they are), with a blank run between neighbours. An edit cuts blocks out and puts blocks in; a run
// between two headings that were neighbours before stays exactly as it was. Only the seams the edit
// creates are resolved, first rule that applies:
//   - the same two headings were neighbours before: their old run;
//   - the next heading is deeper than a heading with no body: that heading's own lead;
//   - the edge memory (`ctx.memory`, from earlier versions) knows the two neighbours: that run;
//   - the rule cell (`ctx.rule`, counted from the vault; null means the built-in default): its count;
//   - keep the run that was at that spot.
// The blank lines at the start and the end of the file never move.

const blankLine = () => ({ t: "", src: -1 });
const runLines = (r) => (r.fixed ? r.lines : r.keep);
const longer = (a, b) => (b.length > a.length ? b : a);

/** The file as a sequence of blocks and runs. `freshLines`: the lines come from elsewhere (a chunk from another file). */
function sequence(lines, doc, { freshLines = false } = {}) {
  const part = partition(doc, lines);
  const t = freshLines ? fresh(lines) : tagged(lines);
  const sl = (r) => t.slice(r[0], r[1]);
  const start = { start: true };
  const nodes = part.nodes.map((nd, k) => ({
    h: nd.h,
    level: nd.level,
    hasBody: nd.hasBody,
    id: nodeIdentity(nd, lines),
    block: [t[nd.head], ...sl(nd.lead), ...sl(nd.body)],
    // With no body, the run after the heading is its lead when the next heading is deeper.
    hadLead: part.kinds[k + 1] === "lead",
    leadRun: part.kinds[k + 1] === "lead" ? sl(part.runs[k + 1]) : [],
    origRun: sl(part.runs[k]),
    origPrev: null,
  }));
  nodes.forEach((nd, k) => (nd.origPrev = k ? nodes[k - 1] : start));
  return {
    start,
    head: [...sl(part.bof), ...sl(part.pre)],
    hasPre: part.pre[1] > part.pre[0],
    nodes,
    runs: part.runs.map((r) => ({ fixed: true, lines: sl(r) })),
  };
}

function indexOf(S, hd) {
  const k = S.nodes.findIndex((n) => n.h === hd);
  if (k < 0) throw new Error("that heading is not in this file");
  return k;
}

/** The index of the last heading in node k's subtree. */
function subtreeLast(S, k) {
  let j = k;
  while (j + 1 < S.nodes.length && S.nodes[j + 1].level > S.nodes[k].level) j++;
  return j;
}

/** Take nodes i..j out. The two runs around them become one seam, or eof stays when they were last. */
function cut(S, i, j) {
  const N = S.nodes.length;
  const taken = { nodes: S.nodes.slice(i, j + 1), inner: S.runs.slice(i + 1, j + 1) };
  const merged = j + 1 === N ? S.runs[N] : { fixed: false, keep: longer(runLines(S.runs[i]), runLines(S.runs[j + 1])) };
  S.nodes.splice(i, j - i + 1);
  S.runs.splice(i, j - i + 2, merged);
  return taken;
}

/** Put nodes in at index k. Both new seams may keep the run that was there; eof stays. */
function insertAt(S, k, taken) {
  const N = S.nodes.length;
  const r = S.runs[k];
  const keep = runLines(r);
  const seam = () => ({ fixed: false, keep });
  // With no headings yet, the preamble's trailing blank lines become the seam before the new one.
  const tail = N === 0 ? { fixed: true, lines: [] } : k === N ? r : seam();
  S.nodes.splice(k, 0, ...taken.nodes);
  S.runs.splice(k, 1, seam(), ...taken.inner, tail);
}

function relevelNodes(nodes, delta) {
  if (!delta) return;
  for (const n of nodes) {
    n.level = Math.max(1, n.level + delta);
    const head = n.block[0];
    n.block[0] = { t: head.t.replace(/^\*+/, "*".repeat(n.level)), src: head.src };
  }
}

function resolveSeam(S, p, s, r, ctx, twice) {
  if (s.origPrev === p) return s.origRun;
  const first = p === S.start;
  const remembered = () => {
    const pid = first ? START : p.id;
    const m = twice.has(s.id) || twice.has(pid) ? null : recall(ctx.memory, pid, s.id);
    return m ? fresh(m) : null;
  };
  if (first) {
    if (!S.hasPre) return [];
  } else if (!p.hasBody && s.level > p.level) {
    // The heading's own lead. One that lost it (its only child went) gets it back from the memory.
    return p.hadLead ? p.leadRun : remembered() || [];
  }
  const m = remembered();
  if (m) return m;
  const v = predict(ctx.rule ?? null, cellOf(s.level, first ? null : p));
  if (v != null) return Array.from({ length: v }, blankLine);
  return r.keep;
}

/** The sequence back into lines. `focus` is a node whose heading line index becomes `at`. */
function assemble(S, ctx, oldLength, focus = null) {
  const out = [];
  const used = new Set();
  const push = (x) => {
    if (x.src >= 0) {
      if (used.has(x.src)) x = { t: x.t, src: -1 };
      else used.add(x.src);
    }
    out.push(x);
  };
  const twice = ambiguous(S.nodes.map((n) => n.id));
  S.head.forEach(push);
  let at = -1;
  S.nodes.forEach((s, k) => {
    const r = S.runs[k];
    const p = k ? S.nodes[k - 1] : S.start;
    (r.fixed ? r.lines : resolveSeam(S, p, s, r, ctx, twice)).forEach(push);
    if (s === focus) at = out.length;
    s.block.forEach(push);
  });
  runLines(S.runs[S.nodes.length]).forEach(push);
  return finish(out, oldLength, at);
}

const within = (hd, other) => other.line >= hd.line && other.line < hd.end;

/** Where a target puts things in S: {k, level}. */
function targetIndex(S, target) {
  if (target.before) {
    const k = indexOf(S, target.before);
    return { k, level: S.nodes[k].level };
  }
  if (target.after) {
    const k = indexOf(S, target.after);
    return { k: subtreeLast(S, k) + 1, level: S.nodes[k].level };
  }
  if (target.into) {
    const k = indexOf(S, target.into);
    return { k: target.at === "first" ? k + 1 : subtreeLast(S, k) + 1, level: S.nodes[k].level + 1 };
  }
  if (target.fileEnd) return { k: S.nodes.length, level: target.level || 1 };
  if (target.fileStart) return { k: 0, level: target.level || 1 };
  throw new Error("bad target");
}

const targetHeading = (target) => target.before || target.after || target.into || null;

/** A new heading's lines: the heading, the planning line, the notes. */
function newHeadingLines(fields, level) {
  const out = [formatHeadingLine({ ...fields, level })];
  const planning = [];
  if (fields.deadline) planning.push(`DEADLINE: ${orgStamp(fields.deadline)}`);
  if (fields.scheduled) planning.push(`SCHEDULED: ${orgStamp(fields.scheduled)}`);
  if (planning.length) out.push(planning.join(" "));
  if (fields.body) {
    const body = String(fields.body).replace(/\r\n?/g, "\n").split("\n");
    while (body.length && isBlank(body[body.length - 1])) body.pop();
    while (body.length && isBlank(body[0])) body.shift();
    if (bodyProblems(body.join("\n")).length) throw new Error("A line in the notes starts with '* ', which Org reads as a new heading.");
    out.push(...body);
  }
  return out;
}

/**
 * Insert a new heading. `where`: "after" (a sibling after ref's subtree), "firstChild", "lastChild",
 * or "end" (end of the file, at fields.level). `fields`: {level?, state, priority, title, tags,
 * scheduled, deadline, body}.
 */
export function insertHeading(lines, doc, ref, where, fields, ctx = {}) {
  const S = sequence(lines, doc);
  const target = !ref || where === "end" ? { fileEnd: true, level: fields.level || 1 } : where === "after" ? { after: ref } : { into: ref, at: where === "firstChild" ? "first" : "last" };
  const { k, level } = targetIndex(S, target);
  const out = newHeadingLines(fields, level);
  const node = { h: null, level, hasBody: out.length > 1, id: identity(cleanTitle(fields.title || ""), out.slice(1)), block: fresh(out), hadLead: false, leadRun: [], origRun: [], origPrev: null };
  insertAt(S, k, { nodes: [node], inner: [] });
  return assemble(S, ctx, lines.length, node);
}

/** Remove a heading and everything under it. */
export function deleteSubtree(lines, doc, hd, ctx = {}) {
  const S = sequence(lines, doc);
  const k = indexOf(S, hd);
  cut(S, k, subtreeLast(S, k));
  return assemble(S, ctx, lines.length);
}

/** The outermost DONE headings in `scope` (a heading, or null for the whole file). */
export function doneIn(doc, scope = null) {
  const pool = scope ? doc.headings.filter((x) => within(scope, x) && x !== scope) : doc.headings;
  return pool.filter((x) => x.state === "DONE" && !x.path.some((a) => a.state === "DONE" && pool.includes(a)));
}

/** Remove every DONE task in `scope` (a heading, or null for the whole file) in one edit. */
export function removeDone(lines, doc, scope = null, ctx = {}) {
  const outer = doneIn(doc, scope);
  const S = sequence(lines, doc);
  for (const hd of [...outer].sort((a, b) => b.line - a.line)) {
    const k = indexOf(S, hd);
    cut(S, k, subtreeLast(S, k));
  }
  const focus = scope ? S.nodes.find((n) => n.h === scope) : null;
  return { ...assemble(S, ctx, lines.length, focus), removed: outer.length };
}

/**
 * Move a subtree inside its file. target: {before: heading} | {after: heading} |
 * {into: section, at: "first" | "last"} | {fileEnd: true, level}. The moved headings change only their
 * stars; their text, their leads and the runs inside them stay as they were.
 */
export function moveSubtree(lines, doc, hd, target, ctx = {}) {
  const th = targetHeading(target);
  if (th && within(hd, th)) throw new Error("cannot move a section into itself");
  const S = sequence(lines, doc);
  const k = indexOf(S, hd);
  const taken = cut(S, k, subtreeLast(S, k));
  const { k: to, level } = targetIndex(S, target);
  relevelNodes(taken.nodes, level - hd.level);
  insertAt(S, to, taken);
  return assemble(S, ctx, lines.length, taken.nodes[0]);
}

/** Change the level of a subtree in place, as org-promote-subtree and org-demote-subtree do. Its neighbours stay, so every run does too. */
export function shiftLevel(lines, hd, delta) {
  if (hd.level + delta < 1) throw new Error("already at the top level");
  const t = tagged(lines);
  for (let i = hd.line; i < hd.end; i++) {
    const m = /^(\*+)([ \t].*)?$/.exec(t[i].t);
    if (m && parseHeadingLine(t[i].t)) t[i] = { t: "*".repeat(Math.max(1, m[1].length + delta)) + (m[2] || ""), src: i };
  }
  return finish(t, lines.length, hd.line);
}
export const promote = (lines, hd) => shiftLevel(lines, hd, -1);
export const demote = (lines, hd) => shiftLevel(lines, hd, +1);

export const siblingsOf = (doc, hd) => (hd.parent ? hd.parent.children : doc.children);

export function moveUp(lines, doc, hd, ctx = {}) {
  const sib = siblingsOf(doc, hd);
  const i = sib.indexOf(hd);
  if (i <= 0) return unchanged(lines, hd.line);
  return moveSubtree(lines, doc, hd, { before: sib[i - 1] }, ctx);
}

export function moveDown(lines, doc, hd, ctx = {}) {
  const sib = siblingsOf(doc, hd);
  const i = sib.indexOf(hd);
  if (i < 0 || i >= sib.length - 1) return unchanged(lines, hd.line);
  return moveSubtree(lines, doc, hd, { after: sib[i + 1] }, ctx);
}

/** Take a subtree out of a file, for a move to another file: {lines, map, chunk, level}. */
export function extractSubtree(lines, doc, hd, ctx = {}) {
  const S = sequence(lines, doc);
  const k = indexOf(S, hd);
  const taken = cut(S, k, subtreeLast(S, k));
  const chunk = [];
  taken.nodes.forEach((n, i) => {
    if (i) chunk.push(...taken.inner[i - 1].lines.map((x) => x.t));
    chunk.push(...n.block.map((x) => x.t));
  });
  return { ...assemble(S, ctx, lines.length), chunk, level: hd.level };
}

/** Put a subtree taken from another file (`chunk`, its lines, at `fromLevel`) at `target` in this one. */
export function insertSubtree(lines, doc, chunk, fromLevel, target, ctx = {}) {
  const cdoc = parseOrg(chunk.join("\n"));
  if (!cdoc.headings.length || cdoc.headings[0].line !== 0 || cdoc.headings[0].level !== fromLevel) throw new Error("the moved text does not start with its heading");
  const C = sequence(chunk, cdoc, { freshLines: true });
  const taken = { nodes: C.nodes, inner: C.runs.slice(1, C.nodes.length) };
  for (const n of taken.nodes) n.origPrev = null;
  const S = sequence(lines, doc);
  const { k, level } = targetIndex(S, target);
  relevelNodes(taken.nodes, level - fromLevel);
  insertAt(S, k, taken);
  return assemble(S, ctx, lines.length, taken.nodes[0]);
}

// ---------------------------------------------------------------- finding a heading again

/**
 * A key that finds a heading again after the file changed underneath: its ancestors' titles, its
 * own title, and which of the headings with that same path it was.
 */
export function headingKey(doc, hd) {
  const path = hd.path.map((a) => a.title);
  const same = doc.headings.filter((x) => x.title === hd.title && x.path.map((a) => a.title).join("\u0000") === path.join("\u0000"));
  return { path, title: hd.title, nth: same.indexOf(hd), count: same.length };
}

/** The heading `key` names in `doc`, or null when it is gone or no longer unambiguous. */
export function findHeading(doc, key) {
  if (!key) return null;
  const same = doc.headings.filter((x) => x.title === key.title && x.path.map((a) => a.title).join("\u0000") === key.path.join("\u0000"));
  if (same.length === key.count) return same[key.nth] || null;
  return same.length === 1 ? same[0] : null;
}
