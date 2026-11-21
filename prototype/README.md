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

Opening a file, a view or a focused section is a history entry, so the browser's Back and Forward
work.

## Switches

Tap a toolbar button to move to the next option. Right-click or long-press it to move back.
Every switch is mirrored in the URL, so any combination can be bookmarked.

| Switch     | URL key | Options |
|------------|---------|---------|
| Frame      | `frame` | `none` (real window), `ipad11p` 834×1210, `ipad11l` 1210×834, `minip` 744×1133, `minil` 1133×744, `phone` 412×915 |
| Theme      | `theme` | `paper` (warm, serif reading; the default), `slate` (cool, all sans), `dusk` (warm dark), `night` (cool dark). The app's Settings also has this. |
| Tablet nav | `nav`   | `rail` · `drawer` (see the table above) |
| Data       | `data`  | `real` vault · `sample` synthetic vault in `sample-vault/` |

## In the app

**File view**
- **Fold depth:** Sections, Tasks and All work like Org's Shift-Tab; Shift-Tab on a keyboard cycles them. On a phone it is one button that cycles.
- **One heading:** tapping a heading opens or closes just that heading.
- **Focus:** the › button on a section narrows the page to that section.
  - The ← button goes up one level.
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

**Other URL keys**
- `view`: `agenda` or `file`.
- `file`: vault-relative path.
- `focus`: id of the focused section.
- `fold`: `overview` / `tasks` / `all`.
- `harness=0`: hides the toolbar.

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
