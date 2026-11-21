# Editing: design brief

The next round. Design how editing works, in the existing prototype, before the real app is built.
The output is switchable mock-ups the owner can try on the iPad and phone, plus the pure edit
functions with tests. Saving through the server can be stubbed or limited to the sample vault until
the design is agreed.

## What the owner wants to do

Most to least important:

1. Edit a task's **title** and its **description** (the body).
2. Change a task's **state**: TODO, NEXT, INPR, WAIT, MAYB, DONE. DONE tasks are normally deleted in this vault, so "done" may mean "delete". Ask the owner.
3. **Create** a task, and create a section. Not new files.
4. **Reorganise**: move a task or section up or down, into another section, or into another file. Promote or demote.
5. **Remove** a task.
6. **Priority**: set or clear `[#A]`. B and C exist in Org but are unused.
7. **Tags**, from the fixed vocabulary in `workspace.org` (`ps/context-tags`, with meanings).
8. **SCHEDULED / DEADLINE**: occasional, mostly for meetings.

## The owner's answers (2026-11-21)

- **Where:** in file views only, never in the agenda. Phone and tablet first, and it should also work with a mouse, for a later macOS menu-bar app.
- **What is common:** small changes: the state, deleting a task, priority, tags, the title and notes, SCHEDULED and DEADLINE. Typing long new text is rarer; that is done on the computer.
- **DONE is not delete.** Marking a task done keeps it in place, drawn faint. It stays until the owner deletes it; "Remove done tasks" on a section clears them in one go.
- **Explicit entry:** viewing comes first, and a tap must never start editing. The ways in are built behind the harness switch `edit`, to compare on the devices. The action row on an opened task was tried and dropped. Edit mode suits the owner best so far, because it is clear when editing is on; turning it on or off must keep the row at the top of the screen where it was.
- **A dialog** for editing a task and adding a new one; **dragging** to reorder.
- **Saving:** the sample vault only for now, with the conflict check. Real-vault edits stay on the page.
- **Code reuse** from the owner's calorie-logger (gestures, drop logic, month calendar) and carrel (keyboard fitting, tag picker, save loop) is welcome.

**Decided (2026-11-21):** the target app combines **swipe**, always on, for quick changes, with **edit mode**, entered from the header, for bigger changes and reordering. Long-press was the simplest, but a slightly imperfect hold sometimes became a drag. Swipe alone can't reorder. The prototype keeps all three to compare further. The full record is in `CLAUDE.md` under "Settled design" → "Editing".

## Hard constraints

- **Keep every byte that wasn't edited.** beorg and Orgzly strip blank lines and trailing whitespace. That is the owner's main complaint, and the Emacs config has a whole tool to recover from it (`agentic-org-planner/design/editing/blank-line-recovery.md`).
  - Edits are **span edits on the raw lines**: replace exactly the lines of the heading line, the planning line or the body being edited, and leave everything else untouched.
  - Never serialise a parsed tree back to text. `org.js` already gives each heading `line`, `bodyStart`, `bodyEnd`, `end` and the raw `lines`.
- **Write headings the way Emacs does in this vault:**
  - `** TODO [#A] Title :tag1:tag2:`, with tags one space after the title and **no column alignment**. Emacs has `org-auto-align-tags nil`.
  - The planning line sits directly under the heading line: `SCHEDULED: <2027-01-10 Sun>`.
  - Body text starts at column 0. Logging on done is off (`org-log-done nil`), so no CLOSED line.
- **No accidental edits.** A tap must keep meaning "show or hide the notes", as it does now. Editing needs a deliberate gesture or mode. The prototype's calm reading view must not gain visible editing chrome when nobody is editing.
- **The files change underneath.** The vault is in Dropbox and edited in Emacs on the Mac, so a save must detect that the file changed since it was read (mtime or a hash of the lines being edited) and refuse or merge, never overwrite blindly. A small git-backed safety net already commits the vault.

## Questions to explore with mock-ups

- **Entry point:** long-press, an edit button revealed on the open task, a global "Edit" mode toggle, or swipe actions. Check each against "no accidental edits".
- **State change:** the quickest safe path. Tap the state shape? A small menu? On a phone and a tablet.
- **Title and body editing:** inline in place, or a sheet or dialog with the raw text. Is the body shown as raw Org (honest, keeps whitespace) or as rich text (riskier)? The recommended starting point is a plain textarea with the raw lines.
- **New task and new section:** where the "+" lives, and where the item lands (after the current task, at the end of the section).
- **Reordering:** drag handles in an edit mode, "Move to…" with a section picker (works across files), or both. Promote and demote.
- **Tags, priority, dates:** chips with a picker from the vocabulary; an A toggle; a date picker that writes a correct Org stamp with its weekday.
- **Undo:** for at least the last edit.
- **Feedback:** saving, saved, conflict.

## Deliverables of the round

- `prototype/org-edit.js`: pure functions that take the raw lines and a heading and return new lines, covering each operation above. Tests in `tests/` prove that untouched lines are byte-identical, including blank lines and trailing spaces.
- Edit mock-ups behind harness switches, like the earlier rounds, for the owner to compare on the devices.
- A server write endpoint, if the owner agrees to try real saving. It should be sample vault only at first, with conflict detection.
- An updated `CLAUDE.md` "Settled design" section once the owner has chosen.
