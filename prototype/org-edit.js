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

import { ALL_STATES, parseHeadingLine, parseOrg } from "./org.js";

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

// ---------------------------------------------------------------- subtrees

/** The subtree's own lines, without the blank run at its end when that run is the separator before what follows. */
function subtreeContentEnd(lines, hd) {
  let e = hd.end;
  while (e > hd.line + 1 && isBlank(lines[e - 1])) e--;
  return e;
}

/**
 * The span to remove when a subtree goes away. An entry owns the blank lines after it, so normally
 * the whole subtree goes, those blank lines included. Two cases keep the spacing of what remains:
 * - the line before it is not blank: its trailing blank run is then the only separator between the
 *   entry before and whatever follows, so it stays;
 * - it is the last thing in the file with no blank lines after it: the blank run before it would be
 *   left dangling at the end of the file, so that goes with it.
 */
function removalSpan(lines, hd) {
  const prevBlank = hd.line > 0 && isBlank(lines[hd.line - 1]);
  const cEnd = subtreeContentEnd(lines, hd);
  if (!prevBlank && hd.line > 0) return { start: hd.line, end: cEnd };
  if (prevBlank && hd.end === lines.length && cEnd === hd.end) {
    let s = hd.line;
    while (s > 0 && isBlank(lines[s - 1])) s--;
    return { start: s, end: hd.end };
  }
  return { start: hd.line, end: hd.end };
}

/** Does the heading at `level` just before p sit after a blank line? Then entries here are spaced out. */
function spacedBefore(t, p, level) {
  for (let i = p - 1; i >= 0; i--) {
    const hd = /^(\*+)[ \t]/.exec(t[i].t);
    if (!hd || !parseHeadingLine(t[i].t)) continue;
    if (hd[1].length < level) return false;
    if (hd[1].length === level) return i > 0 && isBlank(t[i - 1].t);
  }
  return false;
}

/**
 * Insert `chunk` (an entry at `level`) at p in tagged lines, copying the spacing there. A blank line
 * before p means entries end with one, so the new entry gets one too, unless it is last in the file.
 * Directly after a sibling that is itself spaced out, the blank goes before the new entry instead.
 */
function insertChunk(t, p, chunk, level) {
  let add = chunk;
  if (p > 0 && isBlank(t[p - 1].t)) {
    if (p < t.length) add = [...chunk, { t: "", src: -1 }];
  } else if (p > 0 && spacedBefore(t, p, level)) {
    add = [{ t: "", src: -1 }, ...chunk];
    t.splice(p, 0, ...add);
    return p + 1;
  }
  t.splice(p, 0, ...add);
  return p;
}

function relevel(chunkLines, delta) {
  if (!delta) return chunkLines;
  return chunkLines.map((x) => {
    const m = /^(\*+)([ \t].*)?$/.exec(x.t);
    if (!m || !parseHeadingLine(x.t)) return x;
    return { t: "*".repeat(Math.max(1, m[1].length + delta)) + (m[2] || ""), src: x.src };
  });
}

const within = (hd, other) => other.line >= hd.line && other.line < hd.end;

/** Where a target puts things: {p, level} in the original line numbers. */
function targetPoint(lines, target) {
  if (target.before) return { p: target.before.line, level: target.before.level };
  if (target.after) return { p: target.after.end, level: target.after.level };
  if (target.into) {
    const s = target.into;
    return target.at === "first" ? { p: s.bodyEnd, level: s.level + 1 } : { p: s.end, level: s.level + 1 };
  }
  if (target.fileEnd) return { p: lines.length, level: target.level || 1 };
  if (target.fileStart) return { p: target.firstLine ?? 0, level: target.level || 1 };
  throw new Error("bad target");
}

const targetHeading = (target) => target.before || target.after || target.into || null;

/**
 * Insert a new heading. `where`: "after" (a sibling after ref's subtree), "firstChild", "lastChild",
 * or "end" (end of the file, at fields.level). `fields`: {level?, state, priority, title, tags,
 * scheduled, deadline, body}.
 */
export function insertHeading(lines, ref, where, fields) {
  const target = where === "after" ? { after: ref } : where === "firstChild" ? { into: ref, at: "first" } : where === "lastChild" ? { into: ref, at: "last" } : { fileEnd: true, level: fields.level || 1 };
  const { p, level } = targetPoint(lines, target);
  const out = [formatHeadingLine({ ...fields, level })];
  const planning = [];
  if (fields.deadline) planning.push(`DEADLINE: ${orgStamp(fields.deadline)}`);
  if (fields.scheduled) planning.push(`SCHEDULED: ${orgStamp(fields.scheduled)}`);
  if (planning.length) out.push(planning.join(" "));
  if (fields.body) {
    const body = String(fields.body).replace(/\r\n?/g, "\n").split("\n");
    while (body.length && isBlank(body[body.length - 1])) body.pop();
    if (bodyProblems(body.join("\n")).length) throw new Error("A line in the notes starts with '* ', which Org reads as a new heading.");
    out.push(...body);
  }
  const t = tagged(lines);
  const at = insertChunk(t, p, fresh(out), level);
  return finish(t, lines.length, at);
}

/** Remove a heading and everything under it. */
export function deleteSubtree(lines, hd) {
  const { start, end } = removalSpan(lines, hd);
  const t = tagged(lines);
  t.splice(start, end - start);
  return finish(t, lines.length, -1);
}

/** Remove every DONE task in `scope` (a heading, or null for the whole file) in one edit. */
export function removeDone(lines, doc, scope = null) {
  const pool = scope ? doc.headings.filter((x) => within(scope, x) && x !== scope) : doc.headings;
  const outer = pool.filter((x) => x.state === "DONE" && !x.path.some((a) => a.state === "DONE" && pool.includes(a)));
  const t = tagged(lines);
  for (const hd of [...outer].sort((a, b) => b.line - a.line)) {
    const { start, end } = removalSpan(lines, hd);
    t.splice(start, end - start);
  }
  return { ...finish(t, lines.length, scope ? scope.line : -1), removed: outer.length };
}

/**
 * Move a subtree inside its file. target: {before: heading} | {after: heading} |
 * {into: section, at: "first" | "last"} | {fileEnd: true, level}. The moved headings change only their
 * stars; their text and the text around both places stays as it was.
 */
export function moveSubtree(lines, hd, target) {
  const th = targetHeading(target);
  if (th && within(hd, th)) throw new Error("cannot move a section into itself");
  const { p: p0, level } = targetPoint(lines, target);
  const { start, end } = removalSpan(lines, hd);
  const cEnd = subtreeContentEnd(lines, hd);
  const t = tagged(lines);
  const chunk = relevel(t.slice(hd.line, cEnd), level - hd.level);
  t.splice(start, end - start);
  let p = p0;
  if (p0 >= end) p -= end - start;
  else if (p0 > start) p = start;
  const at = insertChunk(t, p, chunk, level);
  return finish(t, lines.length, at);
}

/** Change the level of a subtree in place, as org-promote-subtree and org-demote-subtree do. */
export function shiftLevel(lines, hd, delta) {
  if (hd.level + delta < 1) throw new Error("already at the top level");
  const t = tagged(lines);
  const moved = relevel(t.slice(hd.line, hd.end), delta);
  t.splice(hd.line, moved.length, ...moved);
  return finish(t, lines.length, hd.line);
}
export const promote = (lines, hd) => shiftLevel(lines, hd, -1);
export const demote = (lines, hd) => shiftLevel(lines, hd, +1);

export const siblingsOf = (doc, hd) => (hd.parent ? hd.parent.children : doc.children);

export function moveUp(lines, doc, hd) {
  const sib = siblingsOf(doc, hd);
  const i = sib.indexOf(hd);
  if (i <= 0) return unchanged(lines, hd.line);
  return moveSubtree(lines, hd, { before: sib[i - 1] });
}

export function moveDown(lines, doc, hd) {
  const sib = siblingsOf(doc, hd);
  const i = sib.indexOf(hd);
  if (i < 0 || i >= sib.length - 1) return unchanged(lines, hd.line);
  return moveSubtree(lines, hd, { after: sib[i + 1] });
}

/** Take a subtree out of a file, for a move to another file: {lines, map, chunk, level}. */
export function extractSubtree(lines, hd) {
  const { start, end } = removalSpan(lines, hd);
  const chunk = lines.slice(hd.line, subtreeContentEnd(lines, hd));
  const t = tagged(lines);
  t.splice(start, end - start);
  return { ...finish(t, lines.length, -1), chunk, level: hd.level };
}

/** Put a subtree taken from another file at `target` in this one. */
export function insertSubtree(lines, chunk, fromLevel, target) {
  const { p, level } = targetPoint(lines, target);
  const t = tagged(lines);
  const at = insertChunk(t, p, relevel(fresh(chunk), level - fromLevel), level);
  return finish(t, lines.length, at);
}

/**
 * Several edits to one heading as one edit (one undo step, one save): each step is
 * (lines, heading) => result; the heading is found again by line after every step.
 */
export function chain(lines, hd, steps) {
  const oldLength = lines.length;
  let cur = lines;
  let at = hd.line;
  let index = Array.from({ length: oldLength }, (_, i) => i);
  for (const step of steps) {
    const h = parseOrg(cur.join("\n")).headings.find((x) => x.line === at);
    if (!h) throw new Error("lost the heading while editing");
    const r = step(cur, h);
    index = index.map((n) => (n >= 0 ? r.map(n) : -1));
    cur = r.lines;
    at = r.at >= 0 ? r.at : r.map(at);
  }
  const map = (old) => (old >= 0 && old < oldLength ? index[old] : -1);
  return { lines: cur, map, at };
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
