import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOrg } from "../app/org.js";
import { joinLines, setState, moveSubtree } from "../app/org-edit.js";
import { applyOp, applyOps, makeOp, targetArg, checkResult, OPS, OpError, OP_VERSION } from "../app/ops.js";
import { casesFor } from "../tools/op-cases.mjs";

const RAW = [
  "#+TITLE: Errands",
  "",
  "* Money",
  "** TODO Check receipts",
  "** WAIT Cashback :phone:",
  "SCHEDULED: <2027-01-10 Sun>",
  "Payment within 3-6 months",
  "",
  "** TODO [#A] Call the GP :phone:easy:",
  "- first point",
  "",
  "* Home",
  "** DONE Fixed the tap",
  "** TODO Last thing",
  "",
].join("\n");

const doc = (t = RAW) => parseOrg(t);
const find = (d, title) => d.headings.find((h) => h.title === title);
const code = (fn) => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof OpError, err.message);
    return err.code;
  }
  return null;
};

test("every op is plain JSON and runs the same after a round trip through text", () => {
  const d = doc();
  let n = 0;
  for (const hd of d.headings) {
    for (const c of casesFor(d, hd, find(d, "Home"))) {
      const again = JSON.parse(JSON.stringify(c.op));
      assert.deepEqual(again, c.op, c.name);
      assert.equal(again.v, OP_VERSION);
      assert.deepEqual(applyOp(d.lines, d, again).lines, applyOp(d.lines, d, c.op).lines, c.name);
      n++;
    }
  }
  assert.ok(n > 40);
  for (const name of Object.keys(OPS)) assert.ok(typeof OPS[name].run === "function" && typeof OPS[name].plan === "function", name);
});

test("an op finds its heading by title path, after other edits moved it", () => {
  const d = doc();
  const op = makeOp(d, "setState", find(d, "Call the GP"), { state: "DONE" }, "Errands.org");
  assert.equal(op.path, "Errands.org");
  const moved = doc("* New top\n\n" + RAW);
  const r = applyOp(moved.lines, moved, op);
  assert.equal(r.lines[find(moved, "Call the GP").line], "** DONE [#A] Call the GP :phone:easy:");
});

test("refusals: lost, invalid", () => {
  const d = doc();
  const op = makeOp(d, "setState", find(d, "Call the GP"), { state: "DONE" });
  const renamed = doc(RAW.replace("Call the GP", "Call the dentist"));
  assert.equal(code(() => applyOp(renamed.lines, renamed, op)), "lost");
  assert.equal(code(() => makeOp(renamed, "setState", find(d, "Home"))), "lost", "a heading from an older parse");
  assert.equal(code(() => applyOp(d.lines, d, { ...op, v: 2 })), "invalid");
  assert.equal(code(() => applyOp(d.lines, d, { ...op, op: "rewriteEverything" })), "invalid");
  assert.equal(code(() => applyOp(d.lines, d, makeOp(d, "promote", find(d, "Money")))), "invalid");
  assert.equal(code(() => applyOp(d.lines, d, makeOp(d, "moveSubtree", find(d, "Money"), { target: targetArg(d, { into: find(d, "Cashback") }) }))), "invalid");
  assert.equal(code(() => applyOp(d.lines, d, makeOp(d, "insertSubtree", null, { fromLevel: 1, target: { fileEnd: true } }))), "invalid");
  assert.equal(code(() => applyOp(d.lines, d, makeOp(d, "setBody", find(d, "Home"), { text: "fine\n* not a note" }))), "invalid");
});

test("invariant: a line outside the edit changed", () => {
  const d = doc();
  const hd = find(d, "Check receipts");
  const r = setState(d.lines, hd, "DONE");
  const plan = OPS.setState.plan({ lines: d.lines, doc: d, hd, args: { state: "DONE" } }, r);
  assert.equal(checkResult(d.lines, plan, r), null);
  const bad = { ...r, lines: r.lines.map((l, i) => (i === 0 ? "#+TITLE: Changed" : l)) };
  assert.match(checkResult(d.lines, plan, bad), /line 1 changed, outside the edit/);
  const swapped = { ...r, lines: [r.lines[2], r.lines[0], r.lines[1], ...r.lines.slice(3)], map: (i) => (i === 2 ? 0 : i < 2 ? i + 1 : r.map(i)) };
  assert.match(checkResult(d.lines, plan, swapped), /line 3 moved, outside the edit/);
});

test("invariant: with blank lines removed, nothing else changed", () => {
  const d = doc();
  const hd = find(d, "Check receipts");
  const r = setState(d.lines, hd, "DONE");
  const plan = OPS.setState.plan({ lines: d.lines, doc: d, hd, args: { state: "DONE" } }, r);
  const extra = { ...r, lines: [...r.lines.slice(0, 4), "junk", ...r.lines.slice(4)], map: (i) => (i <= hd.line ? i : i + 1) };
  assert.match(checkResult(d.lines, plan, extra), /changed beyond the edit/);
});

test("invariant: a moved section arrives whole", () => {
  const d = doc();
  const hd = find(d, "Cashback");
  const target = { fileEnd: true, level: 1 };
  const r = moveSubtree(d.lines, d, hd, target);
  const plan = OPS.moveSubtree.plan({ lines: d.lines, doc: d, hd, args: { target }, find: () => null }, r);
  assert.equal(checkResult(d.lines, plan, r), null);
  const broken = { ...r, lines: r.lines.map((l, i) => (i === r.at + 2 ? "Payment within 3-6 months!" : l)) };
  assert.match(checkResult(d.lines, plan, broken), /did not arrive whole/);
});

test("invariant: no new conflict markers; the heading reads as asked", () => {
  const d = doc();
  const home = find(d, "Home");
  assert.equal(code(() => applyOp(d.lines, d, makeOp(d, "setBody", home, { text: "a\n=======\nb" }))), "invariant");
  const marked = doc(RAW.replace("- first point", "======= old"));
  assert.doesNotThrow(() => applyOp(marked.lines, marked, makeOp(marked, "setState", find(marked, "Home"), { state: "TODO" })), "markers that were there already");
  // A title that starts with a state word would be read back as that state: refused.
  assert.equal(code(() => applyOp(d.lines, d, makeOp(d, "setTitle", find(d, "Money"), { title: "TODO later" }))), "invariant");
});

test("several ops as one edit: planning, notes, then the heading", () => {
  const d = doc();
  const gp = find(d, "Call the GP");
  const r = applyOps(d.lines, d, [
    makeOp(d, "setPlanning", gp, { patch: { deadline: { date: "2027-01-15" } } }),
    makeOp(d, "setBody", gp, { text: "- first point\n- second" }),
    makeOp(d, "setHeading", gp, { patch: { state: "NEXT", tags: ["phone"], title: "Call the GP surgery" } }),
  ]);
  assert.deepEqual(r.lines.slice(gp.line, gp.line + 4), ["** NEXT [#A] Call the GP surgery :phone:", "DEADLINE: <2027-01-15 Fri>", "- first point", "- second"]);
  assert.equal(r.at, gp.line);
  assert.equal(r.map(gp.line + 3), gp.line + 5, "the blank before * Home");
  assert.equal(r.results.length, 3);
  // The other way round the new title hides the heading from the next op.
  const wrong = [makeOp(d, "setTitle", gp, { title: "Renamed" }), makeOp(d, "setBody", gp, { text: "x" })];
  assert.equal(code(() => applyOps(d.lines, d, wrong)), "lost");
  assert.equal(joinLines(applyOps(d.lines, d, []).lines, d.finalNewline), RAW);
});

test("removeDone and a move to another file, as ops", () => {
  const d = doc();
  const r = applyOp(d.lines, d, makeOp(d, "removeDone", null, { scope: makeOp(d, "x", find(d, "Home")).key }));
  assert.equal(r.removed, 1);
  assert.ok(!r.lines.includes("** DONE Fixed the tap"));
  const out = applyOp(d.lines, d, makeOp(d, "extractSubtree", find(d, "Cashback")));
  const b = doc("* Inbox\n");
  const put = applyOp(b.lines, b, makeOp(b, "insertSubtree", null, { chunk: out.chunk, fromLevel: out.level, target: targetArg(b, { into: find(b, "Inbox"), at: "last" }) }));
  assert.deepEqual(put.lines, ["* Inbox", "** WAIT Cashback :phone:", "SCHEDULED: <2027-01-10 Sun>", "Payment within 3-6 months"]);
});
