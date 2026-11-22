# Rumbo: the real app

*Rumbo* is Spanish for "course, heading, bearing": a plan is a heading to steer by, and Org files are made of headings. It is the new name of Plan Viewer. The repo had no GitHub remote before, so step 0 creates it as `rumbo`; the local folder is renamed after that session. The work is split into sessions, tracked in `NEXT.md` beside this plan.

This plan turns the prototype into the app used every day: offline-first, read-write, on the iPad 11" and iPad mini (first), a large Android phone, perhaps an Android e-ink reader, and later the Mac. The look and the editing design are settled (CLAUDE.md, "Settled design"); this document settles how the app is built, deployed and synced, and how it edits without disturbing the files.

The two parts that matter most, and get the most care and tests, are **sync** (§3) and **blank lines** (§5).

Sibling projects are cited by name (`agentic-org-planner/…`, `calorie-logger/…`). They are the owner's own repos and are meant to be reused.

## 1. Decisions

| Question | Decision |
|---|---|
| Platform | A PWA on every device |
| Hosting | GitHub Pages, from this repo made public |
| Source of truth | The vault's git repo on GitHub, through the GitHub REST API |
| Local copy | A full replica in IndexedDB; the app opens from it with no network |
| Unpushed edits when GitHub moved on | Rebase them: linear history, one commit per edit |
| Emacs | Keeps its merge-based sync; no change, except one addition for task icons |
| Blank lines | The Emacs ownership model (lead / boundary gaps), with the spacing rule fitted from the vault |
| Obsidian links | The note is shown in the app (online, read-only), with "Open in Obsidian" |
| Task icons | Emacs commits a copy of its icon cache into the vault |
| Name | Rumbo |

## 2. Platform, hosting and updates

### Why a PWA
- iOS without a paid developer account has no durable native install: a self-signed app expires after 7 days.
- Android installs a PWA as a WebAPK, a real entry in the app list. A TWA or an APK would add signing keys and sideloading for every update; Acervo evaluated this and decided against it (`acervo-llm-dictionary/docs/plans/capture-transports.md`).
- The Mac can later use Safari's "Add to Dock". Emacs stays the desktop editor.

### Hosting on GitHub Pages
- Free Pages needs a public repo. The repo already holds no personal data (CLAUDE.md, "Data rules"). Before it goes public, check the whole history for personal paths and vault text.
- The address will be `<user>.github.io/rumbo/`.
- **The origin is chosen once.** Storage, the token and unpushed edits all belong to the origin. Moving to another address loses them on every device. An iOS Home Screen app also has storage separate from Safari's, so set it up from the Home Screen app itself.
- Notes never pass through Pages. Pages serves only the app's code; the vault goes directly between the device and `api.github.com`.
- The deploy workflow follows `vim-wilds/.github/workflows/deploy.yml`:
  - on push to `main`, run the tests, build, then `upload-pages-artifact` and `deploy-pages`;
  - every URL is relative to the base (vim-wilds `appUrl()`), so the app works under `/rumbo/` and on a local server alike.

### Updates
- The service worker is hand-written and build-free, like vim-wilds':
  - It precaches the whole shell under a cache named by a hash of its files (`rumbo-<version>-<hash>`).
  - It serves the shell cache-first and never caches API responses.
  - It does not precache a 404 page, and precaches pages under their directory URLs.
- **The app never updates itself under the user.** A new version downloads quietly and waits. A dot on Settings offers "Update Rumbo", which applies it only when no sync is running. No automatic `skipWaiting()` or `clients.claim()`. This is the calorie-logger and Acervo rule: a new worker that activates on its own reloads the page under whoever is typing (`calorie-logger/AGENTS.md`).
- The page calls `registration.update()` on `visibilitychange` and hourly.
- A build test asserts the rules above: no automatic activation, manifest at the root, relative URLs, the whole shell precached (`calorie-logger/scripts/verify-pwa.py`, `vim-wilds/tests/pwa-build.test.mjs`).
- The local database has its own schema version. A change that would drop unpushed edits is never allowed: if pending commits exist, they are migrated or pushed first. Wiping and re-pulling, as calorie-logger does, is allowed only when nothing is pending.

### Build and libraries
- Source stays plain ES modules with no bundler, as in the prototype. `node --test` runs without `npm install`.
- `tools/build.mjs` copies `app/` to `dist/`, stamps the version and writes the precache list with hashes.
- Vendored ES-module files, each with its licence beside it:

| Library | Use | Licence |
|---|---|---|
| marked | Markdown for Obsidian notes (via carrel's module) | MIT |
| DOMPurify | Sanitising rendered notes | Apache 2.0 / MPL 2.0 |
| node-diff3 | 3-way merge of a file | MIT |
| fflate | The "download everything" zip | MIT |

- Fonts and Material Symbols are self-hosted. Today they load from Google Fonts, which an offline app can't rely on.

### Device testing needs HTTPS
Service workers, `crypto.subtle` (for blob SHAs) and `navigator.storage.persist()` exist only in a secure context. `http://<laptop-ip>` from the iPad doesn't count. Use `tailscale serve --https=443` (as lectern does) or a Pages deploy.

## 3. Sync

### Why git, and through the API
Options considered:
- **Dropbox** (what beorg and Orgzly use). A PWA would need Dropbox OAuth. Dropbox has no history and no atomic multi-file write, and it leaves conflicted copies. Letting it sync `.git` once corrupted the repository (`agentic-org-planner/docs/Dropbox-and-git.org`).
- **The Mac or the Synology NAS as a server.** Works only while that machine is reachable, and needs a server to maintain. It stays possible later behind the same `Remote` interface (for example Gitea or Forgejo on the NAS).
- **Git on GitHub.** It already holds every version of every file. Emacs already commits and pushes every minute. Commits are atomic and leave no conflicted copies. It works with the Mac asleep, and every state has a name (a commit SHA) the owner can inspect and fix in Magit.

Git it is. In the browser, **isomorphic-git is ruled out**: github.com's git endpoints send no CORS headers, so it needs a proxy server. `api.github.com` does allow CORS, and its Git Data API (blobs, trees, commits, refs) is enough to read a tree and write real commits. No proxy, and no third party sees the vault.

### Remote interface
`remote-github.js` implements one interface, so another host can be added later:

| Method | GitHub call |
|---|---|
| `head()` | `GET /repos/{o}/{r}/git/ref/heads/{branch}` with `If-None-Match` |
| `tree(sha)` | `GET /git/trees/{sha}?recursive=1` |
| `blob(sha)` | `GET /git/blobs/{sha}` |
| `commit(parent, files, message)` | `POST /git/blobs` for each changed file, then `POST /git/trees` with `base_tree`, then `POST /git/commits` |
| `updateRef(sha)` | `PATCH /git/refs/heads/{branch}` with `force: false` |
| `compare(base, head)` | `GET /compare/{base}...{head}` (is the new head a descendant?) |
| `log(path?)` | `GET /commits?sha={branch}&path=…` |
| `createBranch(name, sha)` | `POST /git/refs` |

- Every request has a 15 s timeout (`AbortSignal.timeout`), as in calorie-logger.
- A `304 Not Modified` on a conditional request does not count against the rate limit (5,000 requests an hour with a token), so polling the head is free.

### Authentication
- A **fine-grained personal access token**, made once on GitHub and pasted into Setup (copy on the Mac, paste on the iPad through Universal Clipboard).
  - The vault repo: *Contents* read and write (*Metadata* read comes with it).
  - The Obsidian repo: *Contents* read only.
- OAuth's device flow is not possible from a browser: `github.com/login/*` has no CORS.
- The token is stored in IndexedDB on the device, in the app's origin.
- GitHub reports a token's expiry in the `github-authentication-token-expiration` response header, but its CORS policy doesn't expose that header to a browser (checked 2026-11-22). So Setup asks for the expiry date GitHub shows when the token is made, and Rumbo shows a warning two weeks ahead. A `401` means "sign in again", and nothing local is lost.
- **Tokens without an expiry are supported.** Setup offers "The token has no expiry" in place of a date (the owner's token is one). Rumbo then shows no expiry warning, and Settings says the token never expires and that revoking it on GitHub is how to cut off a lost device. A `401` still means "sign in again".
- Protecting the token:
  - a strict Content Security Policy;
  - no third-party scripts;
  - vault text only ever enters the page as text nodes (already a rule);
  - rendered Markdown goes through DOMPurify.

### The local replica
One IndexedDB database, `rumbo`:

| Store | Holds |
|---|---|
| `meta` | Repo, branch, **base commit** (the commit this device is at), base tree SHA, last check, last error, device name, schema version |
| `files` | Per path: the text at the base commit, its blob SHA, and the working text if it differs |
| `pending` | The **local commits** not yet pushed, in order (below) |
| `settings` | Theme, the Obsidian vault name and other per-device settings |
| `obsidian` | The note-name → path index, keyed by that repo's head |
| `log` | The last ~100 sync events |

A local commit is plain data:

```js
{
  id, created, message,          // "Rumbo: Done \"Book dentist\" (iPad)"
  base,                          // the commit SHA it was made on
  ops: [{ path, op, key, args, v }],   // serialisable edits (§5)
  files: { [path]: { before, after } } // text before and after, per file
}
```

Rules, most of them lessons from the sibling projects:
- **Each edit is one transaction**: the new working text and the new local commit, together (calorie-logger `localDatabase.ts`). A crash leaves either both or neither.
- **Every IndexedDB call times out after 2 s**, and the database is reopened on the next call. After a long time in the background, WebKit can leave a request unanswered forever, and every later one with it (lectern `reader.js`, `KEPT_WAIT`).
- `navigator.storage.persist()` is asked once, right after Setup succeeds (Acervo `dictionaryStore.ts`). Home Screen apps on iOS are exempt from Safari's 7-day storage cap. Eviction would cost only unpushed edits, because everything else is on GitHub.
- **Opening the app does no network work before the first paint** (calorie-logger `AGENTS.md`): it paints from the replica, then syncs.
- iOS reopens a Home Screen app at its start page, so the last place (view, file, focus, scroll) is saved in IndexedDB and restored (lectern `ac9468c`).

### Git objects on the device
`gitobj.js` computes a blob's SHA the way git does: `sha1("blob " + byteLength + "\0" + bytes)` with `crypto.subtle`. Comparing a remote tree with the replica then needs no downloads. The version of a file is its blob SHA; the prototype's own `sha256[:32]` goes.

### Which files
- The same rules as Emacs (`agentic-org-planner/lisp/ps-org-files.el:33-52`):
  - skip dot folders, `Journal/` and `Archive/`;
  - skip `init.org` and `workspace.org` as agenda files, and anything containing `conflicted copy`.
- `workspace.org` is downloaded too (icons, folder order, tag meanings), as is `.ps/task-icons.json` (§7).
- Files with CR line endings, or that fail to parse, are shown but read-only, as in the prototype.

### Pull
1. `head()` with the last ETag. On `304`, nothing changed.
2. If the head moved, `compare(base, head)`. If the new head does not descend from the base, the branch was rewritten (a force-push). **Stop and ask; never wipe** (Acervo `guardDataset`): offer "push my changes to a branch" and "reset to GitHub".
3. `tree(head)`. For each included file whose blob SHA differs from the replica's, `blob(sha)`. The first clone is one tree request plus about 37 blobs.
4. If nothing is pending, the new texts become the base and the working texts, in one transaction. If commits are pending, rebase (below) before anything is shown as current.

### Commit and push
- An edit becomes a local commit at once. Edits less than about 3 s apart are folded into one commit, so a burst of reordering is one commit, not ten.
- Messages are short and say what was done and where: `Rumbo: Done "Book dentist" (iPad)`, `Rumbo: Move 2 tasks to Errands (iPhone)`. Emacs writes `Auto backup: <time> (<host>)`, so the two are easy to tell apart in `git log`.
- **Push** takes the pending commits in order. For each: `commit(parent, files, message)`, then `updateRef` with `force: false`. One remote commit per local commit, so history is as fine-grained as the edits.
- After a successful ref update, that local commit leaves `pending` and its text becomes the base, in one transaction.

### When GitHub moved on: rebase
Emacs or another device pushed while this device had unpushed commits. The ref update fails, or the pull found a newer head. Unpushed commits exist only on this device, so rewriting them is safe, and the history stays linear.

For each pending commit, in order, and for each file it touches:

1. **The file did not change upstream** since the commit's base → keep the commit's text.
2. **Replay the commit's ops** on the new upstream text, finding each heading by its title path (`headingKey` / `findHeading` in `org-edit.js`, what `edits.js` does on a 409 today). If every op lands → that is the new text. This is the best result, because it repeats the *intent* ("mark this task done") on the new text.
3. **3-way merge** with node-diff3 (base = the commit's `before`, ours = its `after`, theirs = the new upstream text). If it merges cleanly → that is the new text.
4. **Conflict** → stop pushing. Keep everything local, show the conflict (§4), and wait for the owner.

The result of 2 or 3 also has to pass the edit invariants (§5) before it replaces the pending commit. **No text with conflict markers is ever committed**: Emacs's `git add -A` would commit them as ordinary text (`agentic-org-planner/lisp/ps-git-sync.el:624-660`).

### The sync engine
- One sync at a time. A trigger during a sync sets an `again` flag and gets one more pass (Acervo `web/src/sync.ts`, `syncNow`).
- Triggers:
  - a local edit (debounced about 3 s);
  - the app becoming visible, and window focus;
  - `online`;
  - every 60 s while visible.
- `navigator.onLine` is a hint, never the answer. Android Chrome reported "online" with every radio off (device check, 2026-11-22), while WebKit reported "offline" correctly. "Offline" on screen comes from the last request's failure class. When `onLine` is false the app may skip a sync, since false is reliable; a true proves nothing.
- Backoff on failures that are expected to clear: 5 s, 15 s, 60 s, then every minute.
- Failure classes, after Emacs's (`agentic-org-planner/lisp/ps-git-sync.el:99-166`). Each one says what happened in one line, and what the owner can do about it:

| Class | Cause | Effect |
|---|---|---|
| offline | network error or timeout | retry with backoff; edits stay local |
| auth | `401`, or `403` without rate-limit headers | stop; "sign in again" |
| rate-limited | `403`/`429` with `x-ratelimit-remaining: 0` or `retry-after` | wait until `x-ratelimit-reset` |
| missing | `404`: a wrong repo or branch, or a private repo the token can't see | stop; check Setup |
| rejected | `409`/`422`, such as a ref update that is not a fast-forward | pull and rebase, then push again |
| server | `5xx` | retry with backoff |
| conflict | a rebase step 4 | stop pushing; the conflict screen |
| diverged | the branch was rewritten | stop; ask |

### Edge cases with a defined answer
Each one gets a scenario test (§8).

| Case | Answer |
|---|---|
| The ref update succeeded but its response was lost | On retry, the head equals our commit's SHA, or descends from it with our commit's tree: count it as pushed |
| Blobs or a tree were created but the ref update failed | Unreferenced objects are harmless; retry |
| The app is killed in the middle of a sync | State changes only in whole transactions; the next sync starts from `pending` |
| The branch was force-pushed | Stop and ask; nothing is wiped |
| A file was deleted or renamed upstream while edited here | Conflict |
| A file was added upstream | Picked up by the next pull if included |
| Two devices edit the same file offline | The second to push rebases onto the first |
| The token expired or was revoked | Stop with "sign in again"; pending commits wait |
| Same heading changed on the Mac and here | Replay usually still lands (it finds the heading by its path); if it doesn't, 3-way merge; then conflict |
| A file's line endings are CR | Read-only, as now |

### How it meets Emacs
- The Mac pulls an app commit within about a minute, on its next sync tick.
- An Emacs buffer with unsaved changes is never overwritten by the pulled file: `ps-org-save.el` already refuses to save over a newer file, and auto-revert refreshes the buffers that have no unsaved changes.
- If the Mac and the app change the same lines inside the same minute, Emacs sees an ordinary merge conflict and pauses its sync, as it does today.
- **Emacs keeps its merge-based pull.** Its reasons for not rebasing still hold (`agentic-org-planner/design/foundations/data-safety.md:149-159`):
  - Dropbox delivers files ahead of their commits;
  - a stopped rebase leaves a detached HEAD for the timer to commit onto;
  - a rebase swaps "ours" and "theirs" in the conflict the owner has to resolve.
  Because Emacs pushes every minute, a merge commit appears only when both sides commit inside the same minute (2 merges in about 2,000 commits so far). The Sync page counts merge commits, so this can be revisited if they become common.
- beorg, Orgzly and Dropbox keep working alongside: their edits reach git through the Mac. Rumbo never touches Dropbox. Once Rumbo replaces the mobile apps, Dropbox can stay as a plain-text fallback or be dropped.

## 4. Transparency and ways out

The owner wants to see where things stand in git terms, and to be able to fix them by hand. A **Sync** page, reached from Settings and from the sync mark in the header:

- **Where this device is:**
  - branch;
  - base commit: short SHA, message, author, time;
  - "2 local commits not pushed" / "GitHub is 3 commits ahead";
  - last check, last error with its class.
- **Local commits**, each with its message and diff, newest last.
- **History** from GitHub, for the vault and for the open file.
- **Push my changes to a branch.** The pending commits are pushed, on their real parent, to a new branch `rumbo/rescue-<yyyy-mm-dd>-<hhmm>`, so they can be merged in Magit on the Mac. This is the main way out of a conflict, and it is always safe: it never touches `main`.
- **Reset to GitHub.** Forget the local state and pull the latest `main`. If anything is unpushed, first offers the rescue branch or the zip.
- **Download everything.** A zip of:
  - the working files;
  - the pending commits as patches;
  - a JSON of the replica's state.
  It is shared through the Web Share sheet (Mail, Files, AirDrop), or downloaded where sharing is not available.
- **Sync log**: the last ~100 events (pulls, pushes, rebases, errors) with times.

**The conflict screen** shows, per file, the clash in context, mine against GitHub's, and offers:
- **Keep GitHub's.** Mine is pushed to a rescue branch first, so nothing is lost.
- **Keep mine.** A new commit on top of GitHub's head, with my text for that file.
- **Rescue and stop.** Push mine to a rescue branch, take GitHub's, and finish on the Mac.

## 5. Editing without disturbing the file

The rules in CLAUDE.md ("Editing rules") stand: span edits on the raw lines, never serialise a parsed tree, keep every byte that wasn't edited. This section replaces how `org-edit.js` handles blank lines when entries are inserted, deleted or moved, and makes edits serialisable for replay.

### What the vault does
Measured on the vault, read-only, 2026-11-22. 35 included files, 3,500 headings.
- **Bodies:**
  - Bodies almost never contain blank lines: about 50 in the whole vault.
  - A body starts on the line right after its heading (3,071 of 3,073).
  - No file has two blank lines in a row before a heading.
- **Blank before a heading**, by its level and what comes before it:

| Level | After a leaf sibling | After a closed subtree | First child, parent has text | First child, parent bare |
|---|---|---|---|---|
| 1 | always (2/2) | always (243/243) | — | — |
| 2 | 1% (14/1,134) | **97%** (191/198) | **84%** (147/174) | 4% (4/100) |
| 3 | 1% (7/1,216) | 32% (8/25) | 36% (12/33) | 0% (0/236) |
| 4+ | never (0/75) | — | never (0/2) | never (0/29) |

*(The first heading in a file always has a blank before it: 33 of 33.)*

- **Read as intent, the rule is:** a blank line marks a change of shape. It goes before a level-1 heading, and before a level-2 heading that closes a subtree or that follows its parent's text; otherwise there is none.
- This is the same rule the Emacs recovery engine found (`agentic-org-planner/design/editing/blank-line-recovery.md`, cells in `ps/blank-lines-rule-cell`, `lisp/ps-blank-lines-engine.el:235-256`). Taking the majority of each cell fits 3,421 of 3,500 headings (97.7%).
- **The level-3 cells are genuinely split** (about one in three has a blank line). These, and the other exceptions, go into the spacing review below for the owner to decide.

### Who owns a blank line
The prototype's `org-edit.js` says an entry owns the blank lines after it (`removalSpan`) and that a new entry copies its neighbour's spacing (`insertChunk`). Both disagree with the vault. For example, moving a section that has children to after a leaf sibling leaves no blank line where the closed subtree needs one.

Rumbo adopts the Emacs model instead (`agentic-org-planner/lisp/ps-blank-lines-tree.el`, design notes `blank-line-recovery.md` "The model"). Every blank line belongs to exactly one slot:

- **`lead(X)`**: the blank lines right after X's heading line (or its planning line), before its body or first child. They belong to X and travel with X.
- **X's body** is opaque: its internal blank lines are part of it, never split or normalised.
- **The boundary gap** between two neighbours: the blank lines before a heading, after the previous body or subtree. It belongs to the **seam**, not to either entry. The blank line between a parent's text and its first child is such a gap. When the parent moves, it moves along, because the whole subtree moves. When the child moves away, it stays, and the seam is resolved again for the new first child.
- **`bof` and `eof`**: blank lines at the start and end of the file.

### Which gaps an edit may change
- **Edits inside an entry** (state, priority, title, tags, planning, notes) never touch any gap.
- **Insert, delete, move, promote, demote** change the text only at the seams they create or remove:
  - a delete removes the entry with its `lead` and leaves one seam where there were two;
  - an insert or move creates two seams around the new place and closes one at the old place.
- **Resolving a seam**, first rule that applies:
  1. **Known edge:** the same two neighbours were adjacent before the edit (a move back, an undo) → their old gap.
  2. **The style rule:** the cell for (level, what precedes it) → its majority, from the table above.
  3. **Keep** the gap that is there. Never zero it for lack of evidence: that deletes blank lines put in by hand (the Emacs "keep" rung).
- All other gaps stay byte-identical.

### The style rule has one source: the vault
- The cells are counted from the vault's own files every time it loads, using the cell definitions of `ps/blank-lines-rule-cell` (with level 3 counted separately, so a different level-3 habit is learnt rather than assumed). A cell needs at least 5 examples to be used.
- The built-in default, used before the counts exist, is the rule above.
- Settings → Diagnostics shows the counted cells.
- No spacing setting is stored separately in the app: the vault is the setting.

### Spacing review
`tools/spacing-report.mjs` reads a vault (path given on the command line), counts the cells and lists every heading that goes against its cell's majority as `file:line — cell — has/lacks blank`. It is local and read-only, and its output is never committed. The owner reviews the list once, fixes in Emacs what was accidental, and keeps what was meant. The counts then get sharper on their own. There are 79 such headings today, three quarters of them in 7 files.

### Serialisable edits
- Every edit is data: `{ path, op, key, args, v }`.
  - `op` is one of the `org-edit.js` operations: `setState`, `setPriority`, `setTitle`, `setTags`, `setPlanning`, `setBody`, `insertHeading`, `deleteSubtree`, `removeDone`, `moveSubtree`, `promote`, `demote`, `moveUp`, `moveDown`.
  - `key` is the heading's `headingKey` (its title path and its place among same-named headings).
  - `v` is the op format's version.
- One entry point, `applyOp(lines, doc, op)`, runs an op for an edit and for replay alike. It replaces the closures in the edit journal (`prototype/edits.js:115`), which can't be stored or replayed after a restart.
- A move across files is two ops in one local commit.

### Invariants checked before a local commit
Each edit, and each rebased commit, must pass all of these, or it is refused with a message and nothing is written:
- Lines outside the edit's own hunks are byte-identical to before.
- With all blank lines removed, old and new differ only in the edited content.
- No line starts with `<<<<<<<`, `=======` or `>>>>>>>` unless it did before.
- The file still parses, with the same headings apart from the edited ones.

### Heading format
Unchanged from CLAUDE.md:
- `** TODO [#A] Title :tag1:tag2:`, with tags one space after the title and no alignment;
- old aligned tags stay as they are;
- the planning line goes right under the heading, with an English weekday;
- no `CLOSED:` line;
- notes start at column 0.

### Undo
- Undo stays per session (and ⌘Z).
- Before a push, undo replaces or drops the pending commit.
- After a push, undo is a new commit with the old text. History is never rewritten once pushed.

## 6. Obsidian notes

The vault links to notes as `[[obsidian:Note name]]`: 491 links to 357 notes, always a bare note name, no folder, no `.md`. Every note name is unique in the Obsidian vault (its `AGENTS.md` requires it, and 1,359 notes have no collisions, even ignoring case), so a name finds exactly one file.

- **A tap on such a link shows the note in Rumbo**, read-only, with an **Open in Obsidian** button.
- **Open in Obsidian** uses `obsidian://open?vault=<vault name>&file=<note name>`, the link Emacs opens (`agentic-org-planner/lisp/ps-links.el:15-21`). Obsidian documents it for iOS and Android too. Some users report it opening the last note instead when Obsidian was not running; step 1 tests it on both devices. The vault name is a per-device setting (`obsidian` on the Mac).
- **How the note is fetched:**
  - The Obsidian repo's tree (`GET /git/trees/{head}?recursive=1`) gives a name → path index. It is kept in IndexedDB and refreshed when that repo's head changes.
  - The note itself is fetched through the contents API (`Accept: application/vnd.github.raw+json`).
  - Images it embeds (`![[picture.png]]`, in `90 Meta/Images/`) are fetched as blobs and shown through object URLs.
- **Rendering** reuses carrel's browser Markdown module (`carrel/src/carrel/static/markdown.js`: marked, DOMPurify, Obsidian callouts, maths). Rumbo adds:
  - `[[wiki links]]` (to other notes, opened the same way);
  - `![[embeds]]` for images;
  - footnotes;
  - leaving front matter out.
- **Not cached:** offline, a tap offers only "Open in Obsidian".
- About 12 links name notes that no longer exist: they show as "not found".
- `[[file:~/…]]` links point at the Mac's disk. They show as plain text.

## 7. Task icons

The agenda shows an icon per task. The icons come from a cache Emacs keeps outside the vault (`~/.cache/ps-task-icons/task_cache.json`).

**A change in `agentic-org-planner`, made in a session in that repo:**
- Whenever the cache changes, Emacs also writes it to `<vault>/.ps/task-icons.json`.
- Emacs's normal sync then commits it. `.ps/` is already tracked in the vault (`.ps/state.el`) and is not ignored.

**In Rumbo:**
- The file is read like any other.
- The keys stay the same: the task's title fields as JSON, `{"title":"…"}`.
- The bundle tag is ignored.
- Without the file, the agenda simply shows no icons.

## 8. Tests

Most of the testing effort goes to sync and blank lines, as asked. Everything runs under `node --test` with no installs, except the opt-in end-to-end script.

### A fake GitHub
`tests/fake-github.mjs`: an in-memory implementation of the endpoints in §3.
- Objects are hashed the way git hashes them.
- The ref is updated only by compare-and-swap.
- Commits have parents, and `compare` works.
- Failures can be injected:
  - a timeout before, or after, the ref update;
  - `401`, a `403` rate limit, `5xx`;
  - a force-push;
  - a slow response.
- `remote-github.js` runs against it through an injected `fetch`.

### Sync scenarios
One test per edge case in §3, plus:
- **Actors:**
  - "Emacs on the Mac" commits and pushes between any two steps of a sync;
  - "the phone" is a second Rumbo replica on the same fake.
- **Offline, then online:** edits across several files while offline, then a pull that brings changes to the same and to other files.
- **Rebase outcomes:**
  - replay succeeds;
  - replay fails but the 3-way merge succeeds;
  - both fail, giving a conflict; then each of the three ways out.
- **Rescue branch, reset, zip:** the contents are exactly the pending commits and the working files.
- **Interrupted at every step:** a sync stopped after each request, the app restarted from IndexedDB, and the sync completed. No edit is lost or doubled.
- **Seeded random interleavings** of the actors' edits and syncs, checking after each run:
  - every edit is either in `main` or still pending;
  - nothing pushed contains conflict markers;
  - all replicas converge to `main`.
- **IndexedDB:** the store runs on `fake-indexeddb` in tests, and a hanging request is simulated to test the 2 s guard.

### Blank lines and edits
- **Property tests** over the sample vault and generated outlines, for every op on every heading:
  - the invariants of §5 hold;
  - gaps away from the touched seams are byte-identical;
  - move then move back, and delete then undo, give the original bytes;
  - an insert follows the cell rule;
  - a file round-trips unchanged when nothing is edited (already tested).
- **Rule tests:** `spacing-report.mjs`'s counting on fixtures with known answers.
- **`tools/vault-check.mjs`**, local only, given the vault's path:
  - runs every op on every heading of the real vault in memory;
  - reports any invariant failure.
  It writes nothing and its output is not committed.

### End to end, opt-in
`tools/e2e-github.mjs`, given a throwaway private repo and a token for it:
- runs the real API;
- runs real `git` beside it with the same commit, pull and push commands as Emacs's sync, to check that the two work together.
It is never run in CI.

### UI and build
- Playwright WebKit screenshots at the three device sizes, as now.
- The PWA build test (§2).

## 9. Code layout

- `prototype/` stays as it is, for future design rounds.
- `app/` is the real app. It starts as a copy of the prototype modules and drops the harness.

| Module | From the prototype | What changes |
|---|---|---|
| `org.js`, `inline.js`, `workspace.js` | as is | — |
| `org-edit.js` | as is | the gap model of §5, `applyOp`, invariants |
| `edits.js` | as is | writes local commits through `store.js` instead of `POST /api/save`; ops replace closures |
| `data.js` | as is | builds the model from `store.js` instead of `/api/*` |
| `ui.js`, `tree.js`, `outline.js`, `agenda.js`, `shell.js`, `state.js`, `edit-ui.js`, `gestures.js` | as is | Setup, Sync and note views added; last place restored |
| `store.js` | new | IndexedDB, transactions, the 2 s guard |
| `gitobj.js` | new | blob SHA |
| `remote-github.js` | new | the `Remote` interface on GitHub |
| `sync.js` | new | pull, push, rebase, the engine and its triggers |
| `merge.js` | new | replay, then 3-way merge |
| `notes.js` | new | the Obsidian index, fetching and rendering |
| `sync-ui.js` | new | the Sync page and the conflict screen |
| `sw.js` | new | the service worker |

Also new: `tools/build.mjs`, `tools/spacing-report.mjs`, `tools/vault-check.mjs`, `tools/e2e-github.mjs`, `tests/fake-github.mjs`, `.github/workflows/deploy.yml`.

iOS details to carry over from calorie-logger and lectern:
- lay dialogs out against `visualViewport`, because the keyboard covers the page instead of shrinking it;
- use a non-passive `touchmove` to keep Safari from scrolling during a swipe;
- detect an iPad from `MacIntel` plus touch points;
- turn off `overscroll-behavior-y`, because pull-to-refresh can discard an open dialog.

## 10. Order of work

0. **Rename to Rumbo:**
   - create the public GitHub repo `rumbo` (there was no remote) and rename the local folder;
   - update CLAUDE.md, README and memory (the memory folder is keyed by the project path);
   - check the history for private data;
   - make the repo public and turn on Pages.
1. **Device checks (one short session).** A small page on Pages, opened from the iPad's Home Screen and from the Android phone:
   - reads the vault's head and one blob with a token;
   - computes a blob SHA;
   - calls `persist()`;
   - opens a note through `obsidian://open`.

   This confirms the platform assumptions before anything is built on them.
2. **The app, read-only, offline:**
   - `app/`, `store.js`, `remote-github.js` (pull only);
   - Setup, the service worker, the deploy workflow;
   - the read side of the Sync page.

   Usable every day from here on.
3. **Blank lines:** the gap model in `org-edit.js`, serialisable ops, invariants, `spacing-report.mjs` and `vault-check.mjs`, with the property tests. The owner reviews the spacing report.
4. **The write path:** the fake GitHub and the scenario suite first, then:
   - local commits and push;
   - rebase with replay and 3-way merge;
   - the conflict screen, the rescue branch, reset and zip.
5. **Obsidian notes.**
6. **Task icons** (the Emacs change, in its own repo) and **hardening on the devices**.

Later, as before: the calendar and time grid, situation views, more settings.
