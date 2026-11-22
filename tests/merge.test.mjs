// The rebase of local commits (app/merge.js): keep, replay, 3-way merge, conflict; and the diffs
// the Sync page, the conflict screen and the zip show.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rebasePending, replayCommit, mergeText, withoutPath, clashes, unifiedDiff } from "../app/merge.js";
import { makeOp, targetArg, applyOps } from "../app/ops.js";
import { parseOrg, OPEN_STATES } from "../app/org.js";
import { joinLines } from "../app/org-edit.js";
import { edgeMemory } from "../app/spacing.js";
import { editRecord } from "../app/commits.js";

const parse = (t) => parseOrg(t, { states: [...OPEN_STATES, "DONE"] });
const byTitle = (d, t) => d.headings.find((h) => h.title === t);
const done = (t) => (d) => makeOp(d, "setState", byTitle(d, t), { state: "DONE" });

let ids = 0;
/** A local commit as store.recordEdit would make it, from edits on `texts` ({path: text}). */
function commit(texts, edits) {
  const files = {};
  const ops = [];
  const parts = [];
  const ctx = {};
  const now = { ...texts };
  for (const e of edits) {
    const pathOps = [];
    let chunk;
    let level;
    for (const [path, build] of e) {
      const before = now[path];
      const doc = parse(before);
      const c = { rule: null, memory: edgeMemory(doc) };
      const op = { ...build(doc, chunk, level), path };
      const r = applyOps(doc.lines, doc, [op], c);
      if (op.op === "extractSubtree") ({ chunk, level } = r.results[0]);
      const after = joinLines(r.lines, doc.finalNewline || !doc.lines.length);
      const rec = editRecord({ id: "x", ops: [op], files: [{ path, before, after, doc, ctx: c }] });
      Object.assign(ctx, rec.ctx);
      files[path] = { before: files[path]?.before ?? before, after };
      now[path] = after;
      pathOps.push(op);
    }
    ops.push(...pathOps);
    parts.push({ edit: `e${ids}`, label: "", n: pathOps.length, opaque: false, summary: { verb: "Edit", text: "Edit" }, paths: e.map(([p]) => p) });
  }
  return { id: ++ids, ops, parts, files, ctx, message: "m", base: "b0", sealed: false, attempt: null };
}

const up = (texts) => (path) => (path in texts ? { text: texts[path], readOnly: texts[path].includes("\r") ? "cr" : null } : undefined);

const INBOX = "#+TITLE: Inbox\n\n* TODO Call the bank\n* TODO Book dentist\n\nAsk about Tuesday.\n\n* Later\n** TODO Paint the fence\n";

test("a commit whose files didn't change upstream is kept as it is", () => {
  const c = commit({ "Inbox.org": INBOX }, [[["Inbox.org", done("Book dentist")]]]);
  const r = rebasePending([c], up({ "Inbox.org": INBOX }), { onto: "h1" });
  assert.equal(r.ok, true);
  assert.equal(r.commits[0], c);
  assert.deepEqual(r.how[c.id], { "Inbox.org": "kept" });
});

test("replay lands after Emacs edits elsewhere in the same file", () => {
  const c = commit({ "Inbox.org": INBOX }, [[["Inbox.org", done("Book dentist")]]]);
  const theirs = INBOX.replace("** TODO Paint the fence\n", "** TODO Paint the fence\n** TODO From the Mac\n");
  const r = rebasePending([c], up({ "Inbox.org": theirs }), { onto: "h1" });
  assert.equal(r.ok, true);
  assert.equal(r.how[c.id]["Inbox.org"], "replayed");
  const f = r.commits[0].files["Inbox.org"];
  assert.equal(f.before, theirs);
  assert.equal(f.after, theirs.replace("TODO Book", "DONE Book"));
  assert.equal(r.commits[0].attempt, null);
  assert.deepEqual(r.commits[0].rebased.onto, "h1");
});

test("replay finds a heading the Mac moved, and repeats a move on the new text", () => {
  const c = commit({ "Inbox.org": INBOX }, [[["Inbox.org", (d) => makeOp(d, "moveDown", byTitle(d, "Call the bank"))]]]);
  // The Mac added notes to the task being moved.
  const theirs = INBOX.replace("* TODO Call the bank\n", "* TODO Call the bank\nAsk for the manager.\n");
  const r = rebasePending([c], up({ "Inbox.org": theirs }));
  assert.equal(r.ok, true);
  const after = r.commits[0].files["Inbox.org"].after;
  const doc = parse(after);
  assert.deepEqual(doc.headings.filter((h) => h.level === 1).map((h) => h.title), ["Book dentist", "Call the bank", "Later"]);
  assert.match(after, /\* TODO Call the bank\nAsk for the manager\.\n/);
});

test("a move across files carries what the Mac changed inside the moved section", () => {
  const ERR = "* Shops\n\n** TODO Buy stamps\n";
  const c = commit({ "Inbox.org": INBOX, "Errands.org": ERR }, [
    [
      ["Inbox.org", (d) => makeOp(d, "extractSubtree", byTitle(d, "Book dentist"))],
      ["Errands.org", (d, chunk, level) => makeOp(d, "insertSubtree", null, { chunk, fromLevel: level, target: targetArg(d, { into: byTitle(d, "Shops"), at: "last" }) })],
    ],
  ]);
  const theirs = INBOX.replace("Ask about Tuesday.", "Ask about Tuesday or Wednesday.");
  const r = rebasePending([c], up({ "Inbox.org": theirs, "Errands.org": ERR }));
  assert.equal(r.ok, true);
  const out = r.commits[0].files;
  assert.ok(!out["Inbox.org"].after.includes("Book dentist"));
  assert.match(out["Errands.org"].after, /\*\* TODO Book dentist\n\nAsk about Tuesday or Wednesday\./);
  assert.equal(r.how[c.id]["Errands.org"], "replayed");
});

test("replay fails (the heading's parent was renamed upstream) but the 3-way merge is clean", () => {
  const text = INBOX.replace("* Later\n", "* Later\nSome notes.\n");
  const c = commit({ "Inbox.org": text }, [[["Inbox.org", done("Paint the fence")]]]);
  const theirs = text.replace("* Later", "* Later on");
  const r = rebasePending([c], up({ "Inbox.org": theirs }));
  assert.equal(r.ok, true);
  assert.equal(r.how[c.id]["Inbox.org"], "merged");
  assert.equal(r.commits[0].files["Inbox.org"].after, theirs.replace("TODO Paint", "DONE Paint"));
});

test("both fail: a conflict, with base, mine and theirs", () => {
  const c = commit({ "Inbox.org": INBOX }, [[["Inbox.org", (d) => makeOp(d, "setTitle", byTitle(d, "Book dentist"), { title: "Book the dentist" })]]]);
  const theirs = INBOX.replace("Book dentist", "Book a dentist");
  const r = rebasePending([c], up({ "Inbox.org": theirs }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.conflicts.map((x) => [x.path, x.reason]), [["Inbox.org", "both"]]);
  assert.equal(r.conflicts[0].base, INBOX);
  assert.equal(r.conflicts[0].theirs, theirs);
  assert.match(r.conflicts[0].mine, /Book the dentist/);
});

test("a file deleted upstream, or with CR line endings now, is a conflict", () => {
  const c = commit({ "Inbox.org": INBOX }, [[["Inbox.org", done("Book dentist")]]]);
  assert.deepEqual(rebasePending([c], up({})).conflicts.map((x) => [x.reason, x.theirs]), [["gone", null]]);
  assert.equal(rebasePending([c], up({ "Inbox.org": INBOX.replace(/\n/g, "\r\n") })).conflicts[0].reason, "readonly");
});

test("an opaque commit (an undo) goes straight to the merge", () => {
  const c = commit({ "Inbox.org": INBOX }, [[["Inbox.org", done("Book dentist")]]]);
  const opaque = { ...c, ops: [], parts: c.parts.map((p) => ({ ...p, opaque: true, n: 0 })) };
  const theirs = INBOX + "* TODO From the Mac\n";
  const r = rebasePending([opaque], up({ "Inbox.org": theirs }));
  assert.equal(r.how[opaque.id]["Inbox.org"], "merged");
  assert.equal(r.commits[0].files["Inbox.org"].after, theirs.replace("TODO Book", "DONE Book"));
});

test("a chain of two commits on one file: the second rebases onto the first one's result", () => {
  const c1 = commit({ "Inbox.org": INBOX }, [[["Inbox.org", done("Book dentist")]]]);
  const c2 = commit({ "Inbox.org": c1.files["Inbox.org"].after }, [[["Inbox.org", done("Call the bank")]]]);
  const theirs = INBOX + "* TODO From the Mac\n";
  const r = rebasePending([c1, c2], up({ "Inbox.org": theirs }));
  assert.equal(r.ok, true);
  assert.equal(r.commits[1].files["Inbox.org"].before, r.commits[0].files["Inbox.org"].after);
  assert.equal(r.commits[1].files["Inbox.org"].after, theirs.replace("TODO Book", "DONE Book").replace("TODO Call", "DONE Call"));
});

test("a commit upstream already made is dropped; a kept commit after a rebased one moves along", () => {
  const c1 = commit({ "Inbox.org": INBOX }, [[["Inbox.org", done("Book dentist")]]]);
  const r = rebasePending([c1], up({ "Inbox.org": INBOX.replace("TODO Book", "DONE Book") }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.commits, []);
  assert.deepEqual(r.dropped, [c1.id]);
});

test("the merge never gains conflict markers or invented headings", () => {
  assert.equal(mergeText("a\nb\nc\nd\n", "a\nB\nc\nd\n", "a\nb\nc\nD\n"), "a\nB\nc\nD\n");
  // Changes on adjacent lines clash, as in git.
  assert.equal(mergeText("a\nb\nc\n", "a\nB\nc\n", "a\nb\nC\n"), null);
  assert.equal(mergeText("a\nb\n", "a\nB\n", "a\nX\n"), null);
  // A marker line in mine only is allowed where it already was; a clean merge can't add one.
  assert.equal(mergeText("a\n\n=======\n\nb\n", "a\n\n=======\n\nB\n", "A\n\n=======\n\nb\n"), "A\n\n=======\n\nB\n");
  // A heading line that neither side has is refused, even from a clean merge.
  assert.equal(mergeText("x\n", "x\n* New\n", "x\n"), "x\n* New\n");
});

test("replayCommit refuses a file that is gone", () => {
  const c = commit({ "Inbox.org": INBOX }, [[["Inbox.org", done("Book dentist")]]]);
  assert.throws(() => replayCommit(c, {}), /gone/);
});

test("withoutPath drops a file from every commit; a commit left with nothing goes; half a move turns opaque", () => {
  const ERR = "* Shops\n\n** TODO Buy stamps\n";
  const c1 = commit({ "Inbox.org": INBOX }, [[["Inbox.org", done("Book dentist")]]]);
  const c2 = commit({ "Inbox.org": c1.files["Inbox.org"].after, "Errands.org": ERR }, [
    [["Errands.org", done("Buy stamps")]],
    [
      ["Inbox.org", (d) => makeOp(d, "extractSubtree", byTitle(d, "Call the bank"))],
      ["Errands.org", (d, chunk, level) => makeOp(d, "insertSubtree", null, { chunk, fromLevel: level, target: targetArg(d, { into: byTitle(d, "Shops"), at: "last" }) })],
    ],
  ]);
  const out = withoutPath([c1, c2], "Inbox.org", "iPad");
  assert.deepEqual(out.map((c) => c.id), [c2.id]);
  assert.deepEqual(Object.keys(out[0].files), ["Errands.org"]);
  assert.deepEqual(out[0].parts.map((p) => [p.n, p.opaque]), [[1, false], [0, true]]);
  assert.deepEqual(out[0].ops.map((o) => o.op), ["setState"]);
});

test("clashes show mine against GitHub's with context", () => {
  const base = "a\nb\nc\nd\ne\n";
  const [x] = clashes(base, "a\nb\nMINE\nd\ne\n", "a\nb\nTHEIRS\nd\ne\n");
  assert.deepEqual(x, { before: ["a", "b"], mine: ["MINE"], theirs: ["THEIRS"], after: ["d", "e"], line: 3 });
  assert.deepEqual(clashes(base, "x", null), []);
});

test("unifiedDiff writes a git-style patch", () => {
  const before = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n";
  const after = "1\n2\n3\nFOUR\n5\n6\n7\n8\n9\n10\nELEVEN";
  assert.equal(
    unifiedDiff("a.org", before, after),
    [
      "diff --git a/a.org b/a.org",
      "--- a/a.org",
      "+++ b/a.org",
      "@@ -1,10 +1,11 @@",
      " 1", " 2", " 3", "-4", "+FOUR", " 5", " 6", " 7", " 8", " 9", " 10", "+ELEVEN",
      "\\ No newline at end of file",
      "",
    ].join("\n"),
  );
  assert.equal(unifiedDiff("n.org", null, "x\n"), "diff --git a/n.org b/n.org\nnew file mode 100644\n--- /dev/null\n+++ b/n.org\n@@ -0,0 +1,1 @@\n+x\n");
  assert.equal(unifiedDiff("s.org", "x\n", "x\n"), "");
});
