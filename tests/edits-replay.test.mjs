// edits.js when a pull rebased a file under a queued edit: the store refuses the edit as stale, so
// its ops run again on the stored text and that is stored. Runs edits.js in Node with the two
// browser globals state.js reads at load (location, history) stubbed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { needsIdb, freshIdb } from "./idb.mjs";

globalThis.location ??= { search: "", pathname: "/" };
globalThis.history ??= { state: null, pushState() {}, replaceState() {} };

const { openStore } = await import("../app/store.js");
const { buildModel } = await import("../app/data.js");
const E = await import("../app/edits.js");
const { makeOp } = await import("../app/ops.js");

const INBOX = "* TODO Call the bank\n* TODO Book dentist\n";
const rec = (path, text) => ({ path, sha: `sha-${path}`, text, work: null, readOnly: null });

test("an edit made on text a pull has since rebased runs again on the stored text", needsIdb, async () => {
  const store = openStore({ indexedDB: freshIdb() });
  await store.setMeta({ device: "iPad" });
  await store.applyPull({ meta: { base: "c1" }, put: [rec("Inbox.org", INBOX)] });
  const model = buildModel(await store.allFiles());
  E.setEditModel(model);
  E.setStore(store);
  let reloads = 0;
  const notices = [];
  E.onReload(() => reloads++);
  E.onNotice((n) => notices.push(n));

  // GitHub moved on, and the pull wrote the file while the page still shows the old text.
  const theirs = `${INBOX}* TODO From the Mac\n`;
  await store.applyPull({ meta: { base: "c2" }, put: [rec("Inbox.org", theirs)] });

  E.edit("Inbox.org", "Marked done", (d) => makeOp(d, "setState", d.headings.find((h) => h.title === "Book dentist"), { state: "DONE" }), { quiet: true });
  await E.settled();
  const [c] = await store.pending();
  assert.deepEqual(c.files["Inbox.org"], { before: theirs, after: theirs.replace("TODO Book", "DONE Book") });
  assert.equal(reloads, 1, "the page is rebuilt from the store");
  assert.deepEqual(notices.filter((n) => n.kind === "error"), []);
});
