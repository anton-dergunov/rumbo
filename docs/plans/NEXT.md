# Rumbo: next steps

The build of `real-app.md` is split into sessions, each sized to fit one context. Each session:
1. reads `CLAUDE.md`, this file, and only the sections of `real-app.md` listed for it;
2. does its scope, with tests;
3. updates this file before it ends: ticks its row, fills in its hand-off (what was done, decisions, what is left), and leaves the next session's notes.

## Sessions

| # | Plan step | Scope | Read in `real-app.md` | Status |
|---|---|---|---|---|
| 1 | 0, 1 | Rename in the docs, history check, build, service worker, deploy workflow, `gitobj.js`, `remote-github.js` (read side), `vault-files.js`, device-check page | §1, §2, §3 (Remote, Auth, Git objects, Which files), §10 | **done** |
| — | owner | Commit, create the repo, Pages, token, device checks, folder rename (below) | — | **to do** |
| 2 | 2 | The app, read-only and offline (below) | §2, §3 (replica, Pull, engine), §4 (read side), §9 | next |
| 3 | 3 | Blank lines: the gap model in `org-edit.js`, `applyOp` and serialisable ops, invariants, `tools/spacing-report.mjs`, `tools/vault-check.mjs`, property tests. The owner then reviews the spacing report. Independent of session 2; the two can swap. | §5, §8 (Blank lines) | |
| 4 | 4a | `tests/fake-github.mjs` and the scenario harness (the Emacs actor, a second replica), then local commits (folding edits 3 s apart), push, the lost-response and interrupted-sync cases | §3 (Commit and push, engine, edge cases), §8 (fake, scenarios) | needs 3 |
| 5 | 4b | Rebase (replay, then node-diff3), the conflict screen, rescue branch, reset, the zip, seeded random interleavings, `tools/e2e-github.mjs` | §3 (rebase), §4, §8 | needs 4 |
| 6 | 5 | Obsidian notes: `notes.js`, carrel's Markdown module, wiki links, embeds, footnotes | §6 | |
| 7 | 6 | Task icons (a session in `agentic-org-planner`), then hardening on the devices | §7, §9 (iOS details) | |

### Session 2 in more detail
- `app/` becomes the real app: copy the prototype modules (`org.js`, `inline.js`, `workspace.js`, `org-edit.js`, `edits.js`, `data.js`, the UI modules, the CSS), drop the harness, keep `prototype/` as it is.
- Move the device check to `app/check/` (it becomes Diagnostics) and keep it working; the app takes `index.html`.
- `store.js`: the `rumbo` IndexedDB of §3 (meta, files, pending, settings, log), one transaction per change, the 2 s guard (the check page has a small version of it in `check.js`). Tests on `fake-indexeddb`, added as a devDependency (`npm install` then needed for those tests; CI runs `npm ci`).
- `sync.js`, pull only: head with ETag, compare, tree, blobs for changed SHAs, one transaction; "diverged" stops and asks. Triggers and backoff as in §3.
- `data.js` builds the model from the store; the first paint needs no network.
- Setup: repo, branch, token, **token expiry date** (GitHub's expiry header can't be read in a browser), device name; `persist()` after Setup succeeds.
- The read side of the Sync page; the last place restored on reopen; "Update Rumbo" in Settings, using `pwa.js`.
- Self-host the fonts and Material Symbols (OFL / Apache 2.0, licences beside them); the CSP then needs nothing beyond `'self'` and `api.github.com`.
- Check the prototype's inline styles against the CSP (`style-src 'self'` forbids `style="…"` attributes in HTML; setting `el.style` from script is fine).

## For the owner, before session 2

1. **Commit** session 1 (message suggested at the end of the session).
2. **History.** Before going public, decide on what the check found (session 1 hand-off below). Commits already use the GitHub noreply address.
3. **Create the repo and turn on Pages:**
   ```sh
   gh repo create rumbo --public --source . --push
   gh api -X POST repos/{owner}/rumbo/pages -f build_type=workflow
   ```
   The push runs `.github/workflows/deploy.yml`; the site appears at `https://<owner>.github.io/rumbo/`.
   `CLAUDE.md` stays private: it is excluded in `.git/info/exclude`, not `.gitignore`.
4. **Make the token** (GitHub → Settings → Developer settings → Fine-grained tokens): the vault repo with *Contents: read and write*, the Obsidian repo with *Contents: read-only*, an expiry date you note down.
5. **Run the device check** on the iPad 11", the iPad mini and the Android phone, each **from the Home Screen** (the Home Screen app has its own storage, so set it up there): follow the steps on the page, including the Airplane-mode reopen and the Obsidian link, then paste each report under "Device reports" below.
6. **Rename the folder** (after the last session in the old folder ends):
   ```sh
   mv ~/projects/products/plan-viewer ~/projects/products/rumbo
   mv ~/.claude/projects/-Users-anton-projects-products-plan-viewer ~/.claude/projects/-Users-anton-projects-products-rumbo
   ```

## Hand-off

### Session 1 (2026-11-22)
**Done**
- Docs say Rumbo (`CLAUDE.md`, `README.md`, `real-app.md`); this file.
- `app/`: the device-check page (`index.html`, `check.js`, `check.css`), `gitobj.js` (blob SHA, base64), `remote-github.js` (read side: `head` with ETag, `tree`, `blob`, `raw`, `commit`, `compare`, `log`; failure classes; 15 s timeout), `vault-files.js` (the Emacs file rules), `sw.js`, `pwa.js`, `version.js`, the manifest and a compass icon (`icons/icon.svg`, PNGs from `tools/render-icons.py`), `tokens.css` copied from the prototype.
- `tools/build.mjs` → `dist/` with the version and the precache list stamped; `.github/workflows/deploy.yml`; `package.json` (no dependencies).
- Tests: `gitobj`, `remote-github` (fake fetch), `vault-files`, `pwa-build` (the §2 rules), `sw` (the built worker run against a fake scope). 55 pass.
- Checked in a browser, served under `/rumbo/`: the second open is served by the worker; an offline reload works; a new build waits until "Update Rumbo" is tapped, then replaces the old cache; the network checks run cleanly against a faked API made from the sample vault; no page errors at the three device sizes.

**Findings and decisions**
- `api.github.com` exposes `ETag` and the `X-RateLimit-*` headers to browsers but **not** `github-authentication-token-expiration`. Setup asks for the expiry date instead (`real-app.md` §3 updated).
- Two failure classes added to §3: `missing` (404, including a private repo the token can't see) and `rejected` (409/422, e.g. a ref update that is not a fast-forward).
- `head()` fetches with `cache: "no-store"`, so the app's own `If-None-Match` decides freshness and a 304 reaches the code.
- The build hash covers every file except `sw.js` and `version.js`, so the cache name changes exactly when the shell does.
- The check page stores its settings in its own database, `rumbo-check`, so the app's `rumbo` schema starts clean.
- History check: no personal paths, emails or tokens in the 13 commits; no images. Lines that also occur in the real vault: the explanatory text and tag definitions in the sample `workspace.org` (generic config prose), two public URLs, a book title, `#+TIMEZONE: Europe/London`, and one real task in `tests/org.test.mjs`, now replaced with synthetic text (it remains in the history). Your call whether that is fine to publish as is, or whether to squash the history into one commit first.

**Left for later sessions**
- The write methods of `remote-github.js` (blobs, trees, commits, `updateRef`, `createBranch`) come with session 4, against the fake GitHub.

### Device reports
*(Paste each device's report here.)*
