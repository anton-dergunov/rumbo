# UI prototype

Static HTML and ES modules with no build step, served by `serve.py` (Python standard library
only). Every design alternative uses the same data and the same theme tokens. The floating
toolbar in the bottom-right corner switches between them; it is part of the prototype only.

## Layout

There is one navigation list: **Views** first, then the vault's folders and files. Only the
Agenda view exists so far; calendar and situation views will join it. The main area shows one thing
at a time, either a view or a file. How the list appears depends on the width:

| Width | Navigation |
|---|---|
| phone (< 600 px) | ☰ opens the list as a drawer |
| tablet (600–1100 px) | an icon rail beside the page, with ☰ on the rail opening the list with names (`nav=rail`); or the page alone with the drawer, as on a phone (`nav=drawer`) |
| landscape and desktop | the list as a sidebar |

Opening a file, a view or a focused section is a history entry. The ‹ and › buttons in the
header, and the browser's own Back and Forward, move through them, and each place keeps its
scroll position.

## Switches

Tap a toolbar button to move to the next option. Right-click or long-press it to move back.
Every switch is mirrored in the URL, so any combination can be bookmarked.

| Switch     | URL key | Options |
|------------|---------|---------|
| Frame      | `frame` | `none` (real window), `ipad11p` 834×1210, `ipad11l` 1210×834, `minip` 744×1133, `minil` 1133×744, `phone` 412×915 |
| Theme      | `theme` | `paper` (warm, serif reading; the default), `slate` (cool, all sans), `dusk` (warm dark), `night` (cool dark). The app's Settings also has this. |
| Tablet nav | `nav`   | `rail` · `drawer` (see the table above) |
| Data       | `data`  | `real` vault · `sample` synthetic vault in `sample-vault/` |
| Edit       | `edit`  | how editing is entered: `mode` (edit toggle) · `press` (long-press) · `swipe`; see "Editing" below |

With `data=sample` the toolbar also has **Sample · reset**, which throws away every edit to the sample.

## In the app

**File view**
- **Fold depth:** Sections, Tasks and All work like Org's Shift-Tab; Shift-Tab on a keyboard cycles them. On a phone it is one button that cycles.
- **One heading:** tapping a heading opens or closes just that heading. A collapsed section shows a small chip under its title with an expand chevron and its counts.
- **Focus:** the › button on a section narrows the page to that section.
  - The header shows the file, then the focused section's path. It does not change while scrolling. Every part of it can be tapped: the file returns to the whole file, and a section focuses on that section.
- **Contents:** the contents button lists the top sections, for jumping around a long file.
- **State shapes:**

  | Shape | State |
  |---|---|
  | empty ring | to do |
  | filled dot | next |
  | half-filled dot | in progress |
  | pause bars | waiting |
  | dashed ring | maybe |

- **Header:** the file name sits in the header with the section breadcrumb; it is not repeated on the page.
- **Right margin:** an outlined **A** for high priority. Task icons appear in the agenda only.
- **Bottom of the navigation list:** "What the marks mean" and **Settings** (the theme, for now).

**Agenda**
- **Sections:** High priority, In progress and Next up.
- **Rows:** no state mark and no **A** where the section already says it. Tapping a row shows its notes, and "Open in …" jumps to the task in its file.
- **List / By file:** groups the same rows under their files (URL key `group`).

**Editing** (file view only, never the agenda)

A plain tap still only opens or closes notes. Editing always starts with a deliberate gesture, and
the `edit` switch picks which one, so they can be compared on the devices:

| `edit` | Way in |
|---|---|
| `mode` | A pencil in the header turns on edit mode (also the E key). Every row then shows ⋯ (actions) and a drag handle. Tapping a state shape changes the state, tapping a task opens its dialog, and "Add task" / "Add section" rows appear. Done turns it off. The row at the top of the screen stays where it is when the mode changes. |
| `press` | Hold a row for about half a second. Let go for the action menu, or move to drag it to a new place. With a mouse, right-click for the menu, or hold and drag. |
| `swipe` | Swipe a row right for Done and State, or left for More and Delete. Nothing changes until a button is tapped. |

In every variant, right-clicking a row opens the action menu, and ⌘Z / Ctrl-Z undoes.

- **Action menu:** the six states (one tap each), priority, tags, scheduled, deadline, Edit…, Add task below (for a section: add a task, a section or a subsection), Move…, Up / Down, Promote / Demote, Remove done tasks (sections) and Delete. A section asks before it is deleted; a task is deleted at once, with Undo.
- **Dialog:** the title, state, priority, dates, tags (from the vocabulary in `workspace.org`, with their meanings) and the notes as the raw Org text, kept exactly as typed. The same dialog adds a new task or section.
- **Move…:** Up, Down, Promote, Demote, or to the end of any section of any file.
- **DONE:** a done task stays where it is, drawn faint, until it is deleted.
- **Undo:** the toast after each edit offers Undo, and ⌘Z / Ctrl-Z goes back further (the last 20 edits).
- **Saving:** each edit is saved at once, and only to the sample vault's working copy. If the file changed on disk since it was read, the edit is applied again to the new text; if its heading is gone, the file is reloaded and the toast says so. With `data=real`, edits stay on the page and are never written.

**Other URL keys**
- `view`: `agenda` or `file`.
- `file`: vault-relative path.
- `focus`: id of the focused section.
- `fold`: `overview` / `tasks` / `all`.
- `harness=0`: hides the toolbar.
- `editing=1`: edit mode is on (the `mode` variant).

## Data rules

- The real vault is read through `/api/*` and never copied into this repository.
- Only `.org` files that pass the same exclusions as Emacs are served. Excluded: `init.org`,
  `workspace.org`, conflicted copies, dot folders, `Journal/` and `Archive/`.
- `sample-vault/` is a synthetic copy of the Emacs config's `samples/realistic` vault.
- Edits to the sample go to `.sample-work/`, a gitignored copy that `serve.py` makes from
  `sample-vault/` when it starts. The committed sample is never written. The real vault is
  read-only in the prototype.

## Files

- `org.js`: the Org parser. It is pure and keeps each heading's line span for later edits.
- `org-edit.js`: the edits, as span edits on the raw lines; every other line stays byte-identical.
- `edits.js`: applies an edit to the model, keeps undo, saves, and handles a file changed underneath.
- `edit-ui.js`: the action menu, dialog, pickers and toast, in a layer the page redraws never touch.
- `gestures.js`: long-press, swipe, and drag to reorder with auto-scroll.
- `inline.js`: inline markup.
- `workspace.js`: reads `workspace.org`.
- `data.js`: builds the model.
- `tree.js`, `outline.js`, `agenda.js`, `shell.js`: the views.
- `harness.js`: the toolbar.
- `app.js`: the entry point.
- `tokens.css`: all colours and fonts.
- `proto.css`: the layout.

## Licences of external assets

The prototype loads these from Google Fonts:

| Asset | Licence |
|---|---|
| Literata, IBM Plex Sans, IBM Plex Mono, Inter | SIL Open Font License 1.1 |
| Material Symbols Outlined (the same icon names the Emacs config uses) | Apache License 2.0 |
