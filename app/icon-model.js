// The page's side of the fallback icon model (docs/plans/real-app.md §7): one worker
// (icon-worker.js), started on the first request and ended after `idleMs` without one, so the
// model's memory (a few hundred MB) is held only while guesses are being made.

import { readFileList } from "./icon-files.js";

export function createIconModel({ base = new URL("./icon-model/", import.meta.url), idleMs = 60_000, makeWorker = () => new Worker(new URL("./icon-worker.js", import.meta.url), { type: "module" }) } = {}) {
  let worker = null;
  let idle = null;
  let seq = 0;
  let listP = null;
  const waiting = new Map();

  const stop = () => {
    clearTimeout(idle);
    worker?.terminate();
    worker = null;
    for (const { reject } of waiting.values()) reject(Object.assign(new Error("the icon model was stopped"), { kind: "stopped" }));
    waiting.clear();
  };

  function start() {
    if (worker) return worker;
    worker = makeWorker();
    worker.onmessage = ({ data }) => {
      const w = waiting.get(data.id);
      if (!w) return;
      waiting.delete(data.id);
      if (data.error) w.reject(Object.assign(new Error(data.error), { kind: data.kind }));
      else {
        w.resolve(data);
      }
      if (!waiting.size) {
        clearTimeout(idle);
        idle = setTimeout(stop, idleMs);
      }
    };
    worker.onerror = (e) => {
      const err = Object.assign(new Error(e.message || "the icon model's worker failed"), { kind: "error" });
      for (const { reject } of waiting.values()) reject(err);
      waiting.clear();
      stop();
    };
    return worker;
  }

  return {
    /** The build's list of the model's files (from the precache), or null when this build has none. */
    list() {
      listP ||= readFileList(base).catch((e) => {
        listP = null;
        throw e;
      });
      return listP;
    },
    /** Guesses for tasks `[{key, title, parents}]`: `{tag, guesses: {key: icon or null}, stats}`. */
    guess(tasks) {
      const w = start();
      clearTimeout(idle);
      const id = ++seq;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        w.postMessage({ id, type: "guess", tasks });
      });
    },
  };
}
