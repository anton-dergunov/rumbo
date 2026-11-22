# Vendored libraries

Copied once from their npm packages, so the app and its tests need no install or bundler. Each licence sits beside its file.

| File | Package | From | Licence | Use |
|---|---|---|---|---|
| `diff3.mjs` | node-diff3 3.2.1 | `dist/diff3.mjs`, without its source-map comment | MIT (`diff3.LICENSE.md`) | The 3-way merge of a rebase, diffs and conflict hunks (`merge.js`) |
| `marked.esm.js` | marked 18.1.0 | `lib/marked.esm.js`, without its source-map comment | MIT (`marked.LICENSE`) | Obsidian notes as HTML (`markdown.js`) |
| `purify.es.mjs` | DOMPurify 3.4.16 | `dist/purify.es.mjs`, without its source-map comment | Apache 2.0 or MPL 2.0 (`dompurify.LICENSE`) | Sanitising a rendered note before it enters the page (`markdown.js`) |
| `katex/` | KaTeX 0.19.0 | `dist/katex.mjs`, `dist/katex.min.css` and the `.woff2` fonts only; the CSS names only the `.woff2` files, and the three `node.setAttribute("style", …)` calls set `node.style.cssText` instead (the CSP blocks style attributes, not the CSSOM; marked `// Rumbo:`) | MIT (`katex/LICENSE`) | Maths in notes, loaded only when a note has some (`markdown.js`) |
| `fflate.js` | fflate 0.8.3 | `esm/browser.js`, unchanged | MIT (`fflate.LICENSE`) | The "Download everything" zip (`rescue.js`); only `zipSync` is used, so its worker code never runs |

To update one: `npm pack <package>@<version>`, unpack it, copy the same file and the licence here, and run `npm test`. Do the same edits again where the table says the file was changed.
