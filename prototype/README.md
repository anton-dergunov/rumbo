# UI prototype

Static HTML and ES modules with no build step, served by `serve.py` (Python standard library
only). Every design alternative uses the same data and the same theme tokens. The floating
toolbar in the bottom-right corner switches between them; it is part of the prototype only.

## Switches

Tap a toolbar button to move to the next option. Right-click or long-press it to move back.
Every switch is mirrored in the URL, so any combination can be bookmarked.

| Switch  | URL key   | Options |
|---------|-----------|---------|
| Frame   | `frame`   | `none` (real window), `ipad11p` 834×1210, `ipad11l` 1210×834, `minip` 744×1133, `minil` 1133×744, `phone` 412×915 |
| Theme   | `theme`   | `paper` (warm, serif reading), `slate` (cool, all sans), `dusk` (warm dark), `night` (cool dark) |
| Shell   | `shell`   | `panes` tree, file and agenda side by side (narrower screens fold the tree to an icon rail, then put File and Agenda behind a switch) · `tabs` Agenda and Files tabs · `home` agenda as home, files from a drawer |
| Tree    | `tree`    | `list` compact rows · `index` rows with each file's subtitle · `grid` tiles (the full Files page in the tabs shell) |
| Outline | `outline` | `document` reading page · `outliner` rows with chevrons, guides and a one-line preview · `cards` one card per top section · `navigator` drill down one level at a time (master-detail on wide screens) |
| Agenda  | `agenda`  | `columns` aligned slots like the Emacs agenda · `rows` two-line rows showing where each task lives · `grouped` grouped by file |
| Marks   | `marks`   | `quiet`: TODO is an empty ring, and only NEXT/INPR/WAIT carry a word · `dots`: a coloured dot and the word · `pills`: tinted pills like org-modern |
| Data    | `data`    | `real` vault · `sample` synthetic vault in `sample-vault/` |

Other URL keys:
- `file`: vault-relative path of the open file.
- `fold`: `overview` / `tasks` / `all`.
- `view`: `agenda` / `files` / `file`, for single-pane layouts.
- `nav` and `task`: the navigator's position.
- `harness=0`: hides the toolbar. On a phone-sized window it starts hidden behind a ⚙ button.

Folding mirrors Org's Shift-Tab. **Sections**, **Tasks** and **All** set the depth for the whole
file, and Shift-Tab on a keyboard cycles through them. Tapping a heading opens or closes just
that heading. The contents button lists the top sections for jumping around a long file.

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
