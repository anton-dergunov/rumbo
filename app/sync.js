// Sync with the vault's repo on GitHub (docs/plans/real-app.md §3): the pull, the push of local
// commits, and the engine that runs them. Of the rebase, only its first step is here: GitHub moved
// on but changed none of the files the local commits touch, so they stay as they are on the new
// head. A file changed on both sides stops with `conflict` (replay and the 3-way merge are plan
// step 4b).

import { RemoteError } from "./remote-github.js";
import { StoreError } from "./store.js";
import { blobSha, bytesToText } from "./gitobj.js";
import { isWanted } from "./vault-files.js";

const BLOB_PARALLEL = 6;

/** A sync failure that isn't a single request's: `diverged` (the branch was rewritten). */
export class SyncError extends Error {
  constructor(kind, message, detail = "") {
    super(message);
    this.name = "SyncError";
    this.kind = kind;
    this.detail = detail;
  }
}

const DIVERGED = "GitHub's branch was rewritten (a force-push), so it no longer continues from this device's copy. Nothing was changed here.";
const CONFLICT = "A file edited here was also changed on GitHub. Merging the two comes in a later version of Rumbo; your edits are kept on this device.";
/** How many times one sync starts again after losing a race (a ref update refused, an edit meanwhile). */
const RETRIES = 3;

/** A pass lost a race with another writer and starts again. */
class Retry extends Error {}

/** Bytes → the record kept in the replica. A file that is not UTF-8, or has CRs, is shown but never edited. */
function fileRecord(path, sha, bytes) {
  let text;
  let readOnly = null;
  try {
    text = bytesToText(bytes);
  } catch {
    text = new TextDecoder("utf-8").decode(bytes);
    readOnly = "not-utf8";
  }
  if (!readOnly && text.includes("\r")) readOnly = "cr";
  return { path, sha, text, work: null, readOnly };
}

/** Run `fn` on each item, at most `n` at a time. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/**
 * One pull: head (with the ETag), then, if it moved and still descends from the base, the tree
 * and the blobs whose SHAs changed, all written in one transaction. Never wipes: a rewritten
 * branch stops with `diverged`. Returns `{ changed, paths }`, the paths that changed or went.
 */
export async function pull({ remote, store, onProgress = () => {} }) {
  const meta = await store.getMeta();
  const head = await remote.head(meta.etag || null);
  return pullTo({ remote, store, meta, head, pending: await store.pending(), onProgress });
}

/** The pull once the head is known. With local commits waiting, a file they touch must not have changed upstream. */
async function pullTo({ remote, store, meta, head, pending, onProgress = () => {} }) {
  const now = Date.now();
  if (!head.changed || head.sha === meta.base) {
    await store.setMeta({ lastCheck: now, lastError: null, ...(head.changed ? { etag: head.etag } : {}) });
    return { changed: false, paths: [] };
  }

  if (meta.base) {
    let status;
    try {
      status = (await remote.compare(meta.base, head.sha)).status;
    } catch (e) {
      // A base GitHub no longer knows was dropped by a force-push.
      if (e instanceof RemoteError && e.kind === "missing") status = "diverged";
      else throw e;
    }
    if (status !== "ahead" && status !== "identical") throw new SyncError("diverged", DIVERGED, `${meta.base.slice(0, 7)} → ${head.sha.slice(0, 7)}: ${status}`);
  }

  const tree = await remote.tree(head.sha);
  const wanted = tree.entries.filter((e) => e.type === "blob" && isWanted(e.path));
  const have = new Map((await store.allFiles()).map((f) => [f.path, f]));
  const changed = wanted.filter((e) => have.get(e.path)?.sha !== e.sha);
  const wantedPaths = new Set(wanted.map((e) => e.path));
  const del = [...have.keys()].filter((p) => !wantedPaths.has(p));

  // Rebase, step 1 only: a file touched here must be as it was upstream.
  const touched = new Set(pending.flatMap((c) => Object.keys(c.files)));
  const both = [...changed.map((e) => e.path), ...del].filter((p) => touched.has(p));
  if (both.length) throw new SyncError("conflict", CONFLICT, both.join(", "));

  let done = 0;
  onProgress({ done, total: changed.length });
  const put = await pool(changed, BLOB_PARALLEL, async (e) => {
    const bytes = await remote.blob(e.sha);
    const sha = await blobSha(bytes);
    if (sha !== e.sha) throw new RemoteError("server", "A file from GitHub didn't match its checksum.", { detail: `${e.sha.slice(0, 7)} hashed to ${sha.slice(0, 7)}` });
    onProgress({ done: ++done, total: changed.length });
    return fileRecord(e.path, e.sha, bytes);
  });
  const c = await remote.commit(head.sha);

  await store.applyPull({
    meta: {
      base: head.sha,
      tree: tree.sha,
      etag: head.etag,
      baseCommit: { sha: c.sha, message: c.message, author: c.author, date: c.date },
      lastCheck: now,
      lastError: null,
    },
    put,
    del,
    log: { kind: "pull", from: meta.base || null, to: head.sha, files: put.length, removed: del.length, kept: pending.length },
  });
  return { changed: true, paths: [...put.map((f) => f.path), ...del] };
}

/** Blob SHAs of a local commit's texts, as a push would have made them. */
async function blobsOf(commit) {
  const out = {};
  for (const [path, f] of Object.entries(commit.files)) out[path] = await blobSha(f.after);
  return out;
}

/**
 * Local commits whose push reached GitHub though the answer was lost: the head is that commit, or
 * descends from it (Emacs pulled it and pushed on top). Each is counted as pushed, in order.
 */
async function settleLost({ remote, store, headSha, acc }) {
  let meta = await store.getMeta();
  let pending = await store.pending();
  while (pending.length && pending[0].attempt && headSha && headSha !== meta.base) {
    const p = pending[0];
    const a = p.attempt;
    let landed = a.sha === headSha;
    if (!landed) {
      try {
        const st = (await remote.compare(a.sha, headSha)).status;
        landed = st === "ahead" || st === "identical";
      } catch (e) {
        if (!(e instanceof RemoteError && e.kind === "missing")) throw e;
      }
    }
    if (!landed) break;
    await store.markPushed(p.id, { sha: a.sha, tree: a.tree, blobs: a.blobs || (await blobsOf(p)), baseCommit: baseCommitOf(a.sha, p), lost: true });
    acc.pushed += 1;
    meta = await store.getMeta();
    pending = await store.pending();
  }
  return { meta, pending };
}

const baseCommitOf = (sha, p) => ({ sha, message: p.message, author: "Rumbo", date: new Date().toISOString() });

/** Push the local commits in order: seal, make the commit, keep it as the attempt, move the ref, mark it pushed. */
async function pushPending({ remote, store, acc }) {
  const meta = await store.getMeta();
  let base = meta.base;
  let tree = meta.tree || (base ? (await remote.commit(base)).tree : null);
  for (const { id } of await store.pending()) {
    const p = await store.seal(id);
    const files = Object.fromEntries(Object.entries(p.files).map(([path, f]) => [path, f.after]));
    const c = await remote.makeCommit(base, tree, files, p.message);
    await store.noteAttempt(id, { sha: c.sha, tree: c.tree, blobs: c.blobs });
    try {
      await remote.updateRef(c.sha);
    } catch (e) {
      // Someone pushed since the head was read: pull, then push again.
      if (e instanceof RemoteError && e.kind === "rejected") throw new Retry();
      throw e;
    }
    await store.markPushed(id, { sha: c.sha, tree: c.tree, blobs: c.blobs, baseCommit: baseCommitOf(c.sha, p) });
    acc.pushed += 1;
    base = c.sha;
    tree = c.tree;
  }
}

/**
 * One sync: read the head; count as pushed any local commit whose answer was lost; pull what
 * GitHub has (keeping the local commits, rebase step 1); push the local commits. A pass that loses
 * a race starts again, up to RETRIES times. Returns `{ changed, paths, pushed }`.
 */
export async function syncOnce({ remote, store, onProgress = () => {} }) {
  const acc = { changed: false, paths: new Set(), pushed: 0 };
  for (let attempt = 1; ; attempt++) {
    try {
      const meta0 = await store.getMeta();
      const head = await remote.head(meta0.etag || null);
      const headSha = head.changed ? head.sha : meta0.base;
      const { meta, pending } = await settleLost({ remote, store, headSha, acc });
      const r = await pullTo({ remote, store, meta, head, pending, onProgress });
      if (r.changed) acc.changed = true;
      r.paths.forEach((p) => acc.paths.add(p));
      await pushPending({ remote, store, acc });
      return { changed: acc.changed, paths: [...acc.paths], pushed: acc.pushed };
    } catch (e) {
      const race = e instanceof Retry || (e instanceof StoreError && (e.code === "pending-changed" || e.code === "gone"));
      if (!race) throw e;
      if (attempt >= RETRIES) throw new RemoteError("rejected", "GitHub kept moving while this device pushed. It will try again.", { detail: "ref update refused" });
    }
  }
}

// ------------------------------------------------------------------------------------- engine

/** Seconds to wait after the 1st, 2nd, 3rd… failure that is expected to clear. */
export const BACKOFF = [5, 15, 60];
const STOPPING = new Set(["auth", "missing", "diverged", "rejected", "conflict"]);

/**
 * The engine: one sync at a time, `again` for a trigger during a sync, backoff on failures that
 * clear on their own, and a stop on those that need the owner (§3, "The sync engine").
 *
 * Status, for the header mark and the Sync page:
 *   synced | syncing | offline (network or server trouble; retrying) | waiting (rate limit) |
 *   attention (sign in, check Setup, branch rewritten)
 *
 * `run()` does one pass and resolves with its result. Timers and `onLine` are injected for tests.
 */
export function createEngine({ run, store = null, online = () => globalThis.navigator?.onLine !== false, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
  const listeners = new Set();
  let status = "synced";
  let lastError = null;
  let running = null;
  let again = false;
  let failures = 0;
  let timer = 0;
  let waitUntil = 0;
  let stoppedBy = null;

  const view = () => ({ status, lastError, stoppedBy, failures, waitUntil, running: !!running });
  const emit = (extra = {}) => listeners.forEach((fn) => fn({ ...view(), ...extra }));

  function schedule(seconds) {
    clearTimer(timer);
    waitUntil = now() + seconds * 1000;
    timer = setTimer(() => {
      timer = 0;
      waitUntil = 0;
      sync("retry");
    }, seconds * 1000);
  }

  function fail(e) {
    const kind = e?.kind || "server";
    lastError = { kind, message: e?.message || String(e), detail: e?.detail || "", status: e?.status ?? null, at: now() };
    if (kind === "offline" || kind === "server") {
      failures += 1;
      status = "offline";
      schedule(BACKOFF[Math.min(failures, BACKOFF.length) - 1]);
    } else if (kind === "rate-limited") {
      status = "waiting";
      schedule(Math.max(1, Math.ceil(((e.retryAt || now() + 60_000) - now()) / 1000)));
    } else {
      status = "attention";
      stoppedBy = STOPPING.has(kind) ? kind : "error";
    }
    store?.setMeta({ lastError }).catch(() => {});
    store?.log({ kind: "error", class: kind, message: lastError.message, detail: lastError.detail }).catch(() => {});
  }

  /**
   * Ask for a sync. `manual` (Check now, Setup) also runs after a stop or during a wait; any
   * other reason is skipped while stopped, waiting, or while the browser says it is offline.
   */
  function sync(reason = "manual") {
    if (running) {
      again = true;
      return running;
    }
    const manual = reason === "manual";
    if (!manual && (stoppedBy || waitUntil > now())) return Promise.resolve(null);
    if (!manual && !online()) {
      // `onLine === false` is reliable; true proves nothing (Android said "online" with every radio off).
      status = "offline";
      emit();
      return Promise.resolve(null);
    }
    if (manual) {
      stoppedBy = null;
      clearTimer(timer);
      waitUntil = 0;
    }
    running = (async () => {
      let result = null;
      do {
        again = false;
        status = "syncing";
        emit();
        try {
          result = await run();
          failures = 0;
          lastError = null;
          status = "synced";
          emit({ result });
        } catch (e) {
          fail(e);
          emit();
          break;
        }
      } while (again);
      running = null;
      emit();
      return result;
    })();
    return running;
  }

  return {
    sync,
    status: view,
    onStatus: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    /** Resolves once no sync is running (an update waits for this). */
    idle: async () => {
      while (running) await running.catch(() => {});
    },
    stop() {
      clearTimer(timer);
      timer = 0;
    },
  };
}

/** The triggers: becoming visible, focus, `online`, and every 60 s while visible. */
export function attachTriggers(engine, { win = window, doc = document, everyMs = 60_000 } = {}) {
  const visible = () => doc.visibilityState === "visible";
  doc.addEventListener("visibilitychange", () => visible() && engine.sync("visible"));
  win.addEventListener("focus", () => engine.sync("focus"));
  win.addEventListener("online", () => engine.sync("online"));
  setInterval(() => visible() && engine.sync("tick"), everyMs);
}
