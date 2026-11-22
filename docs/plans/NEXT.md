# Rumbo: next steps

The build of `real-app.md` is split into sessions, each sized to fit one context. Each session:
1. reads `CLAUDE.md`, this file, and only the sections of `real-app.md` listed for it;
2. does its scope, with tests;
3. updates this file before it ends: ticks its row, fills in its hand-off (what was done, decisions, what is left), and leaves the next session's notes.

**The owner won't use Rumbo until every session here is done** (said 2026-11-22). A step in between doesn't need to be usable day to day: build the lean version that the next session can build on, keep the tests, and spend nothing on polish or interim conveniences.

## Sessions

| # | Plan step | Scope | Read in `real-app.md` | Status |
|---|---|---|---|---|
| 1 | 0, 1 | Rename in the docs, history check, build, service worker, deploy workflow, `gitobj.js`, `remote-github.js` (read side), `vault-files.js`, device-check page | §1, §2, §3 (Remote, Auth, Git objects, Which files), §10 | **done** |
| — | owner | Commit, create the repo, Pages, token, device checks, folder rename (below) | — | **done** |
| 2 | 2 | The app, read-only and offline (below) | §2, §3 (replica, Pull, engine), §4 (read side), §9 | **done** |
| 3 | 3 | Blank lines: the gap model in `org-edit.js`, `applyOp` and serialisable ops, invariants, `tools/spacing-report.mjs`, `tools/vault-check.mjs`, property tests. The owner then reviews the spacing report. | §5, §8 (Blank lines) | **done** |
| — | owner | Review the spacing report (below) | — | **done** |
| 4 | 4a | `tests/fake-github.mjs` (its write side; session 2 made the read side) and the scenario harness (the Emacs actor, a second replica), then local commits (folding edits 3 s apart), push, the lost-response and interrupted-sync cases | §3 (Commit and push, engine, edge cases), §8 (fake, scenarios) | **done** |
| 5 | 4b | Rebase (replay, then node-diff3), the conflict screen, rescue branch, reset, the zip, seeded random interleavings, `tools/e2e-github.mjs` | §3 (rebase), §4, §8 | next |
| 6 | 5 | Obsidian notes: `notes.js`, carrel's Markdown module, wiki links, embeds, footnotes | §6 | |
| 7 | 6 | Task icons (a session in `agentic-org-planner`), then hardening on the devices | §7, §9 (iOS details) | |

## Later (after the sessions above)
- **Sync details from Settings** (the owner, 2026-11-22): a way from Settings to fuller sync statistics. The Sync page is reachable from Settings already; this would add more (merge commits counted, rate-limit use, pull timings, history per file).

### Session 2 in more detail (done)
- `app/` becomes the real app: copy the prototype modules (`org.js`, `inline.js`, `workspace.js`, `org-edit.js`, `edits.js`, `data.js`, the UI modules, the CSS), drop the harness, keep `prototype/` as it is.
- Move the device check to `app/check/` (it becomes Diagnostics) and keep it working; the app takes `index.html`.
- `store.js`: the `rumbo` IndexedDB of §3 (meta, files, pending, settings, log), one transaction per change, the 2 s guard (the check page has a small version of it in `check.js`). Tests on `fake-indexeddb`, added as a devDependency (`npm install` then needed for those tests; CI runs `npm ci`).
- `sync.js`, pull only: head with ETag, compare, tree, blobs for changed SHAs, one transaction; "diverged" stops and asks. Triggers and backoff as in §3.
- `data.js` builds the model from the store; the first paint needs no network.
- Setup: repo, branch, token, **token expiry date or "no expiry"** (GitHub's expiry header can't be read in a browser; the owner's token has no expiry, §3 Authentication), device name; `persist()` after Setup succeeds. The Diagnostics page keeps the check page's "no expiry" box.
- The read side of the Sync page; the last place restored on reopen; "Update Rumbo" in Settings, using `pwa.js`.
- Self-host the fonts and Material Symbols (OFL / Apache 2.0, licences beside them); the CSP then needs nothing beyond `'self'` and `api.github.com`.
- Check the prototype's inline styles against the CSP (`style-src 'self'` forbids `style="…"` attributes in HTML; setting `el.style` from script is fine).
- The Android report backs the plan's sizing: a first clone of the whole vault is about 1 MB in about 4 s, and polling an unchanged head is a free 304. The owner's token has no expiry; the 2060-11-01 in the Android report stood for that, before the check page had a "no expiry" box.
- Don't trust `navigator.onLine`: on Android it said "online" with every radio off (§3, the sync engine). The Sync page's "offline" comes from the failure class of the last request.

## For the owner: the spacing review (after session 3)

Run, in this folder:
```sh
node tools/spacing-report.mjs > /tmp/spacing.txt   # read-only; don't commit the output
```
It shows the blank-line habit of each cell, counted from the vault, then the headings that go against their cell's majority as `file:line — cell — has/lacks a blank`, then the count per file. For each one, fix in Emacs what was accidental and leave what was meant. Leaving one costs nothing: Rumbo keeps a heading's own blank lines when edits around it leave it in the same kind of place, and the rule only decides for new or moved headings. After the review (2026-11-22) the list holds 4: three in `Inbox.org` (messy by design, ignored) and `ML/Deep_Learning.org:450`, a section after a closed subtree with no blank line where 6 of 7 have one.

**Done** (2026-11-22): the owner fixed the accidental ones in Emacs and kept the meant ones, which shaped the cells: a section set off after a run of tasks (`sibling-section`), a task after its section's description at any depth (`parent-prose`), and one cell per shape whatever the level.

## For the owner, before session 2

1. ~~**Commit** session 1.~~ Done.
2. ~~**History.**~~ Settled: the repo is public with its history as it was.
3. ~~**Create the repo and turn on Pages.**~~ Done: the repo is public and the site is live. For reference:
   ```sh
   gh repo create rumbo --public --source . --push
   gh api -X POST repos/{owner}/rumbo/pages -f build_type=workflow
   ```
   The push runs `.github/workflows/deploy.yml`; the site appears at `https://<owner>.github.io/rumbo/`.
   `CLAUDE.md` stays private: it is excluded in `.git/info/exclude`, not `.gitignore`.
4. ~~**Make the token**~~ Done (the vault repo with *Contents: read and write*, the Obsidian repo with *Contents: read-only*). It has no expiry: tick "The token has no expiry" on the check page on each device.
5. **Finish the device check**, each **from the Home Screen** (the Home Screen app has its own storage, so set it up there), then add the reports under "Device reports" below. What is left:
   - ~~**Android phone:**~~ Done (the offline reopen, 18:47–18:48: served by the service worker, GitHub unreachable).
   - ~~**iPad 11":**~~ Done: the owner ran the network checks (the report wasn't pasted).
   - ~~**iPad mini:**~~ Taken as passing: it is an iPad mini 6 on the same iOS as the iPad 11"; only the screen differs (744×1133).
6. **Rename the folder** (after the last session in the old folder ends):
   ```sh
   mv ~/projects/products/plan-viewer ~/projects/products/rumbo
   mv ~/.claude/projects/-Users-anton-projects-products-plan-viewer ~/.claude/projects/-Users-anton-projects-products-rumbo
   ```

## Hand-off

### Session 4 (2026-11-22)
**Done**
- `tests/fake-github.mjs`, write side:
  - blobs, trees with `base_tree` (a `sha: null` entry deletes), commits, the ref update (fast-forward only, else 422, as with `force: false`) and `POST /git/refs`;
  - `fail({after: true})`: the request is carried out and its answer lost;
  - `beforeRequest(n, method, path)` for another writer;
  - `filesAt`, `log`, `ref` for assertions.
- `remote-github.js`, write side: `createBlob` (its SHA checked against the local hash), `createTree`, `createCommit`, `makeCommit(parent, baseTree, files, message)`, `updateRef`, `createBranch`. `commit(sha)` stays the read.
- `store.js`, local commits:
  - `recordEdit` (the working text and the commit in one transaction; folding under 3 s; refused as `stale` unless `before` is the stored working text);
  - `undoEdit`, `seal`, `noteAttempt`, `markPushed`, `pending`;
  - `applyPull` now allows pending commits when it touches none of their files (`pending-changed` otherwise).
  - The record is in §3 (`parts`, `ctx`, `sealed`, `attempt` added). No schema change.
- `commits.js`: messages from ops; `editRecord`, shared by `edits.js` and the test harness; `saveContext` and `restoreContext`. Only the edge memory beyond what the commit's text gives is stored.
- `sync.js` `syncOnce`:
  - head;
  - settle lost answers;
  - pull with rebase step 1 (`conflict` when a touched file changed upstream);
  - push in order: seal, commit, attempt, ref update, `markPushed`;
  - a refused ref update starts the sync again, up to 3 times.
  The engine runs `syncOnce`; `conflict` is a stop.
- `edits.js`: the prototype's save, journal and 409 handling are gone. Edits and undo go through one ordered write queue to the store. A refused write shows "Not saved on this device" and rebuilds the page from the store. `data.js` sets `writable: true`. The app pushes 3 s after the last stored edit, and `reloadModel` waits for queued writes. The Sync page lists the local commits and the push log lines.
- Tests: 152 pass with `npm install`. New: `commits`, `scenarios` (15 scenarios, built on `tests/scenarios.mjs`), and the store's and remote's write sides.
  - The kill test stops a sync at every request (before it and after it is carried out), with and without a pull first, restarts from IndexedDB and settles. Each edit is on `main` exactly once, the history is a line, and the replica matches `main`.
  - Emacs pushes before every request of a sync.
  - Two devices edit offline.
  - A lost answer, also with Emacs on top; a 502 and a 401 on the push; a force-push with commits waiting.
- Checked in WebKit, served under `/rumbo/` against the fake, with the sample vault:
  - Setup; a Done and a Move made 0.5 s apart became one commit, "Rumbo: 2 edits in Career (iPad)";
  - Undo after that push became "Rumbo: Undo: Move …";
  - with pushes failing, the Sync page showed "1 not pushed", and "Check now" pushed it;
  - screenshots at the three sizes; the only console errors were the injected 503s.
- `vault-check` on the real vault: no failures.

**Findings and decisions**
- The plan's `commit(parent, files, message)` is `makeCommit`, because `commit(sha)` already reads one.
- A sealed commit is never folded into or popped by undo. An undo of an edit in a sealed or pushed commit is a new opaque commit with the old text (no ops), which session 5 must send straight to the 3-way merge.
- Edits that cancel out within one fold window (down, then up) leave no commit.
- The base commit after a push is recorded with author "Rumbo" and the device's time. GitHub's history list shows the real author.
- Testing note: in Playwright's sync Python API, `time.sleep` blocks the route handlers, so routed requests time out as "Load failed". Use `page.wait_for_timeout`. A scratch server for the fake must answer `OPTIONS` with CORS headers, as GitHub does, because writes are preflighted.

**Left for session 5**
- Replace the `conflict` stop in `pullTo` (`sync.js`, "Rebase, step 1 only") with the full rebase, per pending commit and file:
  - replay `ops`, with `restoreContext(ctx[path], doc)`;
  - else node-diff3 on `before`, `after` and the upstream text;
  - else the conflict screen.
  `applyPull` must then accept rebased commits for touched files in the same transaction. Today it refuses them, and that refusal is the guard.
- An opaque part (an undo) has no ops, so a commit holding one can't be replayed. Go straight to diff3 for it.
- The seeded random interleavings fit on `tests/scenarios.mjs` (`replica`, `edit`, `emacs` via `gh.push`, `settle`, `converged`).
- The rescue branch can use `remote.createBranch` and the commits' `files.after`; the fake already supports it.
- The edit-UI toast kinds `saved`, `saving` and `memory` are no longer used, and can go when the toast is next touched.

### Session 3 (2026-11-22)
**Done**
- `app/spacing.js`, the Emacs blank-line model in JS:
  - every line in exactly one slot: bof, the preamble, per heading the run before it, the heading line, its lead and its opaque body, then eof;
  - the rule cells, counted from the vault (`countSpacing`, `predict`);
  - the edge memory.
  - `data.js` puts the counts on `model.spacing`.
- `app/org-edit.js`: insert, delete, move, removeDone and the cross-file pair are rebuilt as cut and insert on that sequence of blocks. Only the seams they create are resolved, in this order: the old neighbours' run, a bare heading's lead, the edge memory, the rule, keep. The span edits (heading, planning, notes) and promote and demote are as they were. The old `removalSpan`, `insertChunk` and `chain` are gone.
- `app/ops.js`:
  - `{path, op, key, args, v: 1}`, with `makeOp`, `targetArg` and `keyOf`;
  - `applyOp` and `applyOps`;
  - `checkResult`, the four invariants of §5 checked against a content-only model of each op, independent of the edit code;
  - `OpError` with `lost`, `invalid` and `invariant`.
- `edits.js`: `edit(path, label, build)` takes `(doc) => ops`; the journal holds ops, and a per-file edge memory sits beside them. `editTwo` takes the extract and insert pair. Every call site in `edit-ui.js` and `outline.js` builds ops. The model is still never `writable`.
- Tools (read-only, output never committed), with the cases both of them run in `tools/op-cases.mjs`:
  - `tools/spacing-report.mjs` and `tools/vault-check.mjs`;
  - `tools/vault.mjs`: the vault path in the same order as `serve.py`, the files as `vault-files.js` picks them.
- Tests: 120 pass with `npm install`.
  - New: `spacing`, `ops`, the app's `org-edit` (the cases from the Emacs design are in it), and `edit-properties`. The last runs every op on every heading of the sample vault and of 300 generated outlines per run with fast-check, a new devDependency.
  - `org.test.mjs` now imports from `app/`. The old edit tests are kept as `prototype-org-edit.test.mjs`, against the frozen prototype.
- **Real vault, checked read-only:**
  - `vault-check`: 35 files, 3,500 headings, every op and every round trip passed (moving or extracting a heading and putting it back, and a state change and back, all give the original bytes). No failures; 74 s.
  - `spacing-report`: the cells reproduce the §5 table exactly (level 2 after a closed subtree 191 of 198; after the parent's text 147 of 174; siblings 14 of 1,134; level 3 27 of 1,274). With the section cells, 66 headings go against their cell.
- Checked in WebKit against the fake GitHub, served under `/rumbo/` (Setup, first pull, then in edit mode: move down, delete, add a task, the task dialog), with no console errors; screenshots at the three sizes.

**Findings and decisions**
- After the owner's review (same day), two changes to §5:
  - **A heading that stayed where it was, in the same kind of place (its rule cell), keeps its own blank lines.** The rule decides only for new or moved headings, or ones now in a different kind of place. Before this, swapping two tasks above `** Activation functions` in Deep_Learning.org deleted the blank line before the section. Where the heading before it is taken out, the longer run stays (on a tie, its own).
  - **Sections are counted apart from tasks** after a sibling (`sibling-section`; the plain sibling cells now count tasks).
  - **One cell per shape below level 1, at any depth.** Once the owner had made the vault consistent, every shape agreed at levels 2, 3 and 4, and level 4 and deeper had too few examples to stand alone (a task after its section's description there was flagged against the task-after-task majority). The report went from 75 exceptions to 4. Test fixtures that meant tasks now say `TODO`.
- The cells started as Emacs's, with `l3+` split into `l3` and `l4+`; the review then split level 3 by shape (above). Leads are never counted, so "first child under a bare parent" isn't a cell, which is why the plan's 79 became 75.
- The plan's "known edge" needed a memory to make "move back" exact. The edge memory is keyed by identity (title and own notes), so state and level changes don't break it. For replay, session 5 should pass the memory of the commit's base text.
- A bare parent that loses its only child loses its lead (the run becomes a boundary gap). When a child comes back, the lead is taken from the memory. This was found by the property tests.
- `setHeading`, `extractSubtree` and `insertSubtree` were added to the op list. The dialog orders its ops planning, then notes, then heading.
- "Keep" fires only for a cell with fewer than 5 examples. In the real vault that is only `l2-after-preamble`, which has one.
- A new heading's notes lose leading and trailing blank lines (`insertHeading`).
- Testing notes: headless WebKit's hit test reports `<html>` over every element here, even with `force`. The scratch run used DOM `click()` instead, and set the "no expiry" box from script. A file opens with `?view=file&file=…`.

**Left for later sessions**
- Session 4: local commits from the journal's ops; set `writable`; keep the edge memory and the rule with each pending commit, so a replay resolves seams as the edit did. `save()` and `/api/save` in `edits.js` are still the prototype's.
- Session 7 (or with Diagnostics): show the counted cells in the app (§5 asks for it; the report prints them now).
- `rebuildFile` doesn't recount `model.spacing` after an edit; the next load does.

### Session 2 (2026-11-22)
**Done**
- `app/` is the app. The prototype modules were copied in without the harness, and `prototype/` is unchanged. The device check moved to `app/check/` (Diagnostics, linked from Settings) and keeps its own `rumbo-check` database.
- `store.js`, `sync.js` (pull and the engine), `data.js` (`buildModel` from the replica), `setup.js` and `sync-ui.js`, as listed in `CLAUDE.md`. Opening the app paints from IndexedDB, then syncs. The sync mark shows in the header only when not synced: muted when offline or waiting, accent-coloured when the owner is needed.
- Setup is prefilled from the device check's saved settings, so each device needs no retyping. `persist()` is called after the first pull succeeds.
- Settings has the theme, tablet nav (rail or drawer, now a setting), Sync, the token line (no expiry, or a warning two weeks ahead), the device name, Diagnostics, the version, and "Update Rumbo" with a dot on the Settings row. The update waits until no sync is running.
- The last place (view, file, focus by title path, fold, the top row) is saved and restored when the app opens with no query.
- Fonts are self-hosted in `app/fonts/` (5.5 MB, 4 MB of it Material Symbols, which is kept whole because `workspace.org` may name any icon). The CSP is `'self'` plus `api.github.com`. `h()` sets `style` through the CSSOM.
- Tests: `store`, `sync` (pull against the fake and the engine with fake timers), `data`, and more build checks (CSP, no `style=`, fonts and `check/` precached). 81 pass with `npm install`; without it the 14 IndexedDB tests skip. CI runs `npm ci`.
- `tests/fake-github.mjs`, read side: git-hashed blobs, trees and commits, ETag and a free 304, `compare`, the commit list, injected failures. `push()` and `forcePush()` act as another writer.
- Checked in a browser against the fake, served under `/rumbo/`. In Chromium: Setup → first pull → agenda; the place restored; an upstream commit picked up on focus; an offline reopen paints from the replica with the offline mark, which clears when back online; the Sync page; Diagnostics. In WebKit: screenshots at the three sizes, with no console errors.

**Findings and decisions**
- Editing works on the page only, with a toast that says it isn't saved (the model is never `writable`); the swipe variant isn't on yet. Session 4 joins swipe and edit mode and writes local commits.
- A pull is refused at the store while `pending` has commits, so session 4 must rebase before applying a pull.
- A `behind` compare (the branch reset to an older commit) is treated as `diverged`. A base that GitHub no longer knows (404 on compare) is too.
- Not-UTF-8 files are kept (decoded with replacement) and marked read-only, as are CR files.
- "Reset to GitHub" exists for `diverged` and is refused while anything is pending. The rescue branch and the zip are session 5.
- Testing notes: Playwright can't fulfil a 304 through a route, so the scratch test asked unconditionally. WebKit's routes don't see requests from a page controlled by the service worker, so WebKit runs need `service_workers="block"`. WebKit logs "Refused to apply a stylesheet" for Playwright's own screenshot style; that message is not the app's.
- On the devices: the old worker keeps serving the check page until "Update Rumbo" is tapped there; then the app opens to a prefilled Setup.

**Left for later sessions**
- Session 3 can start straight away. It works in `app/org-edit.js` (the copy), leaving `prototype/org-edit.js` alone. The tests in `tests/org*.test.mjs` import from `prototype/`: point them at `app/`, and keep a prototype run only if the prototype is to stay in step.
- Session 4: `edits.js` still has the prototype's `save()` and `/api/save`, which are never reached. Replace them with local commits through `store.js`, and set `writable` in `data.js`.
- The Obsidian repo and vault name are stored at Setup (`settings` → `obsidian`) for session 6.

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

**Summary (2026-11-22)**
- **Android phone** (Chrome 157, Android 10): every check passes from the Home Screen. Head in 0.9 s, a 304 on an unchanged head, rate-limit headers readable, all 36 files (35 agenda files plus `workspace.org`, 1 MB) in 3.8 s with no SHA mismatches, no CR line endings and no non-UTF-8 files, and 1,359 Obsidian notes indexed in 2.6 s. The Obsidian link opens the right note, cold and warm. The offline reopen works too (second report): with every radio off, four opens from the Home Screen were served by the service worker and GitHub could not be reached. **But Chrome still reported `navigator.onLine` as true**, so each open was logged as "online". The check page now also records whether each open reached GitHub.
- **iPad 11"** (Safari 26.6.1): the service worker, IndexedDB, persistent storage (38 GB quota), the offline reopen (`OFFLINE sw home-screen`) and the Obsidian link all pass. The network checks were run later and passed (report not pasted).
- **iPad mini 6:** not run separately; the same iOS and Safari as the iPad 11".
- `.ps/task-icons.json missing` is expected: Emacs starts writing it in session 7 (§7).
- **Real sizes:** the iPad 11" is 820×1180 (820×1148 from the Home Screen), not 834×1210 (that is the iPad Pro 11"). The phone is 393×851 (392×790 from the Home Screen), not 412×915. `CLAUDE.md`'s screenshot sizes are updated to match. The prototype's `frame` presets keep the old sizes.

**Android phone**
```
Rumbo device check, 2026-11-22T17:46:34.637Z
Build: 0.1.0 (f5f02c2cca)

✓ Secure context (needed for the service worker and hashing) — https://anton-dergunov.github.io
✓ Opened from the Home Screen — standalone
· Device — Linux armv81; touch points 5; screen 393×851 @2.75x; window 392×790; Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Mobile Safari/537.36
✓ crypto.subtle available (blob SHAs)
✓ Service worker serves the page — cache rumbo-0.1.0-f5f02c2cca
✓ IndexedDB keeps data between opens — 3 open(s) recorded; open it again to confirm
✓ Persistent storage granted — yes
✓ Read the branch head — 7c0d778 in 929 ms
✓ Find and fetch a note by its name — 1359 notes indexed in 2.6 s; 0 name clashes; note fetched, 14 KB in 593 ms; SHA matches
✓ Unchanged head comes back as 304 (free polling) — ETag sent
✓ Rate-limit headers readable — 4854 of 5000 left this hour
· Token expiry header readable — no (expected: GitHub's CORS policy hides it); entered here: 2060-11-01
✓ Read the whole file list — 42 files; 35 agenda files; workspace.org found; .ps/task-icons.json missing
✓ Download every agenda file and check its SHA — 36 files, 1014 KB in 3.8 s; SHA mismatches 0; not UTF-8 0; with CR line endings 0; 4814 requests left this hour

Opens:
  2026-11-22T17:16:00.736Z online net browser
  2026-11-22T17:42:29.515Z online sw home-screen
  2026-11-22T17:44:30.453Z online sw home-screen

Obsidian link:
  obsidianCold: opened the right note
  obsidianWarm: opened the right note
```

**Android phone, offline reopen** (every radio off; the opens from 18:47 on)
```
Rumbo device check, 2026-11-22T18:50:34.547Z
Build: 0.1.0 (f5f02c2cca)

✓ Secure context (needed for the service worker and hashing) — https://anton-dergunov.github.io
✓ Opened from the Home Screen — standalone
· Device — Linux armv81; touch points 5; screen 393×851 @2.75x; window 392×790; Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Mobile Safari/537.36
✓ crypto.subtle available (blob SHAs)
✓ Service worker serves the page — cache rumbo-0.1.0-f5f02c2cca
✓ IndexedDB keeps data between opens — 8 open(s) recorded; open it again to confirm
✓ Persistent storage granted — yes
✗ Read the branch head — offline: GitHub can't be reached. Edits stay on this device until it can. (Failed to fetch)
✗ Find and fetch a note by its name — offline: GitHub can't be reached. Edits stay on this device until it can. (Failed to fetch)

Opens:
  2026-11-22T17:16:00.736Z online net browser
  2026-11-22T17:42:29.515Z online sw home-screen
  2026-11-22T17:44:30.453Z online sw home-screen
  2026-11-22T18:21:58.880Z online sw browser
  2026-11-22T18:47:52.870Z online sw home-screen
  2026-11-22T18:48:08.050Z online sw home-screen
  2026-11-22T18:48:24.209Z online sw home-screen
  2026-11-22T18:48:42.729Z online sw home-screen

Obsidian link:
  obsidianCold: opened the right note
  obsidianWarm: opened the right note
```

**iPad 11"**
```
Rumbo device check, 2026-11-22T17:36:33.253Z
Build: 0.1.0 (f5f02c2cca)

✓ Secure context (needed for the service worker and hashing) — https://anton-dergunov.github.io
✓ Opened from the Home Screen — standalone
· Device — iPad (reports MacIntel with touch); touch points 5; screen 820×1180 @2x; window 820×1148; Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Safari/605.1.15
✓ crypto.subtle available (blob SHAs)
✓ Service worker serves the page — cache rumbo-0.1.0-f5f02c2cca
✓ IndexedDB keeps data between opens — 2 open(s) recorded; open it again to confirm
✓ Persistent storage granted — yes; using 178 KB of 38.4 GB

Opens:
  2026-11-22T17:29:07.954Z online net home-screen
  2026-11-22T17:34:49.003Z OFFLINE sw home-screen

Obsidian link:
  obsidianCold: opened the right note
  obsidianWarm: opened the right note
```
