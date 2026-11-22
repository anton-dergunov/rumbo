// Commit messages from ops, and the spacing context kept with a local commit (app/commits.js).

import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize, undoSummary, commitMessage, saveContext, restoreContext, foldContext, editRecord, fileLabel } from "../app/commits.js";
import { parseOrg } from "../app/org.js";
import { edgeMemory } from "../app/spacing.js";

const key = (title) => ({ path: [], title, nth: 0, count: 1 });
const op = (o, title, args = {}, path = "Inbox.org") => ({ path, op: o, key: title ? key(title) : null, args, v: 1 });

test("one op says what it did to which heading", () => {
  assert.equal(summarize([op("setState", "Book dentist", { state: "DONE" })]).text, 'Done "Book dentist"');
  assert.equal(summarize([op("setState", "X", { state: "INPR" })]).text, 'In progress "X"');
  assert.equal(summarize([op("moveDown", "X")]).text, 'Move "X"');
  assert.equal(summarize([op("deleteSubtree", "X")]).text, 'Delete "X"');
  assert.equal(summarize([op("insertHeading", null, { fields: { title: "New" } })]).text, 'Add "New"');
  assert.equal(summarize([op("removeDone", null, { scope: null }, "Home/Garden_plans.org")]).text, "Remove done tasks in Garden plans");
  assert.equal(summarize([op("setPriority", "X", { priority: "A" })]).text, 'Prioritise "X"');
});

test("the dialog's ops are one Edit, named by the new title; a move across files names the target", () => {
  const dialog = [op("setPlanning", "Old", { patch: {} }), op("setBody", "Old", { text: "" }), op("setHeading", "Old", { patch: { title: "New title" } })];
  assert.deepEqual(summarize(dialog), { verb: "Edit", text: 'Edit "New title"' });
  const move = [op("extractSubtree", "Buy stamps", {}, "Inbox.org"), op("insertSubtree", null, {}, "Errands.org")];
  assert.equal(summarize(move).text, 'Move "Buy stamps" to Errands');
});

test("long titles are cut", () => {
  const t = summarize([op("setState", "a".repeat(80), { state: "DONE" })]).text;
  assert.ok(t.length < 60);
  assert.ok(t.endsWith('…"'));
});

test("messages: one part says what it did; several say how many and where", () => {
  const part = (verb, text, paths = ["Inbox.org"]) => ({ summary: { verb, text }, paths });
  assert.equal(commitMessage([part("Done", 'Done "X"')], "iPad"), 'Rumbo: Done "X" (iPad)');
  assert.equal(commitMessage([part("Done", 'Done "X"')], ""), 'Rumbo: Done "X"');
  assert.equal(commitMessage([part("Move", "a"), part("Move", "b"), part("Move", "c")], "iPad"), "Rumbo: Move 3 headings in Inbox (iPad)");
  assert.equal(commitMessage([part("Move", "a"), part("Done", "b", ["Errands.org"])], "iPhone"), "Rumbo: 2 edits in Inbox, Errands (iPhone)");
  assert.equal(commitMessage([part("Undo", "a"), part("Undo", "b")], "iPad"), "Rumbo: 2 edits in Inbox (iPad)");
  assert.equal(undoSummary({ verb: "Done", text: 'Done "X"' }).text, 'Undo: Done "X"');
  assert.equal(fileLabel("Work/Big_plan.org"), "Big plan");
});

test("the saved context keeps only what the file's own memory doesn't say, and restores it whole", () => {
  const doc = parseOrg("* A\n\n* B\n* C\n");
  const later = parseOrg("* A\n* C\n\n\n* B\n");
  // The session memory: the file as loaded, then a state it was in later (newest wins).
  const memory = new Map([...edgeMemory(later), ...edgeMemory(doc)]);
  const saved = saveContext({ rule: { cells: {}, files: 1 }, memory }, doc);
  assert.ok(saved.memory.length > 0 && saved.memory.length < memory.size);
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), saved, "plain JSON");
  const back = restoreContext(saved, doc);
  assert.deepEqual(back.rule, { cells: {}, files: 1 });
  assert.deepEqual([...back.memory].sort(), [...memory].sort());
  const folded = foldContext(saved, { rule: null, memory: [["k", [""]]] });
  assert.equal(folded.memory.length, saved.memory.length + 1);
  assert.deepEqual(folded.rule, { cells: {}, files: 1 });
});

test("editRecord builds the stored edit from the ops and the files", () => {
  const doc = parseOrg("* TODO A\n");
  const ops = [op("setState", "A", { state: "DONE" })];
  const rec = editRecord({ id: "e1", label: "Marked done", ops, files: [{ path: "Inbox.org", before: "* TODO A\n", after: "* DONE A\n", doc, ctx: { rule: null, memory: edgeMemory(doc) } }] });
  assert.deepEqual(rec.files, [{ path: "Inbox.org", before: "* TODO A\n", after: "* DONE A\n" }]);
  assert.equal(rec.summary.text, 'Done "A"');
  assert.deepEqual(rec.ctx["Inbox.org"], { rule: null, memory: [] });
});
