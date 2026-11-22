// Sync scenarios (docs/plans/real-app.md §3 "Edge cases" and §8 "Sync scenarios"): local commits,
// the push, a lost answer, an interrupted sync, Emacs pushing between any two requests, and a
// second device; the rebase (replay, the 3-way merge, a conflict) and the ways out (the rescue
// branch, keep GitHub's, keep mine, reset, the zip).

import { test } from "node:test";
import assert from "node:assert/strict";
import { needsIdb } from "./idb.mjs";
import { github, replica, edit, editTwo, undo, sync, settle, restart, killAt, rumboCommits, converged, textOf, parse } from "./scenarios.mjs";
import { makeOp, targetArg } from "../app/ops.js";
import { createEngine, SyncError, syncOnce } from "../app/sync.js";
import { keepTheirs, keepMine, rescueAndStop, pushRescue, buildZip } from "../app/rescue.js";
import { unzipSync, strFromU8 } from "../app/vendor/fflate.js";

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
async function interrupted(n, { processed = false, emacs = false, same = false } = {}) {
  const gh = github(FILES);
  const r = await replica(gh);
  await edit(r, "Inbox.org", done("Book dentist"));
  await edit(r, "Errands.org", done("Buy stamps"));
  if (emacs) gh.push({ "Work/Plan.org": "* DONE Write report\n" });
  // The Mac changes a file edited here too, so the sync rebases.
  if (same) gh.push({ "Inbox.org": FILES["Inbox.org"] + "* TODO From the Mac\n" });
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

for (const [emacs, same] of [[false, false], [true, false], [true, true]]) {
  const what = same ? " that rebases, then pushes" : emacs ? " that pulls, then pushes" : "";
  test(`killed at every request of a sync${what}, then restarted: no edit lost or doubled`, needsIdb, async () => {
    const clean = await interrupted(0, { emacs, same });
    const total = clean.requests;
    assert.ok(total >= 8, `a full sync takes ${total} requests`);
    const want = clean.gh.filesAt(clean.gh.head());
    if (same) assert.match(want["Inbox.org"], /DONE Book dentist[\s\S]*From the Mac/);
    for (let n = 1; n <= total; n++) {
      for (const processed of [false, true]) {
        const { gh, r } = await interrupted(n, { processed, emacs, same });
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

test("Emacs changes the same file elsewhere: the commit is replayed on GitHub's text, and both land", needsIdb, async () => {
  const gh = github(FILES);
  const r = await replica(gh);
  await edit(r, "Inbox.org", done("Book dentist"));
  const theirs = gh.push({ "Inbox.org": FILES["Inbox.org"] + "* TODO From the Mac\n" });
  await settle(r);
  const [c] = rumboCommits(gh);
  assert.deepEqual(c.parents, [theirs]);
  assert.equal(gh.filesAt(gh.head())["Inbox.org"], FILES["Inbox.org"].replace("TODO Book", "DONE Book") + "* TODO From the Mac\n");
  assert.ok((await converged(r)).ok);
  const pull = (await r.store.readLog()).find((e) => e.kind === "pull" && e.rebased);
  assert.equal(pull.replayed, 1);
});

test("Emacs changes the same file between the commit and the ref update: the refused push rebases and lands", needsIdb, async () => {
  const gh = github(FILES);
  const r = await replica(gh);
  await edit(r, "Inbox.org", done("Book dentist"));
  gh.beforeRequest = (n, method) => {
    if (method === "PATCH") {
      gh.beforeRequest = null;
      gh.push({ "Inbox.org": FILES["Inbox.org"] + "* TODO From the Mac\n" });
    }
  };
  await settle(r);
  assert.equal(rumboCommits(gh).length, 1);
  assert.match(gh.filesAt(gh.head())["Inbox.org"], /DONE Book dentist[\s\S]*From the Mac/);
  assert.ok(gh.log().every((x) => x.parents.length <= 1));
  assert.ok((await converged(r)).ok);
});

test("an undo pushed later (no ops to replay) goes through the 3-way merge", needsIdb, async () => {
  const gh = github(FILES);
  const r = await replica(gh);
  const e = await edit(r, "Inbox.org", done("Book dentist"));
  await settle(r);
  await undo(r, e);
  gh.push({ "Inbox.org": gh.filesAt(gh.head())["Inbox.org"] + "* TODO From the Mac\n" });
  await settle(r);
  assert.equal(gh.filesAt(gh.head())["Inbox.org"], FILES["Inbox.org"] + "* TODO From the Mac\n");
  assert.equal((await r.store.readLog()).find((x) => x.kind === "pull" && x.rebased).merged, 1);
  assert.ok((await converged(r)).ok);
});

/** A real conflict: the same title renamed here and on the Mac, plus an edit here to another file. */
async function conflicted() {
  const gh = github(FILES);
  const r = await replica(gh);
  await edit(r, "Inbox.org", (d) => makeOp(d, "setTitle", byTitle(d, "Book dentist"), { title: "Book the dentist" }));
  await edit(r, "Errands.org", done("Buy stamps"));
  const theirs = FILES["Inbox.org"].replace("Book dentist", "Book a dentist");
  const head = gh.push({ "Inbox.org": theirs });
  await assert.rejects(sync(r), (e) => e instanceof SyncError && e.kind === "conflict" && e.detail === "Inbox.org");
  assert.equal(gh.head(), head, "main is untouched");
  assert.equal(rumboCommits(gh).length, 0);
  const meta = await r.store.getMeta();
  assert.deepEqual(meta.conflict.files.map((f) => [f.path, f.reason, f.theirs]), [["Inbox.org", "both", theirs]]);
  assert.match(await textOf(r, "Inbox.org"), /Book the dentist/, "the edit is kept here");
  return { gh, r, theirs, mine: await textOf(r, "Inbox.org") };
}

test("a conflict, then Keep GitHub's: mine goes to a rescue branch, GitHub's stays, the other file's edit lands", needsIdb, async () => {
  const { gh, r, theirs, mine } = await conflicted();
  const { branch, sha } = await keepTheirs({ remote: r.remote, store: r.store, path: "Inbox.org", now: new Date(2026, 10, 22, 14, 5) });
  assert.equal(branch, "rumbo/rescue-2026-11-22-1405");
  assert.equal(gh.ref(branch), sha);
  assert.equal(gh.filesAt(sha)["Inbox.org"], mine);
  assert.match(gh.filesAt(sha)["Errands.org"], /DONE Buy stamps/);
  assert.equal((await r.store.getMeta()).conflict, undefined);
  await settle(r);
  const head = gh.filesAt(gh.head());
  assert.equal(head["Inbox.org"], theirs);
  assert.match(head["Errands.org"], /DONE Buy stamps/);
  assert.ok((await converged(r)).ok);
  // A second rescue the same minute gets its own name.
  await edit(r, "Inbox.org", done("Call the bank"));
  assert.equal((await pushRescue({ remote: r.remote, store: r.store, now: new Date(2026, 10, 22, 14, 5) })).branch, `${branch}-2`);
});

test("a conflict, then Keep mine: a new commit on GitHub's head writes this device's text", needsIdb, async () => {
  const { gh, r, theirs, mine } = await conflicted();
  await keepMine({ store: r.store, path: "Inbox.org" });
  await settle(r);
  const head = gh.filesAt(gh.head());
  assert.equal(head["Inbox.org"], mine);
  assert.match(head["Errands.org"], /DONE Buy stamps/);
  const msgs = rumboCommits(gh).map((c) => c.message);
  assert.deepEqual(msgs, ['Rumbo: Done "Buy stamps" (iPad)', "Rumbo: Keep this device's Inbox (iPad)"]);
  assert.ok(gh.log().some((c) => gh.filesAt(c.sha)["Inbox.org"] === theirs), "GitHub's text stays in the history");
  assert.ok((await converged(r)).ok);
});

test("a conflict, then Rescue and stop: everything goes to a branch, and the device takes GitHub's branch", needsIdb, async () => {
  const { gh, r, theirs, mine } = await conflicted();
  const { branch } = await rescueAndStop({ remote: r.remote, store: r.store });
  assert.equal(gh.filesAt(gh.ref(branch))["Inbox.org"], mine);
  assert.deepEqual(await r.store.pending(), []);
  await settle(r);
  assert.equal(rumboCommits(gh).length, 0, "main got nothing");
  assert.equal(await textOf(r, "Inbox.org"), theirs);
  assert.ok((await converged(r)).ok);
});

test("a file deleted on GitHub while edited here: a conflict; Keep mine writes it again", needsIdb, async () => {
  const gh = github(FILES);
  const r = await replica(gh);
  await edit(r, "Work/Plan.org", done("Write report"));
  gh.push({ "Work/Plan.org": null });
  await assert.rejects(sync(r), (e) => e.kind === "conflict");
  assert.equal((await r.store.getMeta()).conflict.files[0].reason, "gone");
  await keepMine({ store: r.store, path: "Work/Plan.org" });
  await settle(r);
  assert.equal(gh.filesAt(gh.head())["Work/Plan.org"], "* DONE Write report\n");
  assert.ok((await converged(r)).ok);
});

test("the zip holds the working files, one patch per local commit, and the state without the token", needsIdb, async () => {
  const gh = github(FILES);
  const r = await replica(gh);
  await edit(r, "Inbox.org", done("Book dentist"));
  await edit(r, "Errands.org", done("Buy stamps"));
  const { name, bytes } = await buildZip({ store: r.store, now: new Date(2026, 10, 22, 9, 30) });
  assert.equal(name, "rumbo-2026-11-22-0930.zip");
  const z = unzipSync(bytes);
  const files = Object.keys(z).filter((k) => k.startsWith("files/")).sort();
  assert.deepEqual(files, Object.keys(FILES).map((p) => `files/${p}`).sort());
  for (const f of await r.store.allFiles()) assert.equal(strFromU8(z[`files/${f.path}`]), f.work ?? f.text);
  const patches = Object.keys(z).filter((k) => k.startsWith("patches/")).sort();
  assert.deepEqual(patches, ["patches/0001-Done-Book-dentist-iPad.patch", "patches/0002-Done-Buy-stamps-iPad.patch"]);
  const p1 = strFromU8(z[patches[0]]);
  assert.match(p1, /^Subject: \[PATCH 1\/2\] Rumbo: Done "Book dentist" \(iPad\)$/m);
  assert.match(p1, /^-\* TODO Book dentist$/m);
  assert.match(p1, /^\+\* DONE Book dentist$/m);
  const state = JSON.parse(strFromU8(z["state.json"]));
  assert.equal(state.pending.length, 2);
  assert.equal(state.meta.token, undefined);
  assert.ok(!strFromU8(bytes).includes('"token"'));
});

test("Reset to GitHub with commits waiting is refused, and allowed once they are rescued", needsIdb, async () => {
  const gh = github(FILES);
  const r = await replica(gh);
  await edit(r, "Inbox.org", done("Book dentist"));
  await assert.rejects(r.store.resetReplica(), /Local commits are waiting/);
  await pushRescue({ remote: r.remote, store: r.store });
  await r.store.resetReplica({ force: true });
  await settle(r);
  assert.equal(await textOf(r, "Inbox.org"), FILES["Inbox.org"]);
  assert.ok((await converged(r)).ok);
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
