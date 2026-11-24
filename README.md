# Rumbo

*Rumbo* is Spanish for "course, heading": a plan is a heading to steer by, and Org files are made of
headings.

Rumbo is a calm planner for an Org-mode vault, made for the iPad (11" and mini) and a large Android
phone. It shows the vault as folders of plan files, each file as a foldable outline, and an agenda
of what is in progress, high priority and next up. It works offline, edits tasks with a swipe or in
an edit mode, and keeps every blank line and every byte of a file that wasn't edited. The vault
stays in its own git repository on GitHub, and Emacs on the desktop keeps working alongside it.

## Status

- `prototype/`: switchable HTML mock-ups of the layout, outline, agenda and editing designs, run
  against a local vault. The design is settled.
- `app/`: the installable app. It keeps a copy of the vault on the device and works offline, shows
  the agenda and every plan file, and edits tasks with a swipe or in an edit mode. Each edit is a git
  commit sent to the vault's repository on GitHub, and changes from the desktop are woven in. Linked
  Obsidian notes open inside the app, and agenda tasks get icons.
- `docs/plans/real-app.md`: how the app is built.

## Run

```sh
uv run prototype/serve.py                  # the prototype at http://127.0.0.1:8650/
uv run prototype/serve.py --host 0.0.0.0   # open it from a tablet or phone on the same network
uv run prototype/serve.py --sample         # with the synthetic sample vault only
npm install                                # once: the test dependencies
npm test                                   # tests (without npm install, some are skipped)
node tools/build.mjs                       # build the app into dist/
node tools/spacing-report.mjs              # the vault's blank-line habits, and the headings that differ
node tools/vault-check.mjs                 # every edit on every heading of the vault, in memory
```

The prototype and the two vault tools find the vault the same way the Emacs config does: `--vault DIR`, then
`$PS_ORG_BASE`, then `:current` in `~/.emacs.d/vaults.eld`. The tools only read it. File icons, folder icons and folder
order come from the vault's own `workspace.org`, so nothing is configured twice.

See [prototype/README.md](prototype/README.md) for every switch.

## Licences

Fonts are under the SIL Open Font License; Material Symbols under Apache 2.0. The Rumbo icon was
drawn for this project.
