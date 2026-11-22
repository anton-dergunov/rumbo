// Sync scenarios (docs/plans/real-app.md §3 "Edge cases" and §8 "Sync scenarios"): local commits,
// the push, a lost answer, an interrupted sync, Emacs pushing between any two requests, and a
// second device. Rebase beyond its first step (replay, the 3-way merge) is plan step 4b.

import { test } from "node:test";
import assert from "node:assert/strict";
import { needsIdb } from "./idb.mjs";
import { github, replica, edit, editTwo, undo, sync, settle, restart, killAt, rumboCommits, converged, textOf, parse } from "./scenarios.mjs";
import { makeOp, targetArg } from "../app/ops.js";
import { createEngine, SyncError, syncOnce } from "../app/sync.js";

const FILES = {
  "Inbox.org": "#+TITLE: Inbox\n\n* TODO Call the bank\n* TODO Book dentist\n\nAsk about Tuesday.\n",
  "Errands.org": "* Shops\n\n** TODO Buy stamps\n** TODO Return parcel\n",
  "Work/Plan.org": "* NEXT Write report\n",
  "workspace.org": "#+TITLE: ws\n",
};

const byTitle = (doc, title) => doc.headings.find((h) => h.title === title);
const done = (title) => (d) => makeOp(d, "setState", byTitle(d, title), { state: "DONE" });
const tick = () => new Promise((r) => setImmediate(r));

test("an edit becomes one commit on main: its parent, its message, its exact bytes", needsIdb, async () => {
  const gh = github(FILES);
  const r = await replica(gh);
  const first = gh.head();
  await edit(r, "Inbox.org", done("Book dentist"));
  assert.equal((await r.store.pending()).length, 1);
  const res = await sync(r);
  assert.equal(res.pushed, 1);
  const [c] = rumboCommits(gh);
  assert.equal(gh.head(), c.sha);
  assert.deepEqual(c.parents, [first]);
  assert.equal(c.message, 'Rumbo: Done "Book dentist" (iPad)');
  assert.equal(gh.filesAt(c.sha)["Inbox.org"], FILES["Inbox.org"].replace("TODO Book", "DONE Book"));
  assert.equal(gh.filesAt(c.sha)["Errands.org"], FILES["Errands.org"]);
  assert.deepEqual(await converged(r), { ok: true, pending: 0, mismatch: [], base: c.sha });
  assert.equal((await r.store.getMeta()).baseCommit.sha, c.sha);
  // Nothing left: the next pass costs one free 304... after one 200 for the new head.
  await settle(r);
  assert.equal(rumboCommits(gh).length, 1);
});

test("edits under 3 s apart are one commit; 3 s later is a second", needsIdb, async () => {
  const gh = github(FILES);
  const r = await replica(gh);
  await edit(r, "Inbox.org", done("Call the bank"));
  await edit(r, "Inbox.org", done("Book dentist"), { gap: 1000 });
  await edit(r, "Errands.org", (d) => makeOp(d, "moveDown", byTitle(d, "Buy stamps")), { gap: 2500 });
  await edit(r, "Errands.org", done("Buy stamps"), { gap: 3000 });
  await settle(r);
  const commits = rumboCommits(gh);
  assert.deepEqual(
    commits.map((c) => c.message),
    ["Rumbo: 3 edits in Inbox, Errands (iPad)", 'Rumbo: Done "Buy stamps" (iPad)'],
  );
  assert.ok((await converged(r)).ok);
});

test("a move across files is one commit touching both", needsIdb, async () => {
  const gh = github(FILES);
  const r = await replica(gh);
  await editTwo(
    r,
    "Inbox.org",
    "Errands.org",
    (d) => makeOp(d, "extractSubtree", byTitle(d, "Call the bank")),
    (d, chunk, level) => makeOp(d, "insertSubtree", null, { chunk, fromLevel: level, target: targetArg(d, { into: byTitle(d, "Shops"), at: "last" }) }),
  );
  await settle(r);
  const [c] = rumboCommits(gh);
  assert.equal(c.message, 'Rumbo: Move "Call the bank" to Errands (iPad)');
  const files = gh.filesAt(c.sha);
  assert.ok(!files["Inbox.org"].includes("Call the bank"));
  assert.ok(files["Errands.org"].includes("** TODO Call the bank"));
  assert.ok((await converged(r)).ok);
});

test("undo before a push leaves nothing to push; after a push it is a new commit with the old bytes", needsIdb, async () => {
  const gh = github(FILES);
  const r = await replica(gh);
  const first = gh.head();
  const e1 = await edit(r, "Inbox.org", done("Book dentist"));
  await undo(r, e1);
  assert.deepEqual(await r.store.pending(), []);
  await settle(r);
  assert.equal(gh.head(), first);

  const e2 = await edit(r, "Inbox.org", done("Call the bank"));
  await settle(r);
  await undo(r, e2);
  await settle(r);
  const commits = rumboCommits(gh);
  assert.deepEqual(commits.map((c) => c.message), ['Rumbo: Done "Call the bank" (iPad)', 'Rumbo: Undo: Done "Call the bank" (iPad)']);
  assert.equal(gh.filesAt(gh.head())["Inbox.org"], FILES["Inbox.org"]);
  assert.ok((await converged(r)).ok);
});

// --------------------------------------------------------------------- lost answers and failures

const isRefUpdate = (path, init) => init.method === "PATCH";

test("the ref update's answer is lost: the next sync counts it as pushed, with no second commit", needsIdb, async () => {
  const gh = github(FILES);
  const r = await replica(gh);
  await edit(r, "Inbox.org", done("Book dentist"));
  gh.fail({ match: isRefUpdate, after: true });
  await assert.rejects(sync(r), (e) => e.kind === "offline");
  const [c] = rumboCommits(gh);
  assert.equal(gh.head(), c.sha, "the ref did move");
  assert.equal((await r.store.pending())[0].attempt.sha, c.sha);
  const res = await sync(r);
  assert.equal(res.pushed, 1);
  assert.equal(rumboCommits(gh).length, 1);
  assert.ok((await converged(r)).ok);
  assert.equal((await r.store.readLog()).filter((e) => e.kind === "push").at(-1).lost, true);
});

test("the answer is lost and Emacs has already pushed on top: still counted once, then Emacs's change is pulled", needsIdb, async () => {
  const gh = github(FILES);
  const r = await replica(gh);
  await edit(r, "Inbox.org", done("Book dentist"));
  await edit(r, "Errands.org", done("Buy stamps"));
  gh.fail({ match: isRefUpdate, after: true });
  await assert.rejects(sync(r));
  gh.push({ "Work/Plan.org": "* DONE Write report\n" });
  await settle(r);
  assert.equal(rumboCommits(gh).length, 2);
  assert.ok((await converged(r)).ok);
  assert.equal(await textOf(r, "Work/Plan.org"), "* DONE Write report\n");
});

test("blobs and a tree are made but the ref update fails: the retry pushes once", needsIdb, async () => {
  const gh = github(FILES);
  const r = await replica(gh);
  await edit(r, "Inbox.org", done("Book dentist"));
  gh.fail({ match: isRefUpdate, status: 502 });
  await assert.rejects(sync(r), (e) => e.kind === "server");
  assert.equal(rumboCommits(gh).length, 0);
  await settle(r);
  assert.equal(rumboCommits(gh).length, 1);
  assert.ok((await converged(r)).ok);
});

test("a revoked token stops with auth; the commits wait and go after a manual sync", needsIdb, async () => {
  const gh = github(FILES);
  const r = await replica(gh);
  await edit(r, "Inbox.org", done("Book dentist"));
  gh.fail({ match: (p) => p.endsWith("/git/blobs"), status: 401 });
  const engine = createEngine({ run: () => syncOnce({ remote: r.remote, store: r.store }), online: () => true, setTimer: () => 0, clearTimer: () => {} });
  await engine.sync("start");
  assert.equal(engine.status().stoppedBy, "auth");
  assert.equal((await r.store.pending()).length, 1);
  await engine.sync("tick");
  assert.equal(rumboCommits(gh).length, 0);
  await engine.sync("manual");
  assert.equal(rumboCommits(gh).length, 1);
  assert.ok((await converged(r)).ok);
});

test("a force-push with commits waiting stops with diverged; nothing is wiped", needsIdb, async () => {
  const gh = github(FILES);
  const r = await replica(gh);
  await edit(r, "Inbox.org", done("Book dentist"));
  gh.forcePush({ "Other.org": "* new history\n" });
  await assert.rejects(sync(r), (e) => e instanceof SyncError && e.kind === "diverged");
  assert.equal((await r.store.pending()).length, 1);
  assert.match(await textOf(r, "Inbox.org"), /DONE Book dentist/);
  assert.equal(await textOf(r, "Errands.org"), FILES["Errands.org"]);
});

// --------------------------------------------------------------------------- interrupted syncs

/**
 * A scenario whose sync is killed at request `n` (or not, with n = 0): two local commits on two
 * files, and, with `emacs`, a commit from the Mac to a third file first, so the sync also pulls.
 */
async function interrupted(n, { processed = false, emacs = false } = {}) {
  const gh = github(FILES);
  const r = await replica(gh);
  await edit(r, "Inbox.org", done("Book dentist"));
  await edit(r, "Errands.org", done("Buy stamps"));
  if (emacs) gh.push({ "Work/Plan.org": "* DONE Write report\n" });
  const start = gh.requests();
  if (n) {
    const k = killAt(gh, n, { processed });
    restart(r, k.fetch);
    // The clean count includes settle's last check, so the killed run settles too.
    await Promise.race([k.hit, settle(r).catch(() => {})]);
    for (let i = 0; i < 5; i++) await tick();
    restart(r);
  }
  await settle(r);
  return { gh, r, requests: gh.requests() - start };
}

for (const emacs of [false, true]) {
  test(`killed at every request of a sync${emacs ? " that pulls, then pushes" : ""}, then restarted: no edit lost or doubled`, needsIdb, async () => {
    const clean = await interrupted(0, { emacs });
    const total = clean.requests;
    assert.ok(total >= 8, `a full sync takes ${total} requests`);
    const want = clean.gh.filesAt(clean.gh.head());
    for (let n = 1; n <= total; n++) {
      for (const processed of [false, true]) {
        const { gh, r } = await interrupted(n, { processed, emacs });
        const where = `killed at request ${n}${processed ? " after it was carried out" : ""}`;
        assert.equal(rumboCommits(gh).length, 2, `${where}: each edit once`);
        assert.deepEqual(gh.filesAt(gh.head()), want, where);
        const c = await converged(r);
        assert.ok(c.ok, `${where}: ${JSON.stringify(c)}`);
        assert.ok(gh.log().every((x) => x.parents.length <= 1), `${where}: history is a line`);
      }
    }
  });
}

// ------------------------------------------------------------------------------ other writers

test("Emacs pushes to another file before any request of a sync: everything lands, in a line", needsIdb, async () => {
  const clean = await interrupted(0);
  for (let k = 1; k <= clean.requests; k++) {
    const gh = github(FILES);
    const r = await replica(gh);
    await edit(r, "Inbox.org", done("Book dentist"));
    await edit(r, "Errands.org", done("Buy stamps"));
    const start = gh.requests();
    gh.beforeRequest = (n) => {
      if (n === start + k) gh.push({ "Work/Plan.org": "* DONE Write report\n" });
    };
    await settle(r);
    gh.beforeRequest = null;
    await settle(r);
    const where = `Emacs before request ${k}`;
    assert.equal(rumboCommits(gh).length, 2, where);
    const head = gh.filesAt(gh.head());
    assert.equal(head["Work/Plan.org"], "* DONE Write report\n", where);
    assert.match(head["Inbox.org"], /DONE Book dentist/, where);
    assert.match(head["Errands.org"], /DONE Buy stamps/, where);
    assert.ok(gh.log().every((x) => x.parents.length <= 1), where);
    assert.ok((await converged(r)).ok, where);
  }
});

test("Emacs changes the same file: the sync stops with conflict, the commit is kept, main is untouched", needsIdb, async () => {
  const gh = github(FILES);
  const r = await replica(gh);
  await edit(r, "Inbox.org", done("Book dentist"));
  const theirs = gh.push({ "Inbox.org": FILES["Inbox.org"] + "* TODO From the Mac\n" });
  await assert.rejects(sync(r), (e) => e instanceof SyncError && e.kind === "conflict" && e.detail === "Inbox.org");
  assert.equal(gh.head(), theirs);
  assert.equal(rumboCommits(gh).length, 0);
  assert.equal((await r.store.pending()).length, 1);
  assert.match(await textOf(r, "Inbox.org"), /DONE Book dentist/);
});

test("Emacs changes the same file between the commit and the ref update: conflict, nothing pushed", needsIdb, async () => {
  const gh = github(FILES);
  const r = await replica(gh);
  await edit(r, "Inbox.org", done("Book dentist"));
  gh.beforeRequest = (n, method) => {
    if (method === "PATCH") {
      gh.beforeRequest = null;
      gh.push({ "Inbox.org": FILES["Inbox.org"] + "* TODO From the Mac\n" });
    }
  };
  await assert.rejects(sync(r), (e) => e.kind === "conflict");
  assert.equal(rumboCommits(gh).length, 0);
  assert.equal((await r.store.pending()).length, 1);
});

test("two devices edit different files offline: the second to push lands on the first; both converge", needsIdb, async () => {
  const gh = github(FILES);
  const ipad = await replica(gh, { device: "iPad" });
  const phone = await replica(gh, { device: "Phone" });
  await edit(ipad, "Inbox.org", done("Book dentist"));
  await edit(phone, "Errands.org", done("Buy stamps"));
  await edit(phone, "Work/Plan.org", (d) => makeOp(d, "setState", byTitle(d, "Write report"), { state: "WAIT" }), { gap: 500 });
  await settle(ipad);
  await settle(phone);
  await settle(ipad);
  const commits = rumboCommits(gh);
  assert.deepEqual(commits.map((c) => c.message), ['Rumbo: Done "Book dentist" (iPad)', "Rumbo: 2 edits in Errands, Plan (Phone)"]);
  assert.deepEqual(commits[1].parents, [commits[0].sha]);
  assert.ok((await converged(ipad)).ok);
  assert.ok((await converged(phone)).ok);
  assert.equal(parse(await textOf(ipad, "Work/Plan.org")).headings[0].state, "WAIT");
});
