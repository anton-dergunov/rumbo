// The local replica in IndexedDB (docs/plans/real-app.md §3, "The local replica").
//
// - One database, `rumbo`, with its own schema version. A change that would drop pending commits
//   is never allowed (§2): migrate or push them first.
// - Each change is one transaction, so a crash leaves all of it or none of it.
// - Every call times out after 2 s and the database is reopened on the next call: after a long
//   time in the background, WebKit can leave a request unanswered forever, and every later one
//   with it (lectern `reader.js`).
//
// The IndexedDB factory is passed in, so tests run on fake-indexeddb.
//
// A local commit (`pending`, in order of `id`):
//   { id, created, updated, message, base,
//     ops,                               all its edits' ops, in order (ops.js)
//     parts: [{edit, label, n, opaque, summary, paths}]   one per edit folded in; opaque = no ops (an undo)
//     files: {path: {before, after}},    the text before its first edit and after its last
//     ctx: {path: {rule, memory}},       the spacing context its edits used (commits.js saveContext)
//     sealed,                            a push has started: it takes no more edits
//     attempt }                          {sha, tree} of the commit made on GitHub, kept before the ref update

import { commitMessage, foldContext as foldCtx } from "./commits.js";

export const DB_NAME = "rumbo";
export const SCHEMA = 1;
const TIMEOUT_MS = 2000;
const LOG_MAX = 100;
/** Edits closer together than this are folded into one local commit (§3). */
export const FOLD_MS = 3000;

/** Meta keys that describe the replica's base; Reset forgets them, Setup's keys stay. */
export const BASE_KEYS = ["base", "tree", "etag", "baseCommit", "lastCheck", "lastError", "conflict"];

export class StoreError extends Error {
  /** code: "stale" (the file changed since the edit was made), "pending-changed" (a pull would overwrite an edited file), "gone", or null. */
  constructor(message, code = null) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

/** Run `then(results)` once every request in `reqs` has succeeded. */
function whenAll(t, reqs, then) {
  const out = new Array(reqs.length);
  let left = reqs.length;
  const run = () => {
    try {
      then(out);
    } catch (e) {
      t.abortWith(e);
    }
  };
  if (!left) return run();
  reqs.forEach((r, i) => {
    r.onsuccess = () => {
      out[i] = r.result;
      if (--left === 0) run();
    };
  });
}

const touchedPaths = (pending) => new Set(pending.flatMap((c) => Object.keys(c.files)));

export function openStore({ indexedDB = globalThis.indexedDB, name = DB_NAME, timeoutMs = TIMEOUT_MS } = {}) {
  let dbPromise = null;

  function open() {
    dbPromise ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(name, SCHEMA);
      req.onupgradeneeded = () => {
        const db = req.result;
        // Version 1. Later versions add their changes here, keeping `pending` intact.
        db.createObjectStore("meta");
        db.createObjectStore("files", { keyPath: "path" });
        db.createObjectStore("pending", { keyPath: "id" });
        db.createObjectStore("settings");
        db.createObjectStore("obsidian");
        db.createObjectStore("log", { autoIncrement: true });
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another tab upgrading the schema: let it, and reopen on the next call.
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new StoreError("The database is held open by another copy of Rumbo."));
    });
    return dbPromise;
  }

  function guarded(work) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const stale = dbPromise;
        dbPromise = null;
        stale?.then((db) => db.close()).catch(() => {});
        reject(new StoreError(`IndexedDB did not answer within ${timeoutMs / 1000} s`));
      }, timeoutMs);
    });
    return Promise.race([work(), timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * Run `body(tx)` in one transaction. `body` issues requests synchronously and returns either a
   * value or a function read after the transaction commits. A throw aborts the whole transaction.
   */
  function tx(names, mode, body) {
    return guarded(async () => {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction(names, mode);
        let out;
        t.oncomplete = () => resolve(typeof out === "function" ? out() : out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new StoreError("The change was not saved."));
        // Abort with a reason the caller sees.
        t.abortWith = (err) => {
          t.onabort = () => reject(err);
          try {
            t.abort();
          } catch {
            reject(err);
          }
        };
        try {
          out = body(t);
        } catch (e) {
          t.abortWith(e);
        }
      });
    });
  }

  /** All keys and values of a key-value store, as an object. */
  function readKv(t, storeName) {
    const s = t.objectStore(storeName);
    const keys = s.getAllKeys();
    const values = s.getAll();
    return () => Object.fromEntries(keys.result.map((k, i) => [k, values.result[i]]));
  }

  function putMeta(t, patch) {
    const s = t.objectStore("meta");
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) s.delete(k);
      else s.put(v, k);
    }
  }

  function addLog(t, event) {
    const s = t.objectStore("log");
    s.add({ at: Date.now(), ...event });
    const count = s.count();
    count.onsuccess = () => {
      let extra = count.result - LOG_MAX;
      if (extra <= 0) return;
      s.openCursor().onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur || extra-- <= 0) return;
        cur.delete();
        cur.continue();
      };
    };
  }

  /** The body of recordEdit and undoEdit: check the files, then fold, pop or add the local commit. */
  function writeEdit(t, edit, { now, foldMs, undo }) {
    const meta = t.objectStore("meta");
    const fs = t.objectStore("files");
    const ps = t.objectStore("pending");
    const paths = edit.files.map((f) => f.path);
    const reqs = [meta.get("base"), meta.get("seq"), meta.get("device"), ps.openCursor(null, "prev"), ...paths.map((p) => fs.get(p))];
    let out = null;
    whenAll(t, reqs, ([base, seq, device, cursor, ...recs]) => {
      // An undo checks against the text after the edit; an edit against the text before it.
      edit.files.forEach((f, i) => {
        const rec = recs[i];
        if (!rec) throw new StoreError(`${f.path} is not on this device.`, "stale");
        if (rec.readOnly) throw new StoreError(`${f.path} is read-only.`, "stale");
        if ((rec.work ?? rec.text) !== (undo ? f.after : f.before)) throw new StoreError(`${f.path} changed on this device since the edit was made.`, "stale");
      });
      const last = cursor?.value || null;
      const setWork = (f, text) => {
        const rec = recs[paths.indexOf(f.path)];
        fs.put({ ...rec, work: text === rec.text ? null : text });
      };

      if (undo && last && !last.sealed && last.parts.at(-1)?.edit === edit.id) {
        // Take the edit off the commit it is the last part of.
        const part = last.parts.at(-1);
        const c = { ...last, parts: last.parts.slice(0, -1), ops: part.n ? last.ops.slice(0, -part.n) : last.ops, files: { ...last.files } };
        for (const f of edit.files) {
          setWork(f, f.before);
          c.files[f.path] = { ...c.files[f.path], after: f.before };
        }
        const noChange = Object.values(c.files).every((x) => x.before === x.after);
        if (!c.parts.length || noChange) ps.delete(c.id);
        else ps.put({ ...c, message: commitMessage(c.parts, device || "") });
        out = { id: c.id, popped: true };
        return;
      }

      const fold = !undo && last && !last.sealed && now - last.updated < foldMs;
      const id = fold ? last.id : (seq || 0) + 1;
      const c = fold
        ? { ...last, ops: [...last.ops], parts: [...last.parts], files: { ...last.files }, ctx: { ...last.ctx } }
        : { id, created: now, updated: now, message: "", base: base || null, ops: [], parts: [], files: {}, ctx: {}, sealed: false, attempt: null };
      for (const f of edit.files) {
        // An undo writes the text from before the edit.
        const after = undo ? f.before : f.after;
        const from = undo ? f.after : f.before;
        setWork(f, after);
        c.files[f.path] = { before: c.files[f.path]?.before ?? from, after };
      }
      const ops = undo ? [] : edit.ops || [];
      c.ops.push(...ops);
      c.parts.push({ edit: edit.id, label: edit.label || "", n: ops.length, opaque: undo || !ops.length, summary: edit.summary || { verb: "Edit", text: "Edit" }, paths });
      for (const [p, saved] of Object.entries((!undo && edit.ctx) || {})) c.ctx[p] = foldCtx(c.ctx[p], saved);
      c.updated = now;
      c.message = commitMessage(c.parts, device || "");
      if (Object.values(c.files).every((x) => x.before === x.after)) {
        // Edits that cancel out (down, then up) leave nothing to push.
        if (fold) ps.delete(c.id);
      } else ps.put(c);
      if (!fold) meta.put(id, "seq");
      out = { id: c.id, folded: !!fold };
    });
    return () => out;
  }

  return {
    getMeta: () => tx(["meta"], "readonly", (t) => readKv(t, "meta")),
    /** Set meta keys; a key set to `undefined` is removed. */
    setMeta: (patch) => tx(["meta"], "readwrite", (t) => putMeta(t, patch)),

    allFiles: () =>
      tx(["files"], "readonly", (t) => {
        const r = t.objectStore("files").getAll();
        return () => r.result;
      }),

    /** The local commits, oldest first. */
    pending: () =>
      tx(["pending"], "readonly", (t) => {
        const r = t.objectStore("pending").getAll();
        return () => r.result;
      }),

    /**
     * An edit, in one transaction: the files' new working text and the local commit that holds it.
     * `edit`: {id, label, summary, files: [{path, before, after}], ops, ctx: {path: saved}}. Folded
     * into the last local commit when that one is not sealed and took an edit under FOLD_MS ago.
     * Refused (`stale`) unless each `before` is the file's working text here.
     */
    recordEdit: (edit, { now = Date.now(), foldMs = FOLD_MS } = {}) =>
      tx(["meta", "files", "pending"], "readwrite", (t) => writeEdit(t, edit, { now, foldMs, undo: false })),

    /**
     * Undo the edit `edit.id`: `edit.files` are [{path, before, after}] of that edit, `after` being the
     * text now. If it is the last part of an unsealed local commit, it is taken off that commit (and
     * a commit left with no parts is dropped); otherwise the undo is a new commit with the old text.
     */
    undoEdit: (edit, { now = Date.now() } = {}) =>
      tx(["meta", "files", "pending"], "readwrite", (t) => writeEdit(t, edit, { now, foldMs: 0, undo: true })),

    /** Seal a local commit for a push: it takes no more edits. Returns it as sealed. */
    seal: (id) =>
      tx(["pending"], "readwrite", (t) => {
        const s = t.objectStore("pending");
        const r = s.get(id);
        let out = null;
        r.onsuccess = () => {
          if (!r.result) return t.abortWith(new StoreError("That local commit is gone.", "gone"));
          out = { ...r.result, sealed: true };
          s.put(out);
        };
        return () => out;
      }),

    /** Keep the commit made on GitHub for a local commit, before the ref update is asked for. */
    noteAttempt: (id, attempt) =>
      tx(["pending"], "readwrite", (t) => {
        const s = t.objectStore("pending");
        const r = s.get(id);
        r.onsuccess = () => {
          if (!r.result) return t.abortWith(new StoreError("That local commit is gone.", "gone"));
          s.put({ ...r.result, attempt });
        };
      }),

    /**
     * A local commit is on GitHub as `sha` (tree `tree`), in one transaction: it leaves `pending`,
     * its text becomes the base of its files (`blobs` their SHAs), and the base moves to `sha`.
     */
    markPushed: (id, { sha, tree, baseCommit = null, blobs = {}, lost = false }) =>
      tx(["meta", "files", "pending", "log"], "readwrite", (t) => {
        const ps = t.objectStore("pending");
        const fs = t.objectStore("files");
        const all = ps.getAll();
        all.onsuccess = () => {
          const c = all.result.find((x) => x.id === id);
          if (!c) return t.abortWith(new StoreError("That local commit is gone.", "gone"));
          const paths = Object.keys(c.files);
          whenAll(t, paths.map((p) => fs.get(p)), (recs) => {
            recs.forEach((rec, i) => {
              const { after } = c.files[paths[i]];
              if (!rec) return;
              const work = rec.work ?? rec.text;
              fs.put({ ...rec, text: after, sha: blobs[paths[i]] || rec.sha, work: work === after ? null : work });
            });
            ps.delete(id);
            for (const later of all.result) if (later.id !== id) ps.put({ ...later, base: sha });
            putMeta(t, { base: sha, tree, baseCommit: baseCommit || { sha, message: c.message, author: "", date: "" }, etag: undefined, lastError: null });
            addLog(t, { kind: "push", sha, message: c.message, files: paths.length, lost });
          });
        };
      }),

    pendingCount: () =>
      tx(["pending"], "readonly", (t) => {
        const r = t.objectStore("pending").count();
        return () => r.result;
      }),

    /**
     * A pull, in one transaction: the new meta, the files that changed, the ones that went, and a
     * log entry. With local commits waiting, only files they don't touch may change (rebase step 1:
     * their text is still right on the new head), and they move onto the new base; otherwise the
     * pull is refused (`pending-changed`) and nothing is written.
     *
     * `rebased` (merge.js rebasePending): {expect: [{id, updated}], commits, dropped} — the local
     * commits rebased onto the new head. They replace `pending` only if it is still exactly what
     * was rebased (an edit meanwhile refuses the pull with `pending-changed`, and the sync starts
     * again); each touched file's working text becomes the last rebased commit's text.
     */
    applyPull: ({ meta = {}, put = [], del = [], log = null, rebased = null }) =>
      tx(["meta", "files", "pending", "log"], "readwrite", (t) => {
        const ps = t.objectStore("pending");
        const all = ps.getAll();
        all.onsuccess = () => {
          const files = t.objectStore("files");
          if (rebased) {
            const now = all.result.map((c) => `${c.id}:${c.updated}`).join(",");
            const was = rebased.expect.map((c) => `${c.id}:${c.updated}`).join(",");
            if (now !== was) return t.abortWith(new StoreError("A local commit changed while the pull rebased it.", "pending-changed"));
            for (const c of all.result) ps.delete(c.id);
            const work = new Map();
            for (const c of rebased.commits) {
              ps.put({ ...c, base: meta.base || c.base });
              for (const [path, f] of Object.entries(c.files)) work.set(path, f.after);
            }
            const byPath = new Map(put.map((f) => [f.path, f]));
            const gone = new Set(del);
            // A file the rebase touched: its record from the pull (or as it is), the rebased text as its work.
            const touched = [...touchedPaths(all.result)];
            whenAll(t, touched.map((p) => files.get(p)), (recs) => {
              touched.forEach((path, i) => {
                if (gone.has(path)) {
                  // Deleted upstream, but a local commit writes it again ("Keep mine"): keep it here.
                  if (work.has(path)) {
                    gone.delete(path);
                    byPath.set(path, { path, sha: null, text: "", work: work.get(path), readOnly: null });
                  }
                  return;
                }
                const rec = byPath.get(path) || recs[i];
                if (!rec) return;
                const w = work.has(path) ? work.get(path) : rec.text;
                byPath.set(path, { ...rec, work: w === rec.text ? null : w });
              });
              putMeta(t, { ...meta, conflict: undefined });
              for (const f of byPath.values()) files.put(f);
              for (const path of gone) files.delete(path);
              if (log) addLog(t, log);
            });
            return;
          }
          const touched = touchedPaths(all.result);
          const clash = [...put.map((f) => f.path), ...del].find((p) => touched.has(p));
          if (clash) return t.abortWith(new StoreError(`${clash} has local edits; the pull needs a rebase.`, "pending-changed"));
          putMeta(t, meta);
          for (const f of put) files.put(f);
          for (const path of del) files.delete(path);
          if (meta.base) for (const c of all.result) ps.put({ ...c, base: meta.base });
          if (log) addLog(t, log);
        };
      }),

    /**
     * A conflict on `path` resolved, in one transaction (§4, the conflict screen):
     *   github  every local commit loses its changes to the file (merge.js withoutPath), and the
     *           file's working text is its base text again; the next pull brings GitHub's;
     *   mine    the same, then one new local commit on top that writes `mine` over `theirs`.
     * The path leaves `meta.conflict`. `commits` is withoutPath's result for the current pending.
     */
    resolveConflict: ({ path, how, commits, theirs = null, mine = null, message = "", now = Date.now() }) =>
      tx(["meta", "files", "pending", "log"], "readwrite", (t) => {
        const ps = t.objectStore("pending");
        const meta = t.objectStore("meta");
        const fs = t.objectStore("files");
        whenAll(t, [ps.getAll(), meta.get("seq"), meta.get("conflict"), meta.get("base"), fs.get(path)], ([all, seq, conflict, base, rec]) => {
          const keep = new Set(commits.map((c) => c.id));
          for (const c of all) if (!keep.has(c.id)) ps.delete(c.id);
          for (const c of commits) ps.put(c);
          let id = null;
          if (how === "mine") {
            id = (seq || 0) + 1;
            meta.put(id, "seq");
            const part = { edit: `resolve-${id}`, label: "", n: 0, opaque: true, summary: { verb: "Keep", text: "Keep" }, paths: [path] };
            ps.put({ id, created: now, updated: now, message, base: base || null, ops: [], parts: [part], files: { [path]: { before: theirs, after: mine } }, ctx: {}, sealed: true, attempt: null });
          }
          if (rec) fs.put({ ...rec, work: how === "mine" && mine !== rec.text ? mine : null });
          else if (how === "mine" && mine != null) fs.put({ path, sha: null, text: "", work: mine, readOnly: null });
          const left = (conflict?.files || []).filter((f) => f.path !== path);
          if (conflict) meta.put({ ...conflict, files: left }, "conflict");
          if (conflict && !left.length) meta.delete("conflict");
          addLog(t, { kind: "resolve", path, how });
        });
        return () => undefined;
      }),
    /**
     * Forget the replica (Reset to GitHub), keeping Setup. Refused while commits are pending, unless
     * `force` (they were pushed to a rescue branch or saved in a zip first): then they go too.
     */
    resetReplica: ({ force = false } = {}) =>
      tx(["meta", "files", "pending", "log"], "readwrite", (t) => {
        const ps = t.objectStore("pending");
        const count = ps.count();
        count.onsuccess = () => {
          if (count.result > 0 && !force) return t.abortWith(new StoreError("Local commits are waiting; push them or save them before a reset."));
          ps.clear();
          t.objectStore("files").clear();
          putMeta(t, Object.fromEntries(BASE_KEYS.map((k) => [k, undefined])));
          addLog(t, { kind: "reset", dropped: count.result });
        };
      }),

    getSetting: (key) =>
      tx(["settings"], "readonly", (t) => {
        const r = t.objectStore("settings").get(key);
        return () => r.result;
      }),
    setSetting: (key, value) => tx(["settings"], "readwrite", (t) => void t.objectStore("settings").put(value, key)),

    /** The Obsidian repo's note index (notes.js): `{ repo, head, etag, notes, files }`, or undefined. */
    getNotesIndex: () =>
      tx(["obsidian"], "readonly", (t) => {
        const r = t.objectStore("obsidian").get("index");
        return () => r.result;
      }),
    setNotesIndex: (index) => tx(["obsidian"], "readwrite", (t) => void t.objectStore("obsidian").put(index, "index")),

    log: (event) => tx(["log"], "readwrite", (t) => addLog(t, event)),
    /** The sync log, oldest first. */
    readLog: () =>
      tx(["log"], "readonly", (t) => {
        const r = t.objectStore("log").getAll();
        return () => r.result;
      }),

    close() {
      dbPromise?.then((db) => db.close()).catch(() => {});
      dbPromise = null;
    },
  };
}
