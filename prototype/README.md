# UI prototype

Static HTML and ES modules with no build step, served by `serve.py` (Python standard library
only). Every design alternative uses the same data and the same theme tokens. The floating
toolbar in the bottom-right corner switches between them; it is part of the prototype only.

## Switches

Tap a toolbar button to move to the next option. Right-click or long-press it to move back.
Every switch is mirrored in the URL, so any combination can be bookmarked.

| Switch     | URL key   | Options |
|------------|-----------|---------|
| Frame      | `frame`   | `none` (real window), `ipad11p` 834×1210, `ipad11l` 1210×834, `minip` 744×1133, `minil` 1133×744, `phone` 412×915 |
| Theme      | `theme`   | `paper` (warm, serif reading; the default), `slate` (cool, all sans), `dusk` (warm dark), `night` (cool dark) |
| Shell      | `shell`   | `panes`: file list, file and agenda side by side. Narrower screens fold the list to an icon rail, then put File and Agenda behind a switch. `tabs`: Agenda and Files tabs. `home`: the agenda is home and files open from a drawer. |
| Sections   | `outline` | `indent`: nested sections step in a little. `guides`: the same, with a faint line down each level. |
| States     | `marks`   | `shapes`: a shape in a fixed slot, so titles always line up. `labels`: the same shapes, plus the state as a word in the right margin. |
| Task icons | `icons`   | `right`: task icons in the right margin of the outline and in the agenda's icon square · `off` |
| Data       | `data`    | `real` vault · `sample` synthetic vault in `sample-vault/` |

**State shapes:**

| Shape | State |
|---|---|
| empty ring | to do |
| filled dot | next |
| half-filled dot | in progress |
| pause bars | waiting |
| dashed ring | maybe |

The ⓘ button in the agenda header shows this legend in the app. High priority is an outlined **A** in the right margin.

### In the app (not prototype switches)

**File view**
- **Fold depth:** Sections, Tasks and All work like Org's Shift-Tab; Shift-Tab on a keyboard cycles them.
- **One heading:** tapping a heading opens or closes just that heading.
- **Focus:** the › button on a section narrows the page to that section, with a breadcrumb back (URL key `focus`).
- **Contents:** the contents button lists the top sections, for jumping around a long file.

**Agenda**
- The pane header shows today's date.
- **List / By file:** groups the same rows under their files (URL key `group`).
- **Rows:** tapping a row shows its notes, and "Open in …" jumps to the task in its file.

**Other URL keys**
- `file`: vault-relative path of the open file.
- `fold`: `overview` / `tasks` / `all`.
- `view`: `agenda` / `files` / `file`, for single-pane layouts.
- `harness=0`: hides the toolbar. On a phone-sized window it starts hidden behind a ⚙ button.

## Data rules

- The real vault is read through `/api/*` and never copied into this repository.
- Only `.org` files that pass the same exclusions as Emacs are served. Excluded: `init.org`,
  `workspace.org`, conflicted copies, dot folders, `Journal/` and `Archive/`.
- `sample-vault/` is a synthetic copy of the Emacs config's `samples/realistic` vault.

## Files

- `org.js`: the Org parser. It is pure and keeps each heading's line span for later edits.
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
