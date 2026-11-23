// The fallback icon model against the Python matcher it mirrors (tests/icon-golden.json, made by
// tools/icon-golden.mjs). The query text is checked always; the tokenizer and the model need the
// model files, so they run only with RUMBO_ICON_MODEL_DIR set (a folder holding model_int8.onnx
// and tokenizer.json: `.cache/icon-model` after a build, or task-concept-retrieval's
// .cache/onnx/F1-all-kd-final).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { composeQuery } from "../app/icon-query.js";

const golden = JSON.parse(readFileSync(new URL("./icon-golden.json", import.meta.url), "utf8"));
const bundle = new URL("../app/icon-model/", import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8"));
const dir = process.env.RUMBO_ICON_MODEL_DIR;
const modelFile = dir && join(dir, manifest.encoder.model.url.split("/").pop());
const skip = !(dir && existsSync(modelFile) && existsSync(join(dir, "tokenizer.json"))) && "set RUMBO_ICON_MODEL_DIR to run the model";

test("the golden file was made from this bundle", () => {
  assert.equal(golden.tag, manifest.tag);
  assert.deepEqual(golden.spec, manifest.query);
});

test("every task's query text is the Python matcher's", () => {
  for (const t of golden.tasks) assert.equal(composeQuery(t, golden.spec), t.query, JSON.stringify(t.title));
});

test("the tokenizer and the int8 model give the Python matcher's ids and picks", { skip, timeout: 600_000 }, async () => {
  const ort = await import("../app/vendor/ort/ort.wasm.bundle.min.mjs");
  const { Tokenizer } = await import("../app/vendor/tokenizers.min.mjs");
  const { createMatcher } = await import("../app/icon-matcher.js");
  const files = {
    model: readFileSync(modelFile),
    tokenizer: readFileSync(join(dir, "tokenizer.json"), "utf8"),
    wasm: readFileSync(new URL("../app/vendor/ort/ort-wasm-simd-threaded.wasm", import.meta.url)),
    manifest,
    names: readFileSync(join(bundle, "names.txt"), "utf8"),
    dense: readFileSync(join(bundle, "dense.npy")),
    prior: readFileSync(join(bundle, "prior.npy")),
  };
  const m = await createMatcher({ ort, Tokenizer, files });

  for (const t of [...golden.tasks.map((t) => ({ text: t.query, ids: t.ids })), ...golden.texts]) assert.deepEqual(m.ids(t.text), t.ids, t.text);

  let same = 0;
  let maxDz = 0;
  const differ = [];
  for (const t of golden.tasks) {
    const g = await m.guess(t);
    if (g.top === t.icon) same++;
    else differ.push(`${t.query}: ${g.top} (z ${g.z.toFixed(2)}) vs ${t.icon} (z ${t.z})`);
    maxDz = Math.max(maxDz, Math.abs(g.z - t.z));
  }
  const share = same / golden.tasks.length;
  if (differ.length) console.log(`  ${differ.length} picks differ from Python's:\n  ${differ.join("\n  ")}`);
  console.log(`  same top-1: ${same} of ${golden.tasks.length}; largest |Δz| ${maxDz.toFixed(4)}`);
  // ORT Web's WebAssembly int8 kernels round differently from native ORT's (Python's ORT 1.30 and
  // 1.31 agree on all 619; graph optimization changes nothing): 600 of 619 picks match, and the
  // rest are near-ties between neighbouring icons (|Δz| at most 0.3).
  assert.ok(share >= 0.95, `only ${(100 * share).toFixed(1)}% of picks match`);
  assert.ok(maxDz < 0.5, `a confidence moved by ${maxDz.toFixed(3)}`);
  await m.release();
});
