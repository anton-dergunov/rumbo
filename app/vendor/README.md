# Vendored libraries

Copied once from their npm packages, so the app and its tests need no install or bundler. Each licence sits beside its file.

| File | Package | From | Licence | Use |
|---|---|---|---|---|
| `diff3.mjs` | node-diff3 3.2.1 | `dist/diff3.mjs`, without its source-map comment | MIT (`diff3.LICENSE.md`) | The 3-way merge of a rebase, diffs and conflict hunks (`merge.js`) |
| `marked.esm.js` | marked 18.1.0 | `lib/marked.esm.js`, without its source-map comment | MIT (`marked.LICENSE`) | Obsidian notes as HTML (`markdown.js`) |
| `purify.es.mjs` | DOMPurify 3.4.16 | `dist/purify.es.mjs`, without its source-map comment | Apache 2.0 or MPL 2.0 (`dompurify.LICENSE`) | Sanitising a rendered note before it enters the page (`markdown.js`) |
| `katex/` | KaTeX 0.19.0 | `dist/katex.mjs`, `dist/katex.min.css` and the `.woff2` fonts only; the CSS names only the `.woff2` files, and the three `node.setAttribute("style", …)` calls set `node.style.cssText` instead (the CSP blocks style attributes, not the CSSOM; marked `// Rumbo:`) | MIT (`katex/LICENSE`) | Maths in notes, loaded only when a note has some (`markdown.js`) |
| `fflate.js` | fflate 0.8.3 | `esm/browser.js`, unchanged | MIT (`fflate.LICENSE`) | The "Download everything" zip (`rescue.js`); only `zipSync` is used, so its worker code never runs |
| `ort/` | onnxruntime-web 1.31.1 | `dist/ort.wasm.bundle.min.mjs` (the WebAssembly-only build with its loader inside), without its source-map comment, and `dist/ort-wasm-simd-threaded.wasm`; the package ships no licence file, so `ort/LICENSE` is the MIT text of the onnxruntime repository | MIT (`ort/LICENSE`) | Runs the task icon model in a worker (`icon-worker.js`). The `.wasm` (15 MB) is not precached: it is downloaded with the model, only when a task needs a guess |
| `tokenizers.min.mjs` | @huggingface/tokenizers 0.2.0 | `dist/tokenizers.min.mjs`, unchanged | Apache 2.0 (`tokenizers.LICENSE`) | The icon model's XLM-R tokenizer (`icon-matcher.js`); its ids are checked against Python's `tokenizers` (`tests/icon-model.test.mjs`) |

To update one: `npm pack <package>@<version>`, unpack it, copy the same file and the licence here, and run `npm test`. Do the same edits again where the table says the file was changed.
