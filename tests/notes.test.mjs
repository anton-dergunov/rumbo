// Obsidian notes (app/notes.js, real-app.md §6): the name index kept on the device, refreshed when
// the Obsidian repo's head moves, and notes and images fetched by SHA. Against the fake GitHub
// (two repos, as on the device) and a store on fake-indexeddb.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createFakeGitHub, routeFakes, readFolder } from "./fake-github.mjs";
import { createRemote } from "../app/remote-github.js";
import { openStore } from "../app/store.js";
import { createNotes, noteIndex, obsidianUrl, imageType } from "../app/notes.js";
import { needsIdb, freshIdb } from "./idb.mjs";

const SAMPLE = fileURLToPath(new URL("./sample-notes", import.meta.url));

async function setup() {
  const vault = createFakeGitHub();
  const obsidian = createFakeGitHub({ repo: "obsidian" });
  obsidian.push(await readFolder(SAMPLE), "vault backup");
  const fetch = routeFakes(vault, obsidian);
  const remote = createRemote({ owner: "me", repo: "obsidian", token: "t", fetch });
  const store = openStore({ indexedDB: freshIdb() });
  let clock = 0;
  const notes = createNotes({ store, remote, repo: "me/obsidian", now: () => clock });
  return { obsidian, remote, store, notes, tick: (ms) => (clock += ms) };
}

const treeCalls = (gh) => gh.calls.filter((c) => c.includes("/git/trees/")).length;

test("noteIndex: names and files by lower-case name, dot folders left out", () => {
  const idx = noteIndex([
    { path: "20 Career/Career strategy.md", type: "blob", sha: "a" },
    { path: "Other/career strategy.md", type: "blob", sha: "b" },
    { path: ".obsidian/Hidden.md", type: "blob", sha: "c" },
    { path: "90 Meta/Images/Diagram.SVG", type: "blob", sha: "d" },
    { path: "20 Career", type: "tree", sha: "e" },
  ]);
  assert.deepEqual(idx.notes, { "career strategy": { name: "Career strategy", path: "20 Career/Career strategy.md", sha: "a" } });
  assert.deepEqual(idx.files, { "diagram.svg": { path: "90 Meta/Images/Diagram.SVG", sha: "d" } });
});

test("obsidianUrl and imageType", () => {
  assert.equal(obsidianUrl("", "Career strategy"), "obsidian://open?vault=obsidian&file=Career%20strategy");
  assert.equal(obsidianUrl("My vault", "A & B"), "obsidian://open?vault=My%20vault&file=A%20%26%20B");
  assert.equal(imageType("x/diagram.svg"), "image/svg+xml");
  assert.equal(imageType("a.JPG"), "image/jpeg");
  assert.equal(imageType("a.base"), "application/octet-stream");
});

test("a note by name, any case, with lookups for its links and embeds", needsIdb, async () => {
  const { notes } = await setup();
  const n = await notes.load("career STRATEGY");
  assert.equal(n.status, "ok");
  assert.equal(n.name, "Career strategy");
  assert.equal(n.path, "20 Career/Career strategy.md");
  assert.match(n.text, /^---\naliases/);
  assert.equal(n.note("ai systems"), "AI Systems");
  assert.equal(n.note("Hidden"), null);
  assert.equal(n.file("diagram.svg"), "90 Meta/Images/diagram.svg");
  assert.equal(n.file("nowhere.png"), null);
});

test("a name the vault doesn't have is missing", needsIdb, async () => {
  const { notes } = await setup();
  assert.deepEqual(await notes.load("Missing note"), { status: "missing", name: "Missing note" });
});

test("no notes repo set in Setup", needsIdb, async () => {
  const notes = createNotes({ store: openStore({ indexedDB: freshIdb() }), remote: null, repo: "" });
  assert.equal((await notes.load("Anything")).status, "unset");
});

test("the index is kept on the device; an unchanged head costs a 304 and no tree", needsIdb, async () => {
  const { obsidian, store, notes, tick } = await setup();
  await notes.load("AI Systems");
  assert.equal(treeCalls(obsidian), 1);
  const kept = await store.getNotesIndex();
  assert.equal(kept.repo, "me/obsidian");
  assert.equal(kept.head, obsidian.head());
  assert.ok(kept.notes["ai systems"]);

  // Within a minute, no request at all for the index.
  const before = obsidian.requests();
  await notes.load("Project Ideas");
  assert.equal(obsidian.calls.slice(before).filter((c) => c.includes("/git/ref/")).length, 0);

  // A new session on the same device: the stored index, checked with its ETag.
  tick(61_000);
  const again = createNotes({ store, remote: createRemote({ owner: "me", repo: "obsidian", token: "t", fetch: obsidian.fetch }), repo: "me/obsidian" });
  const limit = obsidian.rateLimit();
  assert.equal((await again.load("Architecture Notes")).status, "ok");
  assert.equal(treeCalls(obsidian), 1);
  // The 304 is free; the one request counted is the note's blob.
  assert.equal(limit - obsidian.rateLimit(), 1);
});

test("a moved head refreshes the index", needsIdb, async () => {
  const { obsidian, notes, tick } = await setup();
  await notes.load("AI Systems");
  obsidian.push({ "10 Knowledge/New note.md": "\nFresh.\n" }, "vault backup");
  assert.equal((await notes.load("New note")).status, "missing", "checked within the minute: not seen yet");
  tick(61_000);
  const n = await notes.load("New note");
  assert.equal(n.status, "ok");
  assert.equal(n.text, "\nFresh.\n");
  assert.equal(treeCalls(obsidian), 2);
});

test("offline: with no index, and with a stored one", needsIdb, async () => {
  const { obsidian, store, notes, tick } = await setup();
  obsidian.fail({ network: true, times: 1 });
  assert.equal((await notes.load("AI Systems")).status, "offline");

  await notes.load("AI Systems");
  tick(61_000);
  obsidian.fail({ network: true, times: 10 });
  // The index still says the note exists; its text needs GitHub.
  assert.deepEqual(await notes.load("Project Ideas"), { status: "offline", name: "Project Ideas" });
  // A name the stored index lacks may be a new note: offline, not missing.
  assert.equal((await notes.load("Not yet indexed")).status, "offline");
  // A note already read this session is still shown.
  assert.equal((await notes.load("AI Systems")).status, "ok");
  assert.ok(await store.getNotesIndex());
});

test("an index kept for another repo is not used", needsIdb, async () => {
  const { store, remote, obsidian } = await setup();
  await store.setNotesIndex({ repo: "someone/else", head: "x", etag: "y", notes: { "ai systems": { name: "AI Systems", path: "p", sha: "s" } }, files: {} });
  const notes = createNotes({ store, remote, repo: "me/obsidian" });
  assert.equal((await notes.load("AI Systems")).path, "10 Knowledge/Systems/AI Systems.md");
  assert.equal((await store.getNotesIndex()).repo, "me/obsidian");
  assert.equal(treeCalls(obsidian), 1);
});

test("a token the notes repo refuses, or a repo that isn't there, is an error with a reason", needsIdb, async () => {
  const { obsidian, notes } = await setup();
  obsidian.fail({ status: 404 });
  const r = await notes.load("AI Systems");
  assert.equal(r.status, "error");
  assert.match(r.message, /notes repo/);
});

test("an embedded image as an object URL of the right type, fetched once", needsIdb, async () => {
  const { obsidian, notes } = await setup();
  const made = [];
  const real = URL.createObjectURL;
  URL.createObjectURL = (blob) => (made.push(blob), `blob:fake/${made.length}`);
  try {
    await notes.load("AI Systems");
    const url = await notes.image("90 Meta/Images/diagram.svg");
    assert.equal(url, "blob:fake/1");
    assert.equal(made[0].type, "image/svg+xml");
    assert.match(await made[0].text(), /^<svg /);
    const blobs = obsidian.calls.filter((c) => c.includes("/git/blobs/")).length;
    assert.equal(await notes.image("90 Meta/Images/diagram.svg"), "blob:fake/1");
    assert.equal(obsidian.calls.filter((c) => c.includes("/git/blobs/")).length, blobs);
    assert.equal(await notes.image("nowhere.png"), null);
  } finally {
    URL.createObjectURL = real;
  }
});
