# Vendored libraries

Copied once from their npm packages, so the app and its tests need no install or bundler. Each licence sits beside its file.

| File | Package | From | Licence | Use |
|---|---|---|---|---|
| `diff3.mjs` | node-diff3 3.2.1 | `dist/diff3.mjs`, without its source-map comment | MIT (`diff3.LICENSE.md`) | The 3-way merge of a rebase, diffs and conflict hunks (`merge.js`) |
| `fflate.js` | fflate 0.8.3 | `esm/browser.js`, unchanged | MIT (`fflate.LICENSE`) | The "Download everything" zip (`rescue.js`); only `zipSync` is used, so its worker code never runs |

To update one: `npm pack <package>@<version>`, unpack it, copy the same file and the licence here, and run `npm test`.
