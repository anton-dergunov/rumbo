import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseOrg } from "../app/org.js";
import { partition, reassemble, cellOf, countSpacing, predict, cellSummary, boundaryGaps, edgeMemory, mergeMemory, DEFAULT_RULE, CELLS } from "../app/spacing.js";

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

test("the cells are Emacs's, with level 3 apart from 4 and deeper", () => {
  assert.equal(cellOf(1, null), "l1");
  assert.equal(cellOf(1, { level: 3, hasBody: true }), "l1");
  assert.equal(cellOf(2, null), "l2-after-preamble");
  assert.equal(cellOf(2, { level: 1, hasBody: true }), "l2-parent-prose");
  assert.equal(cellOf(2, { level: 1, hasBody: false }), "l2-parent-bare");
  assert.equal(cellOf(2, { level: 3, hasBody: false }), "l2-from-deeper-bare");
  assert.equal(cellOf(2, { level: 2, hasBody: true }), "l2-sibling-prose");
  assert.equal(cellOf(3, { level: 1, hasBody: true }), "l3");
  assert.equal(cellOf(5, null), "l4+");
  assert.deepEqual(Object.keys(DEFAULT_RULE).sort(), [...CELLS].sort());
});

test("counting: a fixture with known answers", () => {
  const d = parseOrg("#+TITLE: x\n\n* A\n** a1\n** a2\n\n* B\ntext\n\n** b1\nbody\n** b2\n*** c\n\n** b3\n");
  const counts = countSpacing([d]);
  assert.equal(counts.files, 1);
  assert.deepEqual(counts.cells, {
    l1: { 1: 2 },
    "l2-sibling-bare": { 0: 1 },
    "l2-parent-prose": { 1: 1 },
    "l2-sibling-prose": { 0: 1 },
    "l2-from-deeper-bare": { 1: 1 },
  });
  // a1 under bare A and c under bare b2 sit in leads, which are not counted.
  assert.deepEqual(boundaryGaps(d).map((g) => g.node.h.title), ["A", "a2", "B", "b1", "b2", "b3"]);
  assert.deepEqual(countSpacing([parseOrg("* a\r\n\r\n* b\r\n")]), { cells: {}, files: 0 }, "CR files are not counted");
});

test("predict: the majority with 5 examples or more, else keep; the default before counting", () => {
  assert.equal(predict(null, "l1"), 1);
  assert.equal(predict(null, "l2-sibling-bare"), 0);
  assert.equal(predict({ cells: { l3: { 0: 4 } } }, "l3"), null, "4 examples are not enough");
  assert.equal(predict({ cells: { l3: { 0: 4, 1: 1 } } }, "l3"), 0);
  assert.equal(predict({ cells: { l3: { 0: 1, 1: 5 } } }, "l3"), 1, "the vault's own habit wins over the default");
  assert.equal(predict({ cells: {} }, "l1"), null, "counted, but no examples: keep");
  assert.equal(predict({ cells: { "l2-sibling-bare": { 0: 3, 1: 3 } } }, "l2-sibling-bare"), 0, "a tie goes to the default");
  assert.equal(predict({ cells: { l1: { 1: 3, 2: 3 } } }, "l1"), 1);
  assert.deepEqual(cellSummary({ cells: { l1: { 0: 2, 1: 9, 2: 1 } } }, "l1"), { total: 12, best: 1, bestCount: 9 });
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
  assert.ok(out.some((l) => /^l2-sibling-bare\s+5\s+0: 4, 1: 1\s+0 {2}\(80%\)$/.test(l)), out.join("\n"));
  assert.ok(out.some((l) => /^l1\s+2\s+.*keep \(too few; default 1\)$/.test(l)));
  assert.ok(out.includes("1 headings go against their cell (6 follow it). Each is file:line — cell — what it has or lacks:"));
  assert.ok(out.includes("a.org:8 — l2-sibling-bare — has a blank"));
  assert.deepEqual(spacingReport(files, "b.org").filter((l) => l.includes(" — l")), [], "--file limits the list, not the counts");
});
