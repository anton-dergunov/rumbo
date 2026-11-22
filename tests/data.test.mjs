// The app's model is built from the replica's records, with no network (docs/plans/real-app.md §9).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { buildModel, describePath, pathTag } from "../app/data.js";

const root = new URL("../prototype/sample-vault", import.meta.url).pathname;
const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
const records = walk(root).map((p) => ({ path: relative(root, p), sha: "x", text: readFileSync(p, "utf8"), work: null, readOnly: null }));

test("the sample vault's files, folders and agenda come out of the records alone", () => {
  const m = buildModel(records, { name: "sample" });
  const orgs = records.map((r) => r.path).filter((p) => p.endsWith(".org") && p !== "workspace.org" && p !== "init.org" && !/^(Journal|Archive)\//.test(p));
  assert.deepEqual(m.files.map((f) => f.path), [...orgs].sort());
  assert.ok(m.folders.length > 1);
  assert.ok(m.agenda.length > 0);
  // workspace.org was read: some file or folder icon came from it.
  assert.ok(m.files.some((f) => f.icon !== "draft") || m.folders.some((f) => f.icon !== "folder"));
  for (const f of m.files) for (const h of f.doc.headings) assert.equal(m.headingById.get(h.id).file, f);
});

test("heading ids depend on the file's path, not on which other files exist", () => {
  const all = buildModel(records);
  const fewer = buildModel(records.filter((r) => r.path !== all.files[0].path));
  const f = all.files.at(-1);
  assert.deepEqual(fewer.byPath.get(f.path).doc.headings.map((h) => h.id), f.doc.headings.map((h) => h.id));
  assert.notEqual(pathTag("a.org"), pathTag("b.org"));
});

test("a path gives the folder, base and display name", () => {
  assert.deepEqual(describePath("Work/Big_Plans.org"), { path: "Work/Big_Plans.org", folder: "Work", base: "Big_Plans", name: "Big Plans" });
  assert.deepEqual(describePath("Inbox.org").folder, "");
});

test("the working text wins over the base text, and the model is not writable yet", () => {
  const m = buildModel([{ path: "A.org", sha: "s", text: "* TODO old\n", work: "* TODO new\n", readOnly: null }]);
  assert.equal(m.files[0].doc.headings[0].title, "new");
  assert.equal(m.writable, false);
  assert.equal(buildModel([]).files.length, 0);
});
