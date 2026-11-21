# Plan Viewer

A calm, read-only viewer for an Org-mode planning vault, built for the iPad (11" and mini) and a
large Android phone. It shows the vault as folders of plan files, each file as a foldable outline,
and the agenda of what is in progress, high priority and next up, matching the Emacs agenda.

This repository is at the prototype stage: `prototype/` holds switchable HTML mock-ups of the
layout, outline, agenda and file-tree designs, running against the real vault.

## Run the prototype

```sh
uv run prototype/serve.py                  # http://127.0.0.1:8650/
uv run prototype/serve.py --host 0.0.0.0   # open it from the iPad or phone on the same network
uv run prototype/serve.py --sample         # synthetic sample vault only
node --test tests/                         # parser tests
```

The vault is found the same way the Emacs config finds it, so there is one setting to change:
`--vault DIR`, then `$PS_ORG_BASE`, then `:current` in `~/.emacs.d/vaults.eld`. File icons,
folder icons and folder order come from the vault's own `workspace.org`, and task icons from the
Emacs task-icon cache, so nothing is configured twice.

See [prototype/README.md](prototype/README.md) for every switch.
