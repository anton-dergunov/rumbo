// The ways out (docs/plans/real-app.md §4): push the local commits to a rescue branch, download
// everything as a zip, and the three answers to a conflict. Nothing here ever moves `main`.
//
//   rumbo/rescue-<yyyy-mm-dd>-<hhmm>   the pending commits, one GitHub commit each, on their real
//                                      parent, for merging in Magit on the Mac
//   rumbo-<yyyy-mm-dd>-<hhmm>.zip      files/ (the working text of every file), patches/ (one per
//                                      pending commit, for `git am`), state.json (the replica's
//                                      state, without the token)

import { zipSync, strToU8 } from "./vendor/fflate.js";
import { RemoteError } from "./remote-github.js";
import { unifiedDiff, withoutPath } from "./merge.js";
import { fileLabel } from "./commits.js";

const pad = (n, w = 2) => String(n).padStart(w, "0");
/** `2026-11-22-1405` in the device's time. */
export const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;

/**
 * Push the pending commits to a new branch, on their real parent. Returns {branch, sha, commits}.
 * A name already taken gets -2, -3… `main` and `pending` are untouched.
 */
export async function pushRescue({ remote, store, now = new Date() }) {
  const pending = await store.pending();
  if (!pending.length) throw new Error("There are no local commits to push to a branch.");
  let parent = pending[0].base || (await store.getMeta()).base;
  let tree = (await remote.commit(parent)).tree;
  for (const p of pending) {
    const files = Object.fromEntries(Object.entries(p.files).map(([path, f]) => [path, f.after]));
    const c = await remote.makeCommit(parent, tree, files, p.message);
    parent = c.sha;
    tree = c.tree;
  }
  const name = `rumbo/rescue-${stamp(now)}`;
  for (let i = 1; ; i++) {
    const branch = i === 1 ? name : `${name}-${i}`;
    try {
      await remote.createBranch(branch, parent);
      await store.log({ kind: "rescue", branch, sha: parent, commits: pending.length });
      return { branch, sha: parent, commits: pending.length };
    } catch (e) {
      // 422: the name is taken.
      if (!(e instanceof RemoteError && e.kind === "rejected") || i >= 20) throw e;
    }
  }
}

// ---------------------------------------------------------------- the zip

const slug = (s) =>
  String(s)
    .replace(/^Rumbo: /, "")
    .replace(/[^\w]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50) || "commit";

/** One local commit as a patch `git am` takes. */
export function formatPatch(c, i, n) {
  const date = new Date(c.updated || c.created || Date.now()).toUTCString().replace("GMT", "+0000");
  const diffs = Object.entries(c.files)
    .map(([path, f]) => unifiedDiff(path, f.before ?? null, f.after ?? null))
    .join("");
  return `From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001\nFrom: Rumbo <rumbo@localhost>\nDate: ${date}\nSubject: [PATCH ${i}/${n}] ${c.message}\n\n---\n${diffs}--\nRumbo\n`;
}

/** Everything on this device as a zip: {name, bytes}. The token is left out. */
export async function buildZip({ store, now = new Date() }) {
  const [meta, files, pending] = await Promise.all([store.getMeta(), store.allFiles(), store.pending()]);
  const entries = {};
  for (const f of files) entries[`files/${f.path}`] = strToU8(f.work ?? f.text);
  pending.forEach((c, i) => {
    entries[`patches/${pad(i + 1, 4)}-${slug(c.message)}.patch`] = strToU8(formatPatch(c, i + 1, pending.length));
  });
  const { token, etag, ...safe } = meta;
  const state = {
    app: "Rumbo",
    made: now.toISOString(),
    meta: safe,
    pending,
    files: files.map((f) => ({ path: f.path, sha: f.sha, readOnly: f.readOnly || null, edited: f.work != null })),
  };
  entries["state.json"] = strToU8(JSON.stringify(state, null, 2));
  return { name: `rumbo-${stamp(now)}.zip`, bytes: zipSync(entries, { level: 6 }) };
}

/** Hand the zip over: the share sheet (Mail, Files, AirDrop) where there is one, else a download. */
export async function shareOrDownload({ name, bytes }, { nav = globalThis.navigator, doc = globalThis.document } = {}) {
  const file = new File([bytes], name, { type: "application/zip" });
  if (nav?.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: name });
      return "shared";
    } catch (e) {
      if (e?.name === "AbortError") return "cancelled";
    }
  }
  const url = URL.createObjectURL(file);
  const a = doc.createElement("a");
  a.href = url;
  a.download = name;
  doc.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return "downloaded";
}

// ---------------------------------------------------------------- the conflict screen's answers

async function conflictFile(store, path) {
  const meta = await store.getMeta();
  const f = meta.conflict?.files?.find((x) => x.path === path);
  if (!f) throw new Error(`${path} is no longer in conflict.`);
  return { meta, f };
}

/**
 * Keep GitHub's text of `path`: the local commits go to a rescue branch first, then every local
 * commit loses its changes to the file. Returns the rescue {branch, sha}.
 */
export async function keepTheirs({ remote, store, path, now = new Date() }) {
  const { meta } = await conflictFile(store, path);
  const rescue = await pushRescue({ remote, store, now });
  const commits = withoutPath(await store.pending(), path, meta.device || "");
  await store.resolveConflict({ path, how: "github", commits });
  return rescue;
}

/**
 * Keep this device's text of `path`: the local commits lose their changes to the file, and one new
 * local commit on top writes this device's text over GitHub's.
 */
export async function keepMine({ store, path, now = Date.now() }) {
  const { meta, f } = await conflictFile(store, path);
  const rec = (await store.allFiles()).find((x) => x.path === path);
  const mine = rec ? (rec.work ?? rec.text) : f.mine;
  const commits = withoutPath(await store.pending(), path, meta.device || "");
  const same = mine === f.theirs;
  const message = `Rumbo: Keep this device's ${fileLabel(path)}${meta.device ? ` (${meta.device})` : ""}`;
  await store.resolveConflict({ path, how: same ? "github" : "mine", commits, theirs: f.theirs, mine, message, now });
}

/** Push everything to a rescue branch, then take GitHub's branch as it is: finish on the Mac. */
export async function rescueAndStop({ remote, store, now = new Date() }) {
  const rescue = await pushRescue({ remote, store, now });
  await store.resetReplica({ force: true });
  return rescue;
}
