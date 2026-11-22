// Sync with the vault's repo on GitHub (docs/plans/real-app.md §3). This is the pull and the
// engine that runs it; push and rebase come with plan step 4.

import { RemoteError } from "./remote-github.js";
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
  const now = Date.now();
  const head = await remote.head(meta.etag || null);
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
  let done = 0;
  onProgress({ done, total: changed.length });
  const put = await pool(changed, BLOB_PARALLEL, async (e) => {
    const bytes = await remote.blob(e.sha);
    const sha = await blobSha(bytes);
    if (sha !== e.sha) throw new RemoteError("server", "A file from GitHub didn't match its checksum.", { detail: `${e.sha.slice(0, 7)} hashed to ${sha.slice(0, 7)}` });
    onProgress({ done: ++done, total: changed.length });
    return fileRecord(e.path, e.sha, bytes);
  });
  const wantedPaths = new Set(wanted.map((e) => e.path));
  const del = [...have.keys()].filter((p) => !wantedPaths.has(p));
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
    log: { kind: "pull", from: meta.base || null, to: head.sha, files: put.length, removed: del.length },
  });
  return { changed: true, paths: [...put.map((f) => f.path), ...del] };
}

// ------------------------------------------------------------------------------------- engine

/** Seconds to wait after the 1st, 2nd, 3rd… failure that is expected to clear. */
export const BACKOFF = [5, 15, 60];
const STOPPING = new Set(["auth", "missing", "diverged", "rejected"]);

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
