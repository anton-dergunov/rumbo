# Task icon model (the on-device fallback)

The bundle of the small task-icon model, `F1@all-kd-final` int8 (tag in `manifest.json`), copied from
task-concept-retrieval's `.cache/bundles/F1-all-kd-final-int8/` (made by its
`scripts/export_bundle.py --method F1 --run all-kd-final --precision int8`).

| File | What |
|---|---|
| `manifest.json` | The model's encoder (URL and sha256 of the ONNX file and tokenizer, pinned to a Hugging Face revision), the query recipe and the gate threshold |
| `names.txt` | The 2,862 Material Symbols icon names |
| `dense.npy` | The icon vectors, float16 `[2862, 384]` |
| `prior.npy` | A per-icon score offset, float32 `[2862]` |

The encoder (`model_int8.onnx`, 118 MB) and its `tokenizer.json` are not in the repo. `tools/build.mjs`
takes them from `.cache/icon-model/`, `$RUMBO_ICON_MODEL_DIR`, or the manifest's URLs (the copy at
`huggingface.co/AntonDergunov/task-icon-encoder-e5-small-interim`), checks their sha256s, and writes
them into the site as parts under 100 MiB with `files.json`. The app fetches them only from its own
site.

To ship another model: copy its bundle here, pin its URLs to a revision, run
`node tools/icon-golden.mjs` (needs `uv` and the model files) and `npm test`.

Licences: the model is MIT (its base model, intfloat/multilingual-e5-small, is MIT); the icon names
are Material Symbols by Google, Apache 2.0.
