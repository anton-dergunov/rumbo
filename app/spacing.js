// Who owns each blank line of an Org file, and the spacing rule counted from the vault
// (docs/plans/real-app.md §5). Pure, no DOM, tested in tests/spacing.test.mjs.
//
// The model is the Emacs one (agentic-org-planner/lisp/ps-blank-lines-tree.el): every line belongs
// to exactly one slot.
//   bof    the blank lines before the first content line
//   pre    the preamble, from its first to its last non-blank line (opaque)
//   per heading, in document order:
//     run    the blank run before it: a boundary gap owned by the seam, or the previous heading's
//            lead (see `kinds`)
//     head   the heading line
//     lead   the blank run after the heading line when the heading has a body (with no body, the
//            run after the heading is the next `run`, of kind "lead" when the next heading is deeper)
//     body   from the first to the last non-blank line after the heading, internal blanks included
//            (opaque; the planning line counts as body, as in Emacs)
//   eof    the blank lines at the end
// Reassembling the slots in order gives the lines back exactly.

export const isBlank = (line) => !/\S/.test(line);

/**
 * The slots of a parsed file, as [start, end) line ranges. `runs[k]` is the blank run before heading
 * k and `runs[N]` is eof. `kinds[k]` says who owns `runs[k]`:
 *   "sep"   a boundary gap (counted by the rule)
 *   "lead"  the previous heading's: it has no body and heading k is deeper
 *   "bof"   heading 0 with no preamble: the blank lines before it are the file's bof (always empty here)
 *   "eof"   the end of the file
 */
export function partition(doc, lines = doc.lines) {
  const hs = doc.headings;
  const n = lines.length;
  const first = hs.length ? hs[0].line : n;
  let a = 0;
  while (a < first && isBlank(lines[a])) a++;
  let b = first;
  while (b > a && isBlank(lines[b - 1])) b--;
  const runs = [];
  const kinds = [];
  if (hs.length) {
    if (b > a) {
      runs.push([b, first]);
      kinds.push("sep");
    } else {
      runs.push([first, first]);
      kinds.push("bof");
    }
  }
  const nodes = hs.map((h, i) => {
    const next = i + 1 < hs.length ? hs[i + 1] : null;
    const to = next ? next.line : n;
    let ls = h.line + 1;
    while (ls < to && isBlank(lines[ls])) ls++;
    let be = to;
    while (be > ls && isBlank(lines[be - 1])) be--;
    const hasBody = be > ls;
    const node = { h, level: h.level, section: !h.state, head: h.line, hasBody, lead: hasBody ? [h.line + 1, ls] : [h.line + 1, h.line + 1], body: hasBody ? [ls, be] : [ls, ls] };
    runs.push(hasBody ? [be, to] : [h.line + 1, to]);
    kinds.push(!next ? "eof" : !hasBody && next.level > h.level ? "lead" : "sep");
    return node;
  });
  if (!hs.length) {
    runs.push([b, n]);
    kinds.push("eof");
  }
  return { bof: [0, a], pre: [a, b], nodes, runs, kinds };
}

/** Lines in slot order; equal to `lines` (tested), so nothing is lost or added. */
export function reassemble(part, lines) {
  const out = [];
  const add = (r) => {
    for (let i = r[0]; i < r[1]; i++) out.push(lines[i]);
  };
  add(part.bof);
  add(part.pre);
  part.nodes.forEach((nd, k) => {
    add(part.runs[k]);
    out.push(lines[nd.head]);
    add(nd.lead);
    add(nd.body);
  });
  add(part.runs[part.nodes.length]);
  return out;
}

/** A heading's identity for the edge memory: its title and its own non-blank body, not its level or state. */
export function identity(title, bodyLines) {
  return `${title}\u0000${bodyLines.filter((l) => !isBlank(l)).join("\n")}`;
}

export const nodeIdentity = (nd, lines) => identity(nd.h.title, lines.slice(nd.body[0], nd.body[1]));

// ---------------------------------------------------------------- the rule

/**
 * The rule cell for the boundary gap before a heading at `level`, after the heading `pred`
 * ({level, hasBody}, or null for the first heading of the file); `section` when the heading is not
 * a task. Built from the cells of Emacs's `ps/blank-lines-rule-cell`, by shape alone below level 1:
 *   - l1                  a top-level heading (always a blank line in the vault);
 *   - after-preamble      the first heading of the file;
 *   - parent-prose/-bare  the first child, after its parent's own text (or a bare parent);
 *   - from-deeper-…       after a closed subtree;
 *   - sibling-section     a section after its sibling: it starts a new part;
 *   - sibling-prose/-bare a task after its sibling, with or without notes.
 * The level doesn't take part: once the owner made the vault consistent (2026-11-22), every shape
 * agreed at levels 2, 3 and 4 alike (for example the first child after its parent's text: 174 of
 * 174, 33 of 33, 2 of 2), so one count per shape also covers the deep levels with few examples.
 */
export function cellOf(level, pred, section = false) {
  if (level === 1) return "l1";
  if (!pred) return "after-preamble";
  const prose = pred.hasBody ? "prose" : "bare";
  if (pred.level < level) return `parent-${prose}`;
  if (pred.level > level) return `from-deeper-${prose}`;
  return section ? "sibling-section" : `sibling-${prose}`;
}

export const CELLS = ["l1", "after-preamble", "parent-prose", "parent-bare", "from-deeper-prose", "from-deeper-bare", "sibling-prose", "sibling-bare", "sibling-section"];

/**
 * Before the vault is counted: a blank line marks a change of shape. One before a level-1 heading,
 * before the first heading, after a parent's text, after a closed subtree, and before a section
 * that follows its sibling; none between tasks (§5).
 */
export const DEFAULT_RULE = {
  l1: 1,
  "after-preamble": 1,
  "parent-prose": 1,
  "parent-bare": 0,
  "from-deeper-prose": 1,
  "from-deeper-bare": 1,
  "sibling-prose": 0,
  "sibling-bare": 0,
  "sibling-section": 1,
};

/** Fewest examples a counted cell needs before it is used, as in Emacs (ps/blank-lines-rule-min-samples). */
export const MIN_SAMPLES = 5;

/** Every boundary gap of one parsed file, with its cell: [{node, k, cell, value}]. */
export function boundaryGaps(doc, part = partition(doc)) {
  const out = [];
  part.nodes.forEach((nd, k) => {
    if (part.kinds[k] !== "sep") return;
    const pred = k > 0 ? part.nodes[k - 1] : null;
    out.push({ node: nd, k, cell: cellOf(nd.level, pred, nd.section), value: part.runs[k][1] - part.runs[k][0] });
  });
  return out;
}

/** Count the boundary gaps of parsed files per cell: {cells: {cell: {value: count}}, files}. */
export function countSpacing(docs) {
  const cells = {};
  let files = 0;
  for (const doc of docs) {
    if (!doc || doc.hasCR) continue;
    files++;
    for (const g of boundaryGaps(doc)) {
      const c = (cells[g.cell] ||= {});
      c[g.value] = (c[g.value] || 0) + 1;
    }
  }
  return { cells, files };
}

/** {total, best, bestCount} for one cell's counts; ties go to the built-in default's value, then to fewer blanks. */
export function cellSummary(rule, cell) {
  const counts = rule?.cells?.[cell] || {};
  let total = 0;
  let best = null;
  let bestCount = 0;
  const values = Object.keys(counts).map(Number).sort((x, y) => x - y);
  for (const v of values) total += counts[v];
  for (const v of values) {
    const c = counts[v];
    if (c > bestCount || (c === bestCount && v === DEFAULT_RULE[cell])) {
      best = v;
      bestCount = c;
    }
  }
  return { total, best, bestCount };
}

/**
 * How many blank lines the rule puts in `cell`: the built-in default when `rule` is null (the vault
 * isn't counted yet), the counted majority when the cell has enough examples, else null ("keep").
 */
export function predict(rule, cell) {
  if (!rule) return DEFAULT_RULE[cell] ?? null;
  const s = cellSummary(rule, cell);
  return s.total >= MIN_SAMPLES ? s.best : null;
}

/**
 * The counted cells as rows, for the spacing report: [{cell, total, counts:
 * [[value, n]], rule, share, fallback}]. `rule` is what the rule puts there (null = keep, too few
 * examples), `share` the majority's percentage, `fallback` the built-in default a kept cell has.
 */
export function spacingTable(rule) {
  return CELLS.map((cell) => {
    const s = cellSummary(rule, cell);
    const counts = Object.entries(rule?.cells?.[cell] || {}).map(([v, n]) => [Number(v), n]).sort((a, b) => a[0] - b[0]);
    const p = predict(rule, cell);
    return { cell, total: s.total, counts, rule: p, share: p == null || !s.total ? null : Math.round((100 * s.bestCount) / s.total), fallback: DEFAULT_RULE[cell] };
  });
}

// ---------------------------------------------------------------- the edge memory

export const START = "^";
const edgeKey = (a, b) => `${a}\u0001${b}`;

/** Identities that occur more than once among `ids`: an edge through them can't be told apart. */
export function ambiguous(ids) {
  const seen = new Set();
  const twice = new Set();
  for (const id of ids) (seen.has(id) ? twice : seen).add(id);
  return twice;
}

/**
 * The blank runs between neighbours in a parsed file, keyed by the neighbours' identities:
 * Map "pred\u0001succ" -> the run's lines. The file's start is START; the end isn't kept (eof never
 * moves). Neighbours whose identity isn't unique in the file are left out.
 */
export function edgeMemory(doc) {
  const lines = doc.lines;
  const part = partition(doc);
  const ids = part.nodes.map((nd) => nodeIdentity(nd, lines));
  const twice = ambiguous(ids);
  const mem = new Map();
  part.nodes.forEach((nd, k) => {
    if (part.kinds[k] === "bof") return;
    const p = k > 0 ? ids[k - 1] : START;
    if (twice.has(ids[k]) || twice.has(p)) return;
    mem.set(edgeKey(p, ids[k]), lines.slice(part.runs[k][0], part.runs[k][1]));
  });
  return mem;
}

/** One memory from several, the later ones winning. */
export function mergeMemory(...mems) {
  const out = new Map();
  for (const m of mems) if (m) for (const [k, v] of m) out.set(k, v);
  return out;
}

export const recall = (memory, predId, succId) => (memory ? memory.get(edgeKey(predId, succId)) : undefined);
