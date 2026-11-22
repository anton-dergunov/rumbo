// Property tests of the blank-line model and the ops (real-app.md §8, "Blank lines and edits"):
// for every op on every heading of generated outlines and of the sample vault,
//   - the invariants of §5 hold (applyOp throws otherwise);
//   - the runs between headings that are neighbours both before and after are byte-identical;
//   - move then move back, extract then insert back, and a state change and back give the original bytes;
//   - an insert's new seams follow the cell rule;
//   - nothing edited means the same bytes.
// fast-check is a devDependency: without `npm install` the generated part is skipped.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseOrg } from "../app/org.js";
import { joinLines } from "../app/org-edit.js";
import { applyOp, makeOp } from "../app/ops.js";
import { partition, reassemble, nodeIdentity, ambiguous, cellOf, predict, START } from "../app/spacing.js";
import { casesFor, roundTrips } from "../tools/op-cases.mjs";

let fc = null;
try {
  fc = (await import("fast-check")).default;
} catch {
  // not installed
}
const needsFc = { skip: fc ? false : "fast-check is not installed: run npm install" };

/** The runs between neighbours, keyed by the neighbours' identities (unique ones only). */
function runsByEdge(doc) {
  const part = partition(doc);
  const ids = part.nodes.map((nd) => nodeIdentity(nd, doc.lines));
  const twice = ambiguous(ids);
  const out = new Map();
  part.nodes.forEach((nd, k) => {
    const p = k ? ids[k - 1] : START;
    if (twice.has(ids[k]) || twice.has(p)) return;
    out.set(`${p}\u0001${ids[k]}`, doc.lines.slice(part.runs[k][0], part.runs[k][1]).join("\n"));
  });
  return out;
}

/** Everything the properties say about one text; returns the failures as strings. */
function checkText(text) {
  const fails = [];
  const doc = parseOrg(text);
  if (joinLines(reassemble(partition(doc), doc.lines), doc.finalNewline) !== text.replace(/\r\n?/g, "\n")) fails.push("partition does not round-trip");
  const before = runsByEdge(doc);
  for (const hd of doc.headings) {
    const other = doc.headings.find((x) => x !== hd && (x.line < hd.line || x.line >= hd.end) && x.level < 3) || null;
    for (const c of casesFor(doc, hd, other)) {
      let r;
      try {
        r = applyOp(doc.lines, doc, c.op);
      } catch (err) {
        fails.push(`${c.name} on line ${hd.line + 1}: ${err.code} ${err.message}`);
        continue;
      }
      const after = parseOrg(joinLines(r.lines, doc.finalNewline));
      for (const [edge, run] of runsByEdge(after)) {
        if (before.has(edge) && before.get(edge) !== run) fails.push(`${c.name} on line ${hd.line + 1}: an untouched run changed`);
      }
      if (c.name.startsWith("insert")) {
        const part = partition(after);
        const k = part.nodes.findIndex((nd) => nd.head === r.at);
        for (const j of [k, k + 1]) {
          if (j < 0 || j >= part.nodes.length || part.kinds[j] !== "sep") continue;
          const want = predict(null, cellOf(part.nodes[j].level, j ? part.nodes[j - 1] : null));
          const got = part.runs[j][1] - part.runs[j][0];
          if (want !== got) fails.push(`${c.name} on line ${hd.line + 1}: a new seam has ${got} blank lines, the rule says ${want}`);
        }
      }
    }
    for (const t of roundTrips(text, hd, other)) if (!t.ok) fails.push(`${t.name} on line ${hd.line + 1}: ${t.why}`);
    const same = applyOp(doc.lines, doc, makeOp(doc, "setState", hd, { state: hd.state }));
    if (joinLines(same.lines, doc.finalNewline) !== text) fails.push(`no-op on line ${hd.line + 1} changed the text`);
  }
  return fails;
}

test("every op on every heading of the sample vault", () => {
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
  assert.ok(files.length > 5);
  for (const p of files) assert.deepEqual(checkText(readFileSync(p, "utf8")), [], p);
});

// ---------------------------------------------------------------- generated outlines

const gapArb = () => (fc ? fc.constantFrom([], [], [""], [""], ["", ""], ["  "], ["\t", ""]) : null);
const bodyLineArb = () => (fc ? fc.constantFrom("text", "- item", "  indented", "", "  ", "SCHEDULED: <2027-01-10 Sun>", "[[obsidian:Note]]") : null);

function outlineArb() {
  const node = fc.record({
    step: fc.integer({ min: -2, max: 2 }),
    state: fc.constantFrom(null, "TODO", "NEXT", "DONE"),
    dup: fc.boolean(),
    body: fc.array(bodyLineArb(), { maxLength: 3 }),
    src: fc.boolean(),
    lead: gapArb(),
    sep: gapArb(),
  });
  return fc.record({
    pre: fc.constantFrom(null, ["#+TITLE: T"], ["#+TITLE: T", "", "Charter text"]),
    bof: gapArb(),
    nodes: fc.array(node, { minLength: 1, maxLength: 9 }),
    eof: gapArb(),
    finalNewline: fc.boolean(),
  });
}

function render(o) {
  const lines = [...o.bof, ...(o.pre || [])];
  let level = 0;
  o.nodes.forEach((n, i) => {
    level = i === 0 ? 1 + (n.step & 1) : Math.min(5, Math.max(1, level + n.step));
    if (i > 0 || o.pre) lines.push(...n.sep);
    const title = n.dup && i > 1 ? "Same" : `Heading ${i}`;
    lines.push(`${"*".repeat(level)} ${n.state ? n.state + " " : ""}${title}`);
    lines.push(...n.lead);
    lines.push(...n.body);
    if (n.src) lines.push("#+begin_src", "a", "", "b", "#+end_src");
  });
  lines.push(...o.eof);
  const text = lines.join("\n");
  return o.finalNewline ? text + "\n" : text;
}

test("generated outlines: every op on every heading", needsFc, () => {
  fc.assert(
    fc.property(outlineArb(), (o) => {
      const text = render(o);
      const fails = checkText(text);
      if (fails.length) throw new Error(`${JSON.stringify(text)}\n${fails.join("\n")}`);
    }),
    { numRuns: 300 },
  );
});
