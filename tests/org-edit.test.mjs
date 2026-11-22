import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseOrg } from "../app/org.js";
import { edgeMemory } from "../app/spacing.js";
import {
  editHeadingLine,
  formatHeadingLine,
  setState,
  setPriority,
  setTitle,
  setTags,
  setHeading,
  orgStamp,
  setPlanning,
  bodyText,
  setBody,
  insertHeading,
  deleteSubtree,
  removeDone,
  moveSubtree,
  moveUp,
  moveDown,
  promote,
  demote,
  extractSubtree,
  insertSubtree,
  headingKey,
  findHeading,
  joinLines,
} from "../app/org-edit.js";

// Tests of app/org-edit.js. The span edits (heading, planning, notes) are the prototype's; insert, delete
// and move follow the Emacs blank-line model (real-app.md §5), with the built-in rule unless a test passes one.
//
// Blank lines, trailing spaces, a tab, old column-aligned tags, a planning line with text after it,
// a repeater, and no newline at the end of the file.
const RAW = [
  "#+TITLE: Errands",
  "",
  "Charter line with trailing spaces   ",
  "",
  "* Money",
  "** TODO Check receipts",
  "** WAIT Cashback from the energy supplier                    :phone:",
  "SCHEDULED: <2027-01-10 Sun>",
  "Payment within 3-6 months\t",
  "",
  "   indented note  ",
  "",
  "** TODO [#A] Call the GP :phone:easy:",
  "- first point",
  "",
  "* Home",
  "",
  "** MAYB Send the old licence",
  "SCHEDULED: <2027-08-02 Mon +1w> Read [[obsidian:Plan]] first",
  "*** NEXT Deep task",
  "** DONE Fixed the tap",
  "*** DONE Bought washers",
  "",
  "** TODO Last thing",
].join("\n");

const nonBlank = (lines) => lines.filter((l) => l.trim()).sort();
const doc = (text = RAW) => parseOrg(text);
const find = (d, title) => d.headings.find((h) => h.title === title);

/** Every line outside [start, start+removed) is byte-identical, and the inserted lines are `inserted`. */
function assertOnlyChanged(oldLines, newLines, start, removed, inserted) {
  assert.deepEqual(newLines.slice(0, start), oldLines.slice(0, start), "lines before the edit");
  assert.deepEqual(newLines.slice(start, start + inserted.length), inserted, "the edited lines");
  assert.deepEqual(newLines.slice(start + inserted.length), oldLines.slice(start + removed), "lines after the edit");
}

test("parser: repeat, finalNewline, hasCR", () => {
  const d = doc();
  assert.equal(find(d, "Send the old licence").planning.scheduled.repeat, "+1w");
  assert.equal(d.finalNewline, false);
  assert.equal(parseOrg("* a\n").finalNewline, true);
  assert.equal(parseOrg("* a\r\n").hasCR, true);
  assert.equal(joinLines(d.lines, d.finalNewline), RAW);
});

test("heading line: each part in place, untouched parts keep their bytes", () => {
  const aligned = "** WAIT Cashback from the energy supplier                    :phone:";
  assert.equal(editHeadingLine(aligned, { state: "NEXT" }), "** NEXT Cashback from the energy supplier                    :phone:");
  assert.equal(editHeadingLine(aligned, { priority: "A" }), "** WAIT [#A] Cashback from the energy supplier                    :phone:");
  assert.equal(editHeadingLine(aligned, { tags: ["phone"] }), aligned, "same tags: no change");
  assert.equal(editHeadingLine(aligned, { tags: ["phone", "easy"] }), "** WAIT Cashback from the energy supplier :phone:easy:");
  assert.equal(editHeadingLine(aligned, { tags: [] }), "** WAIT Cashback from the energy supplier");
  assert.equal(editHeadingLine("** TODO [#A] Call the GP :phone:", { state: null, priority: null }), "** Call the GP :phone:");
  assert.equal(editHeadingLine("* Money", { state: "TODO" }), "* TODO Money");
  assert.equal(editHeadingLine("* Money", { title: "Money and bills\n" }), "* Money and bills");
  assert.equal(editHeadingLine("** TODO x", { level: 4 }), "**** TODO x");
  assert.equal(editHeadingLine("** TODO Call the GP :a:", { title: "Call the GP" }), "** TODO Call the GP :a:", "same title: no change");
  assert.throws(() => editHeadingLine("** x", { state: "LATER" }));
  assert.equal(formatHeadingLine({ level: 2, state: "TODO", priority: "A", title: " New ", tags: ["phone", "bad tag", "phone"] }), "** TODO [#A] New :phone:");
  assert.equal(formatHeadingLine({ level: 1, title: "Section" }), "* Section");
});

test("state, priority, title, tags: only the heading line changes", () => {
  const d = doc();
  const wait = find(d, "Cashback from the energy supplier");
  for (const r of [setState(d.lines, wait, "DONE"), setPriority(d.lines, wait, "A"), setTitle(d.lines, wait, "Cashback"), setTags(d.lines, wait, ["easy"])]) {
    assert.equal(r.at, wait.line);
    assertOnlyChanged(d.lines, r.lines, wait.line, 1, [r.lines[wait.line]]);
    assert.notEqual(r.lines[wait.line], d.lines[wait.line]);
    assert.equal(r.map(wait.line), wait.line);
    assert.equal(r.map(20), 20);
  }
  const same = setHeading(d.lines, wait, { state: "WAIT" });
  assert.deepEqual(same.lines, d.lines);
});

test("stamps: weekday in English, time, repeat, inactive", () => {
  assert.equal(orgStamp({ date: "2027-01-10" }), "<2027-01-10 Sun>");
  assert.equal(orgStamp({ date: "2026-11-21", time: "09:30", end: "10:00", repeat: "+1w" }), "<2026-11-21 Sat 09:30-10:00 +1w>");
  assert.equal(orgStamp({ date: "2026-11-23", active: false }), "[2026-11-23 Mon]");
  assert.throws(() => orgStamp({ date: "21/11/2026" }));
});

test("planning: replace, add, clear, keep text after the stamps", () => {
  const d = doc();
  const wait = find(d, "Cashback from the energy supplier");
  let r = setPlanning(d.lines, wait, { scheduled: { date: "2027-02-01" } });
  assertOnlyChanged(d.lines, r.lines, wait.planningLine, 1, ["SCHEDULED: <2027-02-01 Mon>"]);
  r = setPlanning(d.lines, wait, { deadline: { date: "2027-03-01" } });
  assertOnlyChanged(d.lines, r.lines, wait.planningLine, 1, ["DEADLINE: <2027-03-01 Mon> SCHEDULED: <2027-01-10 Sun>"]);
  r = setPlanning(d.lines, wait, { scheduled: null });
  assertOnlyChanged(d.lines, r.lines, wait.planningLine, 1, []);
  assert.equal(r.map(wait.planningLine), -1);
  assert.equal(r.map(wait.planningLine + 1), wait.planningLine);

  const gp = find(d, "Call the GP");
  r = setPlanning(d.lines, gp, { scheduled: { date: "2027-01-11", time: "10:00" } });
  assertOnlyChanged(d.lines, r.lines, gp.line + 1, 0, ["SCHEDULED: <2027-01-11 Mon 10:00>"]);
  assert.deepEqual(setPlanning(d.lines, gp, { scheduled: null }).lines, d.lines, "clearing a missing stamp is a no-op");

  const mayb = find(d, "Send the old licence");
  r = setPlanning(d.lines, mayb, { deadline: { date: "2027-09-01" } });
  assertOnlyChanged(d.lines, r.lines, mayb.planningLine, 1, ["DEADLINE: <2027-09-01 Wed> SCHEDULED: <2027-08-02 Mon +1w> Read [[obsidian:Plan]] first"]);
  r = setPlanning(d.lines, mayb, { scheduled: null });
  assertOnlyChanged(d.lines, r.lines, mayb.planningLine, 1, ["Read [[obsidian:Plan]] first"]);
  r = setPlanning(d.lines, mayb, { scheduled: { date: "2027-08-09", repeat: "+1w" } });
  assertOnlyChanged(d.lines, r.lines, mayb.planningLine, 1, ["SCHEDULED: <2027-08-09 Mon +1w> Read [[obsidian:Plan]] first"]);
});

test("body: raw text in, only the notes' lines out; the separator stays", () => {
  const d = doc();
  const wait = find(d, "Cashback from the energy supplier");
  assert.equal(bodyText(d.lines, wait), "Payment within 3-6 months\t\n\n   indented note  ");
  let r = setBody(d.lines, wait, "Paid.\n\n");
  assertOnlyChanged(d.lines, r.lines, wait.planningLine + 1, 3, ["Paid."]);
  assert.equal(r.lines[wait.planningLine + 2], "", "the blank line before the next task is kept");
  assert.deepEqual(setBody(d.lines, wait, bodyText(d.lines, wait)).lines, d.lines);

  const check = find(d, "Check receipts");
  r = setBody(d.lines, check, "New note\n  with indent  ");
  assertOnlyChanged(d.lines, r.lines, check.line + 1, 0, ["New note", "  with indent  "]);
  assert.throws(() => setBody(d.lines, check, "fine\n* not a note"));
  assert.doesNotThrow(() => setBody(d.lines, check, "*bold* is fine"));
});


// Slots of RAW (0-based lines): the preamble ends at 2, a blank before * Money (3); Money has no body,
// so the run before Check receipts (none) is its lead; Cashback's body is 7-10 and the blank at 11 is
// the gap before Call the GP; the blank at 14 is the gap before * Home; the blank at 16 is Home's lead;
// the blank at 22 is the gap before Last thing (after a closed subtree).

const text = (r, d) => joinLines(r.lines, d.finalNewline);
const COUNTED_EMPTY = { cells: {}, files: 1 }; // counted, but no cell has enough examples: every new seam keeps

test("insert: new seams follow the rule; the lead of a bare parent stays its own", () => {
  const d = doc();
  const check = find(d, "Check receipts");
  // After a bare sibling, before a sibling: level 2 between siblings has no blank.
  let r = insertHeading(d.lines, d, check, "after", { state: "TODO", title: "New one" });
  assertOnlyChanged(d.lines, r.lines, 6, 0, ["** TODO New one"]);
  assert.equal(r.at, 6);

  // After a sibling with notes, before a level-1 heading: none, then one.
  const gp = find(d, "Call the GP");
  r = insertHeading(d.lines, d, gp, "after", { state: "TODO", title: "After GP", tags: ["easy"], scheduled: { date: "2027-01-12" }, body: "note\n" });
  assertOnlyChanged(d.lines, r.lines, 14, 1, ["** TODO After GP :easy:", "SCHEDULED: <2027-01-12 Tue>", "note", ""]);

  // First child of a bare parent: the parent's lead (the blank at 16) stays right after it.
  const home = find(d, "Home");
  r = insertHeading(d.lines, d, home, "firstChild", { state: "NEXT", title: "First" });
  assertOnlyChanged(d.lines, r.lines, 17, 0, ["** NEXT First"]);
  assert.equal(r.at, 17);
  // Last child, at the end of the file: no blank after a bare sibling, and the end of the file stays.
  r = insertHeading(d.lines, d, home, "lastChild", { state: "TODO", title: "Final" });
  assertOnlyChanged(d.lines, r.lines, 24, 0, ["** TODO Final"]);
  assert.equal(r.at, 24);

  // A level-1 section gets a blank on both sides.
  r = insertHeading(d.lines, d, find(d, "Money"), "after", { title: "Work" });
  assertOnlyChanged(d.lines, r.lines, 14, 1, ["", "* Work", ""]);
  r = insertHeading(d.lines, d, null, "end", { level: 1, title: "Tail" });
  assertOnlyChanged(d.lines, r.lines, 24, 0, ["", "* Tail"]);
  assert.equal(r.at, 25);
  assert.equal(text(r, d).endsWith("* Tail"), true, "still no newline at the end");
});

test("insert: with no evidence for a cell, both new seams keep the run that was there", () => {
  const d = doc();
  let r = insertHeading(d.lines, d, find(d, "Check receipts"), "after", { title: "New" }, { rule: COUNTED_EMPTY });
  assertOnlyChanged(d.lines, r.lines, 6, 0, ["** New"]);
  r = insertHeading(d.lines, d, find(d, "Call the GP"), "after", { title: "New" }, { rule: COUNTED_EMPTY });
  assertOnlyChanged(d.lines, r.lines, 14, 1, ["", "** New", ""]);
});

test("delete: the two gaps become one seam, resolved again", () => {
  const d = doc();
  const check = find(d, "Check receipts");
  let r = deleteSubtree(d.lines, d, check);
  assertOnlyChanged(d.lines, r.lines, 5, 1, []);
  // Between Cashback's notes and * Home: the level-1 rule puts one blank line.
  r = deleteSubtree(d.lines, d, find(d, "Call the GP"));
  assertOnlyChanged(d.lines, r.lines, 11, 4, [""]);
  // Last thing now follows a closed subtree, and keeps its blank line.
  r = deleteSubtree(d.lines, d, find(d, "Fixed the tap"));
  assertOnlyChanged(d.lines, r.lines, 20, 3, [""]);
  // Home's lead stays with Home.
  r = deleteSubtree(d.lines, d, find(d, "Send the old licence"));
  assertOnlyChanged(d.lines, r.lines, 17, 3, []);
  // The last entry of the file: the gap before it goes too, so nothing dangles at the end.
  const last = find(d, "Last thing");
  r = deleteSubtree(d.lines, d, last);
  assertOnlyChanged(d.lines, r.lines, 22, 2, []);
  assert.equal(r.map(last.line), -1);
  assert.equal(r.map(0), 0);
});

test("remove done: outermost DONE subtrees, in one edit", () => {
  const d = doc();
  const r = removeDone(d.lines, d, find(d, "Home"));
  assert.equal(r.removed, 1);
  assertOnlyChanged(d.lines, r.lines, 20, 3, [""]);
  assert.equal(r.at, find(d, "Home").line);
  assert.equal(removeDone(d.lines, d, find(d, "Money")).removed, 0);
});

test("move: up, down, into a section, out; only stars change in the moved lines", () => {
  const d = doc();
  const L = d.lines;
  const gp = find(d, "Call the GP");
  let r = moveUp(L, d, gp);
  assert.deepEqual(r.lines, [...L.slice(0, 6), L[12], L[13], ...L.slice(6, 11), "", ...L.slice(15)]);
  assert.equal(r.map(gp.line), 6);
  assert.equal(r.at, 6);

  // Check receipts goes after Cashback: neither new seam between siblings has a blank line.
  r = moveDown(L, d, find(d, "Check receipts"));
  const nd2 = parseOrg(text(r, d));
  assert.deepEqual(find(nd2, "Money").children.map((x) => x.title), ["Cashback from the energy supplier", "Check receipts", "Call the GP"]);
  assert.deepEqual(r.lines.slice(9, 12), ["   indented note  ", "** TODO Check receipts", "** TODO [#A] Call the GP :phone:easy:"]);
  assert.deepEqual(nonBlank(r.lines), nonBlank(L));

  const mayb = find(d, "Send the old licence");
  r = moveSubtree(L, d, mayb, { into: find(d, "Money"), at: "first" });
  const nd3 = parseOrg(text(r, d));
  assert.deepEqual(find(nd3, "Money").children.map((x) => x.title), ["Send the old licence", "Check receipts", "Cashback from the energy supplier", "Call the GP"]);
  assert.equal(find(nd3, "Deep task").level, 3);
  assert.equal(r.lines[r.map(mayb.planningLine)], L[mayb.planningLine], "planning line moved untouched");
  // A blank line after Deep task, which closes a subtree; Home keeps its lead.
  assert.deepEqual(r.lines.slice(4, 9), ["* Money", "** MAYB Send the old licence", L[18], "*** NEXT Deep task", ""]);
  assert.deepEqual(r.lines.slice(r.map(15), r.map(15) + 3), ["* Home", "", "** DONE Fixed the tap"]);

  r = moveSubtree(L, d, mayb, { into: find(d, "Money"), at: "last" });
  assert.deepEqual(find(parseOrg(text(r, d)), "Money").children.map((x) => x.title).at(-1), "Send the old licence");

  r = moveSubtree(L, d, find(d, "Deep task"), { after: find(d, "Home") });
  const nd5 = parseOrg(text(r, d));
  assert.equal(find(nd5, "Deep task").level, 1);
  assert.deepEqual(r.lines.slice(-3), ["** TODO Last thing", "", "* NEXT Deep task"]);

  assert.throws(() => moveSubtree(L, d, find(d, "Home"), { into: find(d, "Deep task"), at: "last" }));
  assert.deepEqual(moveUp(L, d, find(d, "Money")).lines, L);
  assert.deepEqual(moveDown(L, d, find(d, "Last thing")).lines, L);
});

test("the two cases from the Emacs design: a bare parent's lead, a closing separator", () => {
  // The blank after * A is A's lead, so reordering A's children keeps it after A.
  let d = parseOrg("* A\n\n** 1\n** 2\n** 3\n");
  assert.equal(text(moveDown(d.lines, d, find(d, "1")), d), "* A\n\n** 2\n** 1\n** 3\n");
  assert.equal(text(moveUp(d.lines, d, find(d, "3")), d), "* A\n\n** 1\n** 3\n** 2\n");
  // The blank before ** 2 closes the level-3 block; it is a gap of the seam and stays put when y moves.
  d = parseOrg("* S\n** 1\n*** x\n*** y\n\n** 2\n");
  assert.equal(text(moveUp(d.lines, d, find(d, "y")), d), "* S\n** 1\n*** y\n*** x\n\n** 2\n");
  assert.equal(text(deleteSubtree(d.lines, d, find(d, "y")), d), "* S\n** 1\n*** x\n\n** 2\n");
});

test("a bare parent: a first child takes no blank; losing its only child, the gap is resolved", () => {
  let d = parseOrg("* P\n\n* Q\n");
  assert.equal(text(insertHeading(d.lines, d, find(d, "P"), "firstChild", { title: "X" }), d), "* P\n** X\n\n* Q\n");
  d = parseOrg("* P\n** X\n\n\n* Q\n");
  assert.equal(text(deleteSubtree(d.lines, d, find(d, "X")), d), "* P\n\n* Q\n", "the l1 rule");
  assert.equal(text(deleteSubtree(d.lines, d, find(d, "X"), { rule: COUNTED_EMPTY }), d), "* P\n\n\n* Q\n", "keep: the longer run");
});

test("blank lines that hold spaces stay, inside a body and in every untouched run", () => {
  const d = parseOrg("* A\nx\n  \ny\n\t\n* B\n  \n* C\n");
  const r = moveSubtree(d.lines, d, find(d, "A"), { after: find(d, "C") });
  assert.equal(text(r, d), "* B\n  \n* C\n\n* A\nx\n  \ny\n");
  const back = parseOrg(text(r, d));
  // Moving C up ends the B→C seam that held "  ": B→A and C→B are new seams, resolved by the rule.
  assert.equal(text(moveUp(back.lines, back, find(back, "C")), back), "* C\n\n* B\n\n* A\nx\n  \ny\n");
});

test("the end of the file: no final newline, trailing blank lines", () => {
  let d = parseOrg("* A\n\n* B");
  assert.equal(text(moveUp(d.lines, d, find(d, "B")), d), "* B\n\n* A");
  d = parseOrg("* A\n* B\n\n");
  assert.equal(text(moveUp(d.lines, d, find(d, "B")), d), "* B\n\n* A\n\n");
  d = parseOrg("#+TITLE: Empty\n\n");
  assert.equal(text(insertHeading(d.lines, d, null, "end", { level: 1, title: "First" }), d), "#+TITLE: Empty\n\n* First\n");
  assert.equal(text(insertHeading([], parseOrg(""), null, "end", { level: 1, title: "Only" }), { finalNewline: true }), "* Only\n");
});

test("the edge memory puts a moved heading back exactly", () => {
  const raw = "#+TITLE: T\n\n* A\nbody\n\n** a1\n** a2\n\n* B\n** b1\n";
  const d = parseOrg(raw);
  const once = moveSubtree(d.lines, d, find(d, "a2"), { into: find(d, "B"), at: "last" });
  assert.equal(text(once, d), "#+TITLE: T\n\n* A\nbody\n\n** a1\n\n* B\n** b1\n** a2\n");
  const d1 = parseOrg(text(once, d));
  const plain = moveSubtree(d1.lines, d1, find(d1, "a2"), { after: find(d1, "a1") });
  const remembered = moveSubtree(d1.lines, d1, find(d1, "a2"), { after: find(d1, "a1") }, { memory: edgeMemory(d) });
  assert.equal(text(remembered, d), raw);
  assert.equal(text(plain, d), raw, "here the rule agrees");
  // A bare parent whose only child left gets its lead back from the memory.
  const p = parseOrg("* P\n\n** X\n* Q\n");
  const away = moveSubtree(p.lines, p, find(p, "X"), { fileEnd: true, level: 2 });
  const p1 = parseOrg(text(away, p));
  const home = moveSubtree(p1.lines, p1, find(p1, "X"), { into: find(p1, "P"), at: "first" }, { memory: edgeMemory(p) });
  assert.equal(text(home, p), "* P\n\n** X\n* Q\n");
});

test("promote and demote change only the subtree's stars", () => {
  const d = doc();
  const mayb = find(d, "Send the old licence");
  const r = promote(d.lines, mayb);
  assert.equal(r.lines[mayb.line], "* MAYB Send the old licence");
  assert.equal(r.lines[mayb.line + 2], "** NEXT Deep task");
  assertOnlyChanged(d.lines, r.lines, mayb.line, 3, [r.lines[mayb.line], d.lines[mayb.line + 1], "** NEXT Deep task"]);
  assert.equal(demote(d.lines, mayb).lines[mayb.line + 2], "**** NEXT Deep task");
  assert.throws(() => promote(d.lines, find(d, "Money")));
});

test("move to another file: out of one, into the other", () => {
  const a = doc();
  const b = parseOrg("#+TITLE: Other\n\n* Inbox\n** TODO Existing\n");
  const mayb = find(a, "Send the old licence");
  const out = extractSubtree(a.lines, a, mayb);
  assertOnlyChanged(a.lines, out.lines, mayb.line, 3, []);
  assert.deepEqual(out.chunk, a.lines.slice(17, 20));
  const into = insertSubtree(b.lines, b, out.chunk, out.level, { into: find(b, "Inbox"), at: "last" });
  assert.deepEqual(into.lines.slice(-3), ["** MAYB Send the old licence", "SCHEDULED: <2027-08-02 Mon +1w> Read [[obsidian:Plan]] first", "*** NEXT Deep task"]);
  const top = insertSubtree(b.lines, b, out.chunk, out.level, { fileEnd: true, level: 1 });
  assert.equal(top.lines[top.at], "* MAYB Send the old licence");
  assert.equal(top.lines[top.at - 1], "", "a level-1 heading after its sibling's subtree");
  assert.throws(() => insertSubtree(b.lines, b, ["not a heading"], 1, { fileEnd: true, level: 1 }));
});

test("a heading is found again after the file changed", () => {
  const d = doc();
  const key = headingKey(d, find(d, "Call the GP"));
  const changed = parseOrg("* New top\n\n" + RAW);
  assert.equal(findHeading(changed, key).line, find(d, "Call the GP").line + 2);
  assert.equal(findHeading(parseOrg(RAW.replace("Call the GP", "Call the dentist")), key), null);
});
