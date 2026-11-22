# Rumbo

*Rumbo* is Spanish for "course, heading": a plan is a heading to steer by, and Org files are made of
headings.

Rumbo is a calm planner for an Org-mode vault, made for the iPad (11" and mini) and a large Android
phone. It shows the vault as folders of plan files, each file as a foldable outline, and an agenda
of what is in progress, high priority and next up. It is being built to work offline, to edit tasks
with a swipe or in an edit mode, and to keep every blank line and every byte of a file that wasn't
edited. The vault stays in its own git repository on GitHub, and Emacs on the desktop keeps working
alongside it.

## Status

- `prototype/`: switchable HTML mock-ups of the layout, outline, agenda and editing designs, run
  against a local vault. The design is settled.
- `app/`: the installable app, built in steps. For now it is a device check: it confirms that a
  tablet or phone can install the app, work offline and reach the vault's repository on GitHub.
- `docs/plans/real-app.md`: how the app is built, and `docs/plans/NEXT.md`: what comes next.

## Run

```sh
uv run prototype/serve.py                  # the prototype at http://127.0.0.1:8650/
uv run prototype/serve.py --host 0.0.0.0   # open it from a tablet or phone on the same network
uv run prototype/serve.py --sample         # with the synthetic sample vault only
node --test tests/                         # tests (no npm install needed)
node tools/build.mjs                       # build the app into dist/
```

The prototype finds the vault the same way the Emacs config does: `--vault DIR`, then
`$PS_ORG_BASE`, then `:current` in `~/.emacs.d/vaults.eld`. File icons, folder icons and folder
order come from the vault's own `workspace.org`, so nothing is configured twice.

See [prototype/README.md](prototype/README.md) for every switch.

## Licences

Fonts are under the SIL Open Font License; Material Symbols under Apache 2.0. The Rumbo icon was
drawn for this project.
