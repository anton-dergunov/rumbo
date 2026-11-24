import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseOrg } from "../app/org.js";
import { partition, reassemble, cellOf, countSpacing, predict, cellSummary, boundaryGaps, edgeMemory, mergeMemory, spacingTable, DEFAULT_RULE, CELLS } from "../app/spacing.js";

function sampleFiles() {
  const root = new URL("../prototype/sample-vault/", import.meta.url).pathname;
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".org")) files.push(p);
    }
  };
  walk(root);
  return files;
}

test("the slots account for every line exactly once", () => {
  const texts = ["", "\n\n", "text only\n\n", "* a", "\n\n* a\n\n\n", "#+T\n\n\n* a\n  \nbody\n  \n** b\n", "* a\n\n** b\n\n* c\nx\n\n\n"];
  for (const p of sampleFiles()) texts.push(readFileSync(p, "utf8"));
  for (const t of texts) {
    const d = parseOrg(t);
    assert.deepEqual(reassemble(partition(d), d.lines), d.lines, JSON.stringify(t.slice(0, 40)));
  }
});

test("who owns a run: a bare heading's lead, a boundary gap, bof and eof", () => {
  const d = parseOrg("\n* A\n\n** a1\n** a2\nnote\n\n** a3\n\n");
  const p = partition(d);
  assert.deepEqual(p.bof, [0, 1]);
  assert.deepEqual(p.kinds, ["bof", "lead", "sep", "sep", "eof"]);
  assert.deepEqual(p.runs, [[1, 1], [2, 3], [4, 4], [6, 7], [8, 9]]);
  assert.deepEqual(p.nodes[2].body, [5, 6]);
  // With a preamble, the gap before the first heading is a boundary gap with no heading before it.
  const q = partition(parseOrg("#+TITLE: x\n\n* A\n"));
  assert.deepEqual(q.kinds, ["sep", "eof"]);
  assert.deepEqual(q.pre, [0, 1]);
  // A planning line is body, as in Emacs: the blank after it is the gap before the child.
  const r = partition(parseOrg("* A\nSCHEDULED: <2027-01-10 Sun>\n\n** b\n"));
  assert.deepEqual(r.kinds, ["bof", "sep", "eof"]);
});

test("the cells: level 1, then the shape alone at any depth", () => {
  assert.equal(cellOf(1, null), "l1");
  assert.equal(cellOf(1, { level: 3, hasBody: true }), "l1");
  assert.equal(cellOf(2, null), "after-preamble");
  assert.equal(cellOf(2, { level: 1, hasBody: true }), "parent-prose");
  assert.equal(cellOf(2, { level: 1, hasBody: false }), "parent-bare");
  assert.equal(cellOf(2, { level: 3, hasBody: false }), "from-deeper-bare");
  assert.equal(cellOf(2, { level: 2, hasBody: true }), "sibling-prose");
  // A section after its sibling starts a new part; a task after a task does not.
  assert.equal(cellOf(2, { level: 2, hasBody: true }, true), "sibling-section");
  assert.equal(cellOf(2, { level: 1, hasBody: true }, true), "parent-prose", "only the sibling cells are split");
  // The same shapes at level 3 and 4 are the same cells: a task after its section's description.
  assert.equal(cellOf(3, { level: 2, hasBody: true }), "parent-prose");
  assert.equal(cellOf(4, { level: 3, hasBody: true }), "parent-prose");
  assert.equal(cellOf(4, { level: 4, hasBody: false }, true), "sibling-section");
  assert.equal(cellOf(6, { level: 6, hasBody: true }), "sibling-prose");
  assert.deepEqual(Object.keys(DEFAULT_RULE).sort(), [...CELLS].sort());
});

test("counting: a fixture with known answers", () => {
  const d = parseOrg("#+TITLE: x\n\n* A\n** TODO a1\n** TODO a2\n\n* B\ntext\n\n** TODO b1\nbody\n** b2\n*** c\n\n** b3\n");
  const counts = countSpacing([d]);
  assert.equal(counts.files, 1);
  assert.deepEqual(counts.cells, {
    l1: { 1: 2 },
    "sibling-bare": { 0: 1 },
    "parent-prose": { 1: 1 },
    "sibling-section": { 0: 1 },
    "from-deeper-bare": { 1: 1 },
  });
  // a1 under bare A and c under bare b2 sit in leads, which are not counted.
  assert.deepEqual(boundaryGaps(d).map((g) => g.node.h.title), ["A", "a2", "B", "b1", "b2", "b3"]);
  assert.deepEqual(countSpacing([parseOrg("* a\r\n\r\n* b\r\n")]), { cells: {}, files: 0 }, "CR files are not counted");
});

test("predict: the majority with 5 examples or more, else keep; the default before counting", () => {
  assert.equal(predict(null, "l1"), 1);
  assert.equal(predict(null, "sibling-bare"), 0);
  assert.equal(predict({ cells: { "sibling-bare": { 0: 4 } }  }, "sibling-bare"), null, "4 examples are not enough");
  assert.equal(predict({ cells: { "sibling-bare": { 0: 4, 1: 1 } }  }, "sibling-bare"), 0);
  assert.equal(predict({ cells: { "sibling-bare": { 0: 1, 1: 5 } }  }, "sibling-bare"), 1, "the vault's own habit wins over the default");
  assert.equal(predict({ cells: {} }, "l1"), null, "counted, but no examples: keep");
  assert.equal(predict({ cells: { "sibling-bare": { 0: 3, 1: 3 } } }, "sibling-bare"), 0, "a tie goes to the default");
  assert.equal(predict({ cells: { l1: { 1: 3, 2: 3 } } }, "l1"), 1);
  assert.deepEqual(cellSummary({ cells: { l1: { 0: 2, 1: 9, 2: 1 } } }, "l1"), { total: 12, best: 1, bestCount: 9 });
});

test("the table of cells, as the spacing report shows it", () => {
  const rows = spacingTable({ cells: { l1: { 1: 9, 0: 1 }, "parent-prose": { 1: 2 } }, files: 1 });
  assert.deepEqual(rows.map((r) => r.cell), CELLS, "every cell, in order");
  assert.deepEqual(rows[0], { cell: "l1", total: 10, counts: [[0, 1], [1, 9]], rule: 1, share: 90, fallback: 1 });
  assert.deepEqual(rows.find((r) => r.cell === "parent-prose"), { cell: "parent-prose", total: 2, counts: [[1, 2]], rule: null, share: null, fallback: 1 }, "too few: keep");
  assert.deepEqual(rows.find((r) => r.cell === "parent-bare"), { cell: "parent-bare", total: 0, counts: [], rule: null, share: null, fallback: 0 });
  // On the sample vault the table holds exactly what countSpacing counted.
  const rule = countSpacing(sampleFiles().map((f) => parseOrg(readFileSync(f, "utf8"))));
  for (const r of spacingTable(rule)) assert.equal(r.total, Object.values(rule.cells[r.cell] || {}).reduce((a, b) => a + b, 0), r.cell);
});

test("the edge memory: runs by the neighbours' identities, none through a heading that isn't unique", () => {
  const m = edgeMemory(parseOrg("#+T: x\n\n* x\n  \n* y\nnote\n* z\n"));
  assert.deepEqual([...m.entries()], [
    ["^\u0001x\u0000", [""]],
    ["x\u0000\u0001y\u0000note", ["  "]],
    ["y\u0000note\u0001z\u0000", []],
  ]);
  assert.equal(edgeMemory(parseOrg("* a\n\n* a\n* b\n")).size, 0);
  // A state or a level is not part of identity; the notes are.
  const a = edgeMemory(parseOrg("* TODO x\n\n* y\n"));
  const b = edgeMemory(parseOrg("** DONE x\n\n** y\n"));
  assert.deepEqual([...a.keys()], [...b.keys()]);
  const merged = mergeMemory(a, new Map([[[...a.keys()][0], ["", ""]]]));
  assert.deepEqual([...merged.values()], [["", ""]], "later wins");
});

test("the spacing report lists the headings that go against their cell", async () => {
  const { spacingReport } = await import("../tools/spacing-report.mjs");
  const files = [
    { path: "a.org", text: "* A\n** 1\n** 2\n** 3\n** 4\n** 5\n\n** 6\n" },
    { path: "b.org", text: "* X\n\n* Y\n* Z\n" },
  ];
  const out = spacingReport(files);
  assert.ok(out.some((l) => /^sibling-section\s+5\s+0: 4, 1: 1\s+0 {2}\(80%\)$/.test(l)), out.join("\n"));
  assert.ok(out.some((l) => /^l1\s+2\s+.*keep \(too few; default 1\)$/.test(l)));
  assert.ok(out.includes("1 headings go against their cell (6 follow it). Each is file:line — cell — what it has or lacks:"));
  assert.ok(out.includes("a.org:8 — sibling-section — has a blank"));
  assert.deepEqual(spacingReport(files, "b.org").filter((l) => /:\d+ — /.test(l)), [], "--file limits the list, not the counts");
});
