// The on-device fallback icon model (docs/plans/real-app.md §7): tokenizer → ONNX encoder →
// mean pool → L2 normalize → the bundle's icon scores → the gate. It mirrors agentic-org-planner's
// `org_task_icon_matcher.py`, with the libraries injected, so the worker (icon-worker.js) and the
// Node tests run the same code.

import { composeQuery, parseNpy, poolNormalize, scoreTop1, truncateIds } from "./icon-query.js";

/**
 * `ort` is onnxruntime-web, `Tokenizer` the class from @huggingface/tokenizers. `files` holds the
 * bytes: `model` (the ONNX file), `tokenizer` (its JSON text), `wasm` (ORT's binary; Node finds its
 * own), `manifest` (parsed), `names` (text), `dense` and `prior` (.npy).
 */
export async function createMatcher({ ort, Tokenizer, files }) {
  const { manifest } = files;
  ort.env.wasm.numThreads = 1; // Pages has no cross-origin isolation, so no threads anyway
  ort.env.wasm.proxy = false;
  if (files.wasm) ort.env.wasm.wasmBinary = files.wasm;
  const session = await ort.InferenceSession.create(files.model, { graphOptimizationLevel: "basic", executionProviders: ["wasm"] });
  const tokenizer = new Tokenizer(typeof files.tokenizer === "string" ? JSON.parse(files.tokenizer) : files.tokenizer, {});
  const names = files.names.split(/\s+/).filter(Boolean);
  const dense = parseNpy(files.dense);
  const prior = parseNpy(files.prior).data;
  const dim = dense.shape[1];
  if (dense.shape[0] !== names.length || prior.length !== names.length) throw new Error("icon bundle: names, dense and prior disagree");
  const enc = manifest.encoder;
  const threshold = manifest.fusion.threshold;
  const output = session.outputNames.includes("last_hidden_state") ? "last_hidden_state" : session.outputNames[0];

  /** Token ids for one text, cut as the Python tokenizer cuts it. */
  const ids = (text) => truncateIds(tokenizer.encode(enc.query_prefix + text).ids, enc.max_length);

  /**
   * One text's vector. Texts are never batched: int8 dynamic quantization scales activations over
   * the whole input, so in a batch a text's vector would depend on its batch mates.
   */
  async function encode(text) {
    const t = ids(text);
    const shape = [1, t.length];
    const feeds = {
      input_ids: new ort.Tensor("int64", BigInt64Array.from(t, BigInt), shape),
      attention_mask: new ort.Tensor("int64", new BigInt64Array(t.length).fill(1n), shape),
    };
    if (session.inputNames.includes("token_type_ids")) feeds.token_type_ids = new ort.Tensor("int64", new BigInt64Array(t.length), shape);
    const out = await session.run(feeds);
    const hidden = out[output];
    const vec = poolNormalize(hidden.data, t.length, dim);
    for (const k of Object.keys(out)) out[k].dispose?.();
    return vec;
  }

  return {
    tag: manifest.tag,
    ids,
    encode,
    /** The guess for one task `{title, parents}`: `{icon, top, z}`; `icon` is null when the gate abstains. */
    async guess(task) {
      const query = composeQuery(task, manifest.query);
      if (!query) return { icon: null, top: null, z: 0, query };
      const { index, z } = scoreTop1(await encode(query), dense.data, prior, dim);
      return { icon: z >= threshold ? names[index] : null, top: names[index], z, query };
    },
    release: () => session.release(),
  };
}
