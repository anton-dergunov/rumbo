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

export const DB_NAME = "rumbo";
export const SCHEMA = 1;
const TIMEOUT_MS = 2000;
const LOG_MAX = 100;

/** Meta keys that describe the replica's base; Reset forgets them, Setup's keys stay. */
export const BASE_KEYS = ["base", "tree", "etag", "baseCommit", "lastCheck", "lastError"];

export class StoreError extends Error {
  constructor(message) {
    super(message);
    this.name = "StoreError";
  }
}

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

  return {
    getMeta: () => tx(["meta"], "readonly", (t) => readKv(t, "meta")),
    /** Set meta keys; a key set to `undefined` is removed. */
    setMeta: (patch) => tx(["meta"], "readwrite", (t) => putMeta(t, patch)),

    allFiles: () =>
      tx(["files"], "readonly", (t) => {
        const r = t.objectStore("files").getAll();
        return () => r.result;
      }),

    pendingCount: () =>
      tx(["pending"], "readonly", (t) => {
        const r = t.objectStore("pending").count();
        return () => r.result;
      }),

    /**
     * A pull, in one transaction: the new meta, the files that changed, the ones that went, and a
     * log entry. Refused while commits are pending: those need a rebase first (plan step 4).
     */
    applyPull: ({ meta = {}, put = [], del = [], log = null }) =>
      tx(["meta", "files", "pending", "log"], "readwrite", (t) => {
        const count = t.objectStore("pending").count();
        count.onsuccess = () => {
          if (count.result > 0) return t.abortWith(new StoreError("Local commits are waiting; a pull needs a rebase first."));
          putMeta(t, meta);
          const files = t.objectStore("files");
          for (const f of put) files.put(f);
          for (const path of del) files.delete(path);
          if (log) addLog(t, log);
        };
      }),

    /** Forget the replica (Reset to GitHub), keeping Setup. Refused while commits are pending. */
    resetReplica: () =>
      tx(["meta", "files", "pending", "log"], "readwrite", (t) => {
        const count = t.objectStore("pending").count();
        count.onsuccess = () => {
          if (count.result > 0) return t.abortWith(new StoreError("Local commits are waiting; push them or save them before a reset."));
          t.objectStore("files").clear();
          putMeta(t, Object.fromEntries(BASE_KEYS.map((k) => [k, undefined])));
          addLog(t, { kind: "reset" });
        };
      }),

    getSetting: (key) =>
      tx(["settings"], "readonly", (t) => {
        const r = t.objectStore("settings").get(key);
        return () => r.result;
      }),
    setSetting: (key, value) => tx(["settings"], "readwrite", (t) => void t.objectStore("settings").put(value, key)),

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
