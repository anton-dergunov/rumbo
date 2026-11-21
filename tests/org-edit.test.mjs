import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseOrg } from "../prototype/org.js";
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
  chain,
} from "../prototype/org-edit.js";

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

test("insert: after, first and last child, end of file; spacing copied", () => {
  const d = doc();
  const check = find(d, "Check receipts");
  let r = insertHeading(d.lines, check, "after", { state: "TODO", title: "New one" });
  assertOnlyChanged(d.lines, r.lines, check.end, 0, ["** TODO New one"]);
  assert.equal(r.at, check.end);

  const gp = find(d, "Call the GP");
  r = insertHeading(d.lines, gp, "after", { state: "TODO", title: "After GP", tags: ["easy"], scheduled: { date: "2027-01-12" }, body: "note\n" });
  // GP's subtree ends with a blank line, so the new entry ends with one too.
  assertOnlyChanged(d.lines, r.lines, gp.end, 0, ["** TODO After GP :easy:", "SCHEDULED: <2027-01-12 Tue>", "note", ""]);

  const home = find(d, "Home");
  r = insertHeading(d.lines, home, "firstChild", { state: "NEXT", title: "First" });
  assertOnlyChanged(d.lines, r.lines, home.bodyEnd, 0, ["** NEXT First", ""]);
  r = insertHeading(d.lines, home, "lastChild", { state: "TODO", title: "Final" });
  // At the end of the file the last entry has no blank after it, but the sibling before is spaced out.
  assertOnlyChanged(d.lines, r.lines, home.end, 0, ["", "** TODO Final"]);
  assert.equal(r.at, home.end + 1);

  const money = find(d, "Money");
  r = insertHeading(d.lines, money, "after", { title: "Work" });
  assertOnlyChanged(d.lines, r.lines, money.end, 0, ["* Work", ""]);

  r = insertHeading(d.lines, null, "end", { level: 1, title: "Tail" });
  // Top-level sections here are spaced out, so the new one is too.
  assertOnlyChanged(d.lines, r.lines, d.lines.length, 0, ["", "* Tail"]);
  assert.equal(joinLines(r.lines, d.finalNewline).endsWith("* Tail"), true);
});

test("delete: whole subtree; the spacing around stays as it was", () => {
  const d = doc();
  const check = find(d, "Check receipts");
  let r = deleteSubtree(d.lines, check);
  assertOnlyChanged(d.lines, r.lines, check.line, 1, []);
  // GP sits between blank lines: it goes with the blank after it, and one blank still separates.
  const gp = find(d, "Call the GP");
  r = deleteSubtree(d.lines, gp);
  assertOnlyChanged(d.lines, r.lines, gp.line, 3, []);
  assert.deepEqual(r.lines.slice(gp.line - 1, gp.line + 1), ["", "* Home"]);
  // The line before "Fixed the tap" is not blank: the blank after its subtree is the separator, so it stays.
  const tap = find(d, "Fixed the tap");
  r = deleteSubtree(d.lines, tap);
  assertOnlyChanged(d.lines, r.lines, tap.line, 2, []);
  assert.equal(r.lines[tap.line], "");
  const mayb = find(d, "Send the old licence");
  r = deleteSubtree(d.lines, mayb);
  assertOnlyChanged(d.lines, r.lines, mayb.line, 3, []);
  // The last entry of the file: the blank line before it goes too, so nothing dangles at the end.
  const last = find(d, "Last thing");
  r = deleteSubtree(d.lines, last);
  assertOnlyChanged(d.lines, r.lines, last.line - 1, 2, []);
  assert.equal(r.map(last.line), -1);
  assert.equal(r.map(0), 0);
});

test("remove done: outermost DONE subtrees, in one edit", () => {
  const d = doc();
  const r = removeDone(d.lines, d, find(d, "Home"));
  assert.equal(r.removed, 1);
  const tap = find(d, "Fixed the tap");
  assertOnlyChanged(d.lines, r.lines, tap.line, 2, []);
  assert.equal(removeDone(d.lines, d, find(d, "Money")).removed, 0);
});

test("move: up, down, into a section, out; only stars change in the moved lines", () => {
  const d = doc();
  const gp = find(d, "Call the GP");
  let r = moveUp(d.lines, d, gp);
  const nd = parseOrg(joinLines(r.lines, d.finalNewline));
  assert.deepEqual(find(nd, "Money").children.map((x) => x.title), ["Check receipts", "Call the GP", "Cashback from the energy supplier"]);
  assert.equal(r.map(gp.line), find(nd, "Call the GP").line);
  // A move only reorders lines. Blank lines may differ by the spacing of the old and new places.
  assert.deepEqual(nonBlank(r.lines), nonBlank(d.lines));

  const check = find(d, "Check receipts");
  r = moveDown(d.lines, d, check);
  const nd2 = parseOrg(joinLines(r.lines, d.finalNewline));
  assert.deepEqual(find(nd2, "Money").children.map((x) => x.title), ["Cashback from the energy supplier", "Check receipts", "Call the GP"]);
  assert.deepEqual(nonBlank(r.lines), nonBlank(d.lines));

  const mayb = find(d, "Send the old licence");
  r = moveSubtree(d.lines, mayb, { into: find(d, "Money"), at: "first" });
  const nd3 = parseOrg(joinLines(r.lines, d.finalNewline));
  assert.deepEqual(find(nd3, "Money").children.map((x) => x.title), ["Send the old licence", "Check receipts", "Cashback from the energy supplier", "Call the GP"]);
  assert.equal(find(nd3, "Deep task").level, 3);
  assert.equal(r.lines[r.map(mayb.planningLine)], d.lines[mayb.planningLine], "planning line moved untouched");

  r = moveSubtree(d.lines, mayb, { into: find(d, "Money"), at: "last" });
  const nd4 = parseOrg(joinLines(r.lines, d.finalNewline));
  assert.deepEqual(find(nd4, "Money").children.map((x) => x.title).at(-1), "Send the old licence");

  r = moveSubtree(d.lines, find(d, "Deep task"), { after: find(d, "Home") });
  const nd5 = parseOrg(joinLines(r.lines, d.finalNewline));
  assert.equal(find(nd5, "Deep task").level, 1);

  assert.throws(() => moveSubtree(d.lines, find(d, "Home"), { into: find(d, "Deep task"), at: "last" }));
  assert.deepEqual(moveUp(d.lines, d, find(d, "Money")).lines, d.lines);
  assert.deepEqual(moveDown(d.lines, d, find(d, "Last thing")).lines, d.lines);
});

test("move with blank-line separators keeps the file's spacing", () => {
  const text = "* S\n\n** a\n\n** b\n\n** c\n";
  const d = parseOrg(text);
  const up = moveUp(d.lines, d, find(d, "c"));
  assert.equal(joinLines(up.lines, d.finalNewline), "* S\n\n** a\n\n** c\n\n** b\n");
  const down = moveDown(d.lines, d, find(d, "a"));
  assert.equal(joinLines(down.lines, d.finalNewline), "* S\n\n** b\n\n** a\n\n** c\n");
  const tight = parseOrg("* S\n** a\n** b\n** c\n");
  assert.equal(joinLines(moveDown(tight.lines, tight, find(tight, "a")).lines, true), "* S\n** b\n** a\n** c\n");
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
  const out = extractSubtree(a.lines, mayb);
  assertOnlyChanged(a.lines, out.lines, mayb.line, 3, []);
  const into = insertSubtree(b.lines, out.chunk, out.level, { into: find(b, "Inbox"), at: "last" });
  assert.deepEqual(into.lines.slice(-3), ["** MAYB Send the old licence", "SCHEDULED: <2027-08-02 Mon +1w> Read [[obsidian:Plan]] first", "*** NEXT Deep task"]);
  const top = insertSubtree(b.lines, out.chunk, out.level, { fileEnd: true, level: 1 });
  assert.equal(top.lines[top.at], "* MAYB Send the old licence");
});

test("a heading is found again after the file changed", () => {
  const d = doc();
  const key = headingKey(d, find(d, "Call the GP"));
  const changed = parseOrg("* New top\n\n" + RAW);
  assert.equal(findHeading(changed, key).line, find(d, "Call the GP").line + 2);
  assert.equal(findHeading(parseOrg(RAW.replace("Call the GP", "Call the dentist")), key), null);
});

test("every sample-vault file: an edit leaves every other line byte-identical", () => {
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
  for (const p of files) {
    const text = readFileSync(p, "utf8");
    const d = parseOrg(text);
    assert.equal(joinLines(d.lines, d.finalNewline), text, `${p} round-trips`);
    for (const hd of d.headings) {
      if (!hd.state) continue;
      const r = setState(d.lines, hd, hd.state === "NEXT" ? "TODO" : "NEXT");
      assertOnlyChanged(d.lines, r.lines, hd.line, 1, [r.lines[hd.line]]);
      const back = setState(r.lines, parseOrg(joinLines(r.lines)).headings.find((x) => x.line === hd.line), hd.state);
      assert.deepEqual(back.lines, d.lines, `${p}: state change and back is a no-op`);
      const del = deleteSubtree(d.lines, hd);
      assert.ok(del.lines.length < d.lines.length);
    }
  }
});

test("chain: heading, planning and body in one edit", () => {
  const d = doc();
  const gp = find(d, "Call the GP");
  const r = chain(d.lines, gp, [
    (l, h) => setHeading(l, h, { state: "NEXT", tags: ["phone"] }),
    (l, h) => setPlanning(l, h, { deadline: { date: "2027-01-15" } }),
    (l, h) => setBody(l, h, "- first point\n- second"),
  ]);
  assertOnlyChanged(d.lines, r.lines, gp.line, 2, ["** NEXT [#A] Call the GP :phone:", "DEADLINE: <2027-01-15 Fri>", "- first point", "- second"]);
  assert.equal(r.at, gp.line);
  assert.equal(r.map(gp.line + 3), gp.line + 5, "* Home after the edit");
  assert.equal(r.map(gp.line + 1), -1);
});
