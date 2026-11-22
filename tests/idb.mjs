// fake-indexeddb for the store and sync tests. It is a devDependency: without `npm install` those
// tests are skipped (with this reason), so `npm test` still runs on a bare checkout.

let IDBFactory = null;
try {
  ({ IDBFactory } = await import("fake-indexeddb"));
} catch {
  // not installed
}

export const needsIdb = { skip: IDBFactory ? false : "fake-indexeddb is not installed: run npm install" };

/** A fresh, empty IndexedDB for one test. */
export const freshIdb = () => new IDBFactory();
