import { test } from "node:test";
import assert from "node:assert/strict";
import { isIncluded, isSupportFile, isWanted } from "../app/vault-files.js";

test("agenda files follow the Emacs exclusions", () => {
  for (const p of ["Inbox.org", "Work/Career.org", "Admin/Deep/Nested.org", "Vision/2026.org"]) assert.ok(isIncluded(p), p);
  for (const p of [
    "init.org", // beorg's config
    "workspace.org",
    "Work/workspace.org", // excluded by name at any depth, as in Emacs
    "Journal/2026-07-13.org",
    "Work/Archive/Old.org",
    ".git/config.org",
    "Work/.hidden/Notes.org",
    "Plans (Someone's conflicted copy 2026-08-19).org",
    "README.md",
    "Inbox.org~",
    ".ps/task-icons.json",
  ]) assert.ok(!isIncluded(p), p);
});

test("names are matched exactly, not as substrings", () => {
  assert.ok(isIncluded("Journalling.org"));
  assert.ok(isIncluded("Archives/Plans.org"));
  assert.ok(isIncluded("my-init.org"));
});

test("support files are kept besides the agenda files", () => {
  assert.ok(isSupportFile("workspace.org"));
  assert.ok(isSupportFile(".ps/task-icons.json"));
  assert.ok(!isSupportFile(".ps/state.el"));
  assert.ok(isWanted("workspace.org") && isWanted("Inbox.org") && !isWanted("Journal/x.org"));
});
