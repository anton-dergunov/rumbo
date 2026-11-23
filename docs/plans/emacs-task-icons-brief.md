# Brief: Emacs writes its task icons into the vault (for Rumbo)

**For:** a session in `~/projects/products/agentic-org-planner`, under that repo's own `CLAUDE.md`. Start that session with this file.
**From:** Rumbo's session 7 (2026-11-23). Rumbo already reads the file described here; it was built and tested against a synthetic copy.

## Why
Rumbo is the owner's tablet and phone app for this Org vault. It syncs with the vault's git repo through the GitHub API, and its agenda shows a task icon per row, the same icons as Emacs's agenda. Emacs's icons live in `~/.cache/ps-task-icons/task_cache.json`, outside the vault, so Rumbo can't see them. This change puts a copy into the vault, where Emacs's git sync commits it like any other file.

Rumbo has its own small on-device model for tasks that have no Emacs icon yet, such as a task just added on the phone. Emacs's icon replaces that guess as soon as a pull brings it. So the file doesn't need to be complete or immediate. It must be correct and private.

## What to build
In `lisp/ps-task-icons.el`, whenever `ps/task-icons--cache-save` runs, also write `<vault>/.ps/task-icons.json`. `<vault>` is the current vault's root, as `ps-vault.el` knows it (`my-org-base-directory`, the same place as `.ps/state.el`). Don't add a second setting for it.

**Format** (UTF-8, LF):
```json
{"tag":"F1-df69a05fab6d","inputs":["title","parents"],"map":{
"{\"title\":\"Book a *dentist* appointment\",\"parents\":[\"Teeth\"]}":"dentistry",
"{\"title\":\"…\",\"parents\":[…]}":""}}
```
- `tag`: the bundle's tag (`ps/task-icons--tag`).
- `inputs`: the manifest's `query.inputs` (`ps/task-icons--inputs`). Rumbo builds its keys from this list, so a future bundle that reads `body` makes Rumbo fall back to its guesses rather than silently match nothing.
- `map`: exactly the cache's keys and values. A key is the task's fields as JSON (`ps/task-icons--key`). A value is an icon name, or `""` for "no icon", which Rumbo respects and doesn't guess over.
- **One map entry per line**, as above, so a git diff of a changed icon is one line and two machines' changes merge cleanly. The order should be stable from one write to the next (insertion order, or sorted).

## Rules
1. **Only this vault's tasks.** The cache file is shared by every vault in the registry (`vaults.eld`). Write only the entries for tasks in this vault's agenda files. Otherwise another vault's task titles would land in this vault's repo. The simplest correct filter: the keys of the open tasks in the current vault's agenda files, computed with the same `ps/task-icons--task-at-marker` the agenda uses, intersected with the cache.
2. **Bounded:** that filter also drops entries for tasks that were deleted or renamed, so the file doesn't grow forever.
3. **Write only when the content changed.** Every write becomes a sync commit.
4. **Atomic:** write a temp file in `.ps/`, then rename it over the old one. The git sync can commit at any moment.
5. **Never fail the agenda:** an error writing the file is reported once (as `ps/task-icons--fail` does) and otherwise ignored.
6. Check that `ps-git-sync` commits `.ps/task-icons.json` (`.ps/state.el` is already tracked) and that nothing in the vault's `.gitignore` excludes it.

## How the key is built (already true; don't change it)
Rumbo rebuilds Emacs's key from its own parse and has been checked against Org 9.7.11 and the real cache (29 of 29 keys match):
- `title`: `org-get-heading t t t t`, trimmed. Markup and cookies stay; the keyword, priority, tags and `COMMENT` go.
- `parents`: `org-get-outline-path`, outermost first. Statistics cookies such as `[2/5]` go (the spaces around them stay), and links show their description, else their target.

Any change to how Emacs builds keys must be made in Rumbo too (`app/icon-keys.js` there).

## Done when
- The tests in that repo's style cover the format, the vault filter (an entry from another vault never appears), no write when nothing changed, and the atomic write.
- On the Mac, after an agenda render, `<vault>/.ps/task-icons.json` exists, holds only this vault's tasks, and is committed by the next sync.
- `design/planning/task-icons.md` says the file exists, what it holds, and who reads it.
- In Rumbo: after a pull, the agenda shows Emacs's icons. `node tools/icon-check.mjs` in the Rumbo repo reads the real cache and the vault, and reports how many keys match.
