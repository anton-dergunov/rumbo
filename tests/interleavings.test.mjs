// Seeded random interleavings (docs/plans/real-app.md §8): two Rumbo replicas (the iPad and the
// phone) and Emacs on the Mac edit and sync in a random order, with failures injected now and
// then; a conflict is answered with a random way out. After each run:
//   - all replicas converge to `main`, and history is a line;
//   - no commit on `main` holds a conflict marker;
//   - each local commit reached `main` at most once;
//   - every unique title still meant to exist is on `main`, or, only after a way out dropped it,
//     on a rescue branch or in main's history.
//
// RUMBO_SEEDS=n runs n seeds (default 40); a failure names its seed. RUMBO_SEED=k runs just seed k.

import { test } from "node:test";
import assert from "node:assert/strict";
import { needsIdb } from "./idb.mjs";
import { github, replica, edit, editTwo, undo, sync, settle, restart, rumboCommits, converged, textOf, parse } from "./scenarios.mjs";
import { makeOp, targetArg, keyOf } from "../app/ops.js";
import { SyncError } from "../app/sync.js";
import { keepTheirs, keepMine, rescueAndStop } from "../app/rescue.js";
import { StoreError } from "../app/store.js";

const FILES = {
  "Inbox.org": "#+TITLE: Inbox\n\n* TODO Call the bank\n* TODO Book dentist\n\nAsk about Tuesday.\n\n* Later\n\n** TODO Paint the fence\n** MAYB Learn the cello\n",
  "Errands.org": "* Shops\n\n** TODO Buy stamps\n** TODO Return parcel\n\n* Garden\n\nThe hedge needs a trim.\n\n** TODO Rake leaves\n",
  "Work/Plan.org": "* NEXT Write report\n\nDue Friday.\n\n* Projects\n\n** TODO Draft budget\n** WAIT Hear from Sam\n",
  "workspace.org": "#+TITLE: ws\n",
};
const ORG = ["Inbox.org", "Errands.org", "Work/Plan.org"];
const STATES = ["TODO", "NEXT", "INPR", "WAIT", "MAYB", "DONE"];
const MARKER = /^(<{7}|={7}|>{7})/m;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function run(seed, steps = 40) {
  const rand = mulberry32(seed);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const gh = github(FILES);
  const devices = [await replica(gh, { device: "iPad" }), await replica(gh, { device: "Phone" })];
  for (const r of devices) r.history = [];
  const live = new Set();
  let n = 0;
  let wayOut = false;
  const trace = [];

  const tryEdit = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      // A heading that isn't there any more, or an op the text doesn't allow: skipped, as the app would refuse it.
      if (e.name === "OpError") return null;
      throw e;
    }
  };

  async function rumboStep(r) {
    const path = pick(ORG);
    const text = await textOf(r, path);
    // After "Rescue and stop" the device has no files until its next pull.
    if (text == null) return;
    const doc = parse(text);
    const hs = doc.headings;
    if (!hs.length) return;
    const kind = pick(["add", "add", "state", "move", "move", "across", "undo"]);
    trace.push(`${r.device} ${kind} ${path}`);
    if (kind === "add") {
      const title = `R-${r.device}-${++n}`;
      const ref = pick(hs.filter((h) => h.level === 1));
      const rec = await tryEdit(() => edit(r, path, (d) => makeOp(d, "insertHeading", null, { ref: keyOf(d, d.headings.find((h) => h.line === ref.line)), where: pick(["lastChild", "after"]), fields: { state: "TODO", title } }), { gap: pick([500, 10_000]) }));
      if (rec) {
        live.add(title);
        r.history.push({ rec, add: title });
      }
    } else if (kind === "state") {
      const hd = pick(hs);
      const rec = await tryEdit(() => edit(r, path, (d) => makeOp(d, "setState", d.headings.find((h) => h.line === hd.line), { state: pick(STATES) }), { gap: pick([500, 10_000]) }));
      if (rec) r.history.push({ rec });
    } else if (kind === "move") {
      const hd = pick(hs);
      const rec = await tryEdit(() => edit(r, path, (d) => makeOp(d, pick(["moveUp", "moveDown"]), d.headings.find((h) => h.line === hd.line)), { gap: pick([500, 10_000]) }));
      if (rec) r.history.push({ rec });
    } else if (kind === "across") {
      const own = hs.filter((h) => /^R-/.test(h.title) && !h.children?.length);
      if (!own.length) return;
      const hd = pick(own);
      const dst = pick(ORG.filter((p) => p !== path));
      const rec = await tryEdit(() =>
        editTwo(
          r,
          path,
          dst,
          (d) => makeOp(d, "extractSubtree", d.headings.find((h) => h.line === hd.line)),
          (d, chunk, level) => makeOp(d, "insertSubtree", null, { chunk, fromLevel: level, target: targetArg(d, { into: pick(d.headings.filter((h) => h.level === 1)), at: "last" }) }),
        ),
      );
      if (rec) r.history.push({ rec });
    } else if (kind === "undo") {
      const last = r.history.pop();
      if (!last) return;
      try {
        await undo(r, last.rec);
        if (last.add) live.delete(last.add);
      } catch (e) {
        // The file changed since (a rebase): the app says "Can't undo" too.
        if (!(e instanceof StoreError && e.code === "stale")) throw e;
        r.history.length = 0;
      }
    }
  }

  function emacsStep() {
    const path = pick(ORG);
    const text = gh.filesAt(gh.head())[path];
    const lines = text.split("\n");
    const heads = lines.map((l, i) => [l, i]).filter(([l]) => /^\*+ /.test(l));
    const kind = pick(["append", "note", "note", "rename", "state"]);
    trace.push(`Emacs ${kind} ${path}`);
    if (kind === "append") {
      const title = `E-${++n}`;
      gh.push({ [path]: `${text}${text.endsWith("\n") ? "" : "\n"}* TODO ${title}\n` });
      live.add(title);
    } else if (kind === "note") {
      const [, i] = pick(heads);
      const token = `E-${++n}`;
      lines.splice(i + 1, 0, `note ${token}`);
      gh.push({ [path]: lines.join("\n") });
      live.add(token);
    } else if (kind === "rename") {
      // Only headings from the first version, so the unique titles stay findable.
      const orig = heads.filter(([l]) => !/[RE]-\d|R-\w+-\d/.test(l));
      if (!orig.length) return;
      const [l, i] = pick(orig);
      lines[i] = `${l} (Mac)`;
      gh.push({ [path]: lines.join("\n") });
    } else {
      const [l, i] = pick(heads);
      lines[i] = l.replace(/^(\*+) (TODO|NEXT|WAIT|MAYB|INPR|DONE) /, "$1 NEXT ");
      gh.push({ [path]: lines.join("\n") });
    }
  }

  async function answer(r, e) {
    const meta = await r.store.getMeta();
    const path = meta.conflict.files[0].path;
    const how = pick(["theirs", "mine", "stop"]);
    trace.push(`${r.device} conflict on ${meta.conflict.files.map((f) => f.path)}: ${how}`);
    wayOut = true;
    r.history.length = 0;
    if (how === "theirs") await keepTheirs({ remote: r.remote, store: r.store, path, now: new Date(2026, 10, 22, 10, n++ % 60) });
    else if (how === "mine") await keepMine({ store: r.store, path });
    else await rescueAndStop({ remote: r.remote, store: r.store, now: new Date(2026, 10, 22, 11, n++ % 60) });
  }

  async function syncStep(r, final = false) {
    if (!final && rand() < 0.15) {
      const k = pick(["lost", "502", "network"]);
      trace.push(`${r.device} sync, ${k}`);
      if (k === "lost") gh.fail({ match: (p, init) => init.method === "PATCH", after: true });
      else if (k === "502") gh.fail({ match: () => rand() < 0.5, status: 502 });
      else gh.fail({ match: () => true, network: true });
    } else trace.push(`${r.device} sync`);
    try {
      await (final ? settle(r) : sync(r));
    } catch (e) {
      if (e instanceof SyncError && e.kind === "conflict") return answer(r, e);
      if (["offline", "server", "rejected"].includes(e.kind)) return;
      throw e;
    } finally {
      gh.clearFailures?.();
    }
  }

  for (let i = 0; i < steps; i++) {
    const x = rand();
    const r = pick(devices);
    if (x < 0.4) await rumboStep(r);
    else if (x < 0.6) emacsStep();
    else if (x < 0.95) await syncStep(r);
    else {
      trace.push(`${r.device} restart`);
      restart(r);
    }
  }

  // Quiet: no more Emacs; each device syncs until nothing is left, answering conflicts with Keep mine.
  for (let round = 0; round < 4; round++) {
    for (const r of devices) {
      for (let k = 0; k < 4; k++) {
        try {
          await settle(r);
          break;
        } catch (e) {
          if (!(e instanceof SyncError && e.kind === "conflict")) throw e;
          trace.push(`${r.device} final conflict: mine`);
          wayOut = true;
          await keepMine({ store: r.store, path: (await r.store.getMeta()).conflict.files[0].path });
        }
      }
    }
  }
  return { gh, devices, live, wayOut, trace };
}

const count = Number(process.env.RUMBO_SEEDS) || 40;
const seeds = process.env.RUMBO_SEED ? [Number(process.env.RUMBO_SEED)] : Array.from({ length: count }, (_, i) => i + 1);

test(`random interleavings of two devices and Emacs (${seeds.length} seeds)`, needsIdb, async () => {
  let conflicts = 0;
  for (const seed of seeds) {
    const { gh, devices, live, wayOut, trace } = await run(seed);
    const where = `seed ${seed}:\n  ${trace.join("\n  ")}`;
    if (wayOut) conflicts += 1;
    if (process.env.RUMBO_DEBUG) console.log(`seed ${seed}: ${rumboCommits(gh).length} Rumbo commits, ${gh.log().length} in all, ${live.size} titles, way out: ${wayOut}\n  ${trace.join("\n  ")}`);
    for (const r of devices) {
      const c = await converged(r);
      assert.ok(c.ok, `${where}\n${r.device} did not converge: ${JSON.stringify(c)}`);
    }
    const log = gh.log();
    assert.ok(log.every((c) => c.parents.length <= 1), `${where}\nhistory is not a line`);
    for (const c of log) for (const [p, t] of Object.entries(gh.filesAt(c.sha))) assert.ok(!MARKER.test(t), `${where}\n${c.sha.slice(0, 7)} has conflict markers in ${p}`);

    // Each local commit reached main at most once: one push in some device's log per Rumbo commit.
    const pushes = [];
    for (const r of devices) for (const e of await r.store.readLog()) if (e.kind === "push") pushes.push(e.sha);
    const rumbo = rumboCommits(gh).map((c) => c.sha);
    assert.equal(new Set(pushes).size, pushes.length, `${where}\na commit was counted as pushed twice`);
    assert.deepEqual([...pushes].sort(), [...rumbo].sort(), `${where}\npushes and Rumbo commits on main differ`);

    // Every title still meant to exist is on main, or a way out dropped it (then it is kept elsewhere).
    const head = Object.values(gh.filesAt(gh.head())).join("\n");
    const elsewhere = () => {
      const all = [];
      for (const c of log) all.push(...Object.values(gh.filesAt(c.sha)));
      for (const [name, sha] of gh.branches?.() || []) if (name.startsWith("rumbo/rescue-")) all.push(...Object.values(gh.filesAt(sha)));
      return all.join("\n");
    };
    for (const t of live) {
      const re = new RegExp(`\\b${t}\\b`);
      if (re.test(head)) continue;
      assert.ok(wayOut, `${where}\n${t} is missing from main and no way out was taken`);
      assert.ok(re.test(elsewhere()), `${where}\n${t} is lost: not on main, not on a rescue branch, not in history`);
    }
  }
  // The seeds must reach the conflict screen sometimes, or this test checks less than it says.
  if (seeds.length >= 40) assert.ok(conflicts > 0, "no seed reached a conflict");
});
