// The fallback icon model, off the main thread (docs/plans/real-app.md §7). It loads the model's
// files (icon-files.js), builds the matcher once (icon-matcher.js) and answers
//   {id, type: "guess", tasks: [{key, title, parents}]}
//     → {id, tag, guesses: {key: icon or null}, stats}
// or {id, error, kind}. icon-model.js ends this worker when it has been idle a while, which gives
// its memory back.

import * as ort from "./vendor/ort/ort.wasm.bundle.min.mjs";
import { Tokenizer } from "./vendor/tokenizers.min.mjs";
import { createMatcher } from "./icon-matcher.js";
import { loadModelFiles } from "./icon-files.js";

const base = new URL("./icon-model/", import.meta.url);
let ready = null;
const stats = { fetched: 0, filesMs: 0, loadMs: 0, encodeMs: [] };

function matcher() {
  ready ||= (async () => {
    const t0 = performance.now();
    const { files, fetched } = await loadModelFiles({ base });
    const t1 = performance.now();
    const m = await createMatcher({ ort, Tokenizer, files });
    Object.assign(stats, { fetched, filesMs: Math.round(t1 - t0), loadMs: Math.round(performance.now() - t1) });
    return m;
  })();
  ready.catch(() => (ready = null)); // a failed load is tried again on the next request
  return ready;
}

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type !== "guess") throw new Error(`unknown request ${type}`);
    const m = await matcher();
    const guesses = {};
    for (const t of data.tasks) {
      const t0 = performance.now();
      guesses[t.key] = (await m.guess(t)).icon;
      stats.encodeMs.push(Math.round((performance.now() - t0) * 10) / 10);
    }
    self.postMessage({ id, tag: m.tag, guesses, stats: { ...stats, encodeMs: stats.encodeMs.slice(-50) } });
  } catch (e) {
    self.postMessage({ id, error: e.message || String(e), kind: e.kind || "error" });
  }
};
