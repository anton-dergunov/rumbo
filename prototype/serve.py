#!/usr/bin/env python3
"""Serve the Plan Viewer prototype and a read-only view of the Org vault.

The vault is found the same way the Emacs config finds it, so there is one setting to change:
  --vault DIR  >  $PS_ORG_BASE  >  :current in ~/.emacs.d/vaults.eld
`?data=sample` on any /api/ call (or --sample) serves the synthetic vault in prototype/sample-vault.

GET /api/vault        folders and files after the Emacs exclusions
GET /api/file?path=   raw text of one listed .org file
GET /api/workspace    the vault's workspace.org (icons, folder order, tag meanings)
GET /api/task-icons   the Emacs task-icon cache, or {}
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
SAMPLE = HERE / "sample-vault"
TASK_ICON_CACHE = Path.home() / ".cache" / "ps-task-icons" / "task_cache.json"

# Mirrors ps/org-files-exclude-directories and ps/org-files-exclude-files in the Emacs config.
EXCLUDE_DIRS = [re.compile(r"\A\."), re.compile(r"\AJournal\Z"), re.compile(r"\AArchive\Z")]
EXCLUDE_FILES = [re.compile(r"\Ainit\.org\Z"), re.compile(r"\Aworkspace\.org\Z"), re.compile("conflicted copy")]


def resolve_vault(cli: str | None) -> Path | None:
    if cli:
        return Path(cli).expanduser()
    if os.environ.get("PS_ORG_BASE"):
        return Path(os.environ["PS_ORG_BASE"]).expanduser()
    registry = Path.home() / ".emacs.d" / "vaults.eld"
    if registry.exists():
        m = re.search(r':current\s+"([^"]+)"', registry.read_text(encoding="utf-8"))
        if m:
            return Path(m.group(1)).expanduser()
    return None


def list_files(root: Path) -> list[dict]:
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if not any(r.search(d) for r in EXCLUDE_DIRS))
        for name in filenames:
            if not name.endswith(".org") or any(r.search(name) for r in EXCLUDE_FILES):
                continue
            path = Path(dirpath) / name
            rel = path.relative_to(root).as_posix()
            st = path.stat()
            out.append(
                {
                    "path": rel,
                    "folder": rel.rsplit("/", 1)[0] if "/" in rel else "",
                    "base": name[:-4],
                    "name": name[:-4].replace("_", " "),
                    "mtime": int(st.st_mtime),
                    "size": st.st_size,
                }
            )
    # Agenda order: Emacs sorts the absolute paths with string<, which is plain code-point order.
    out.sort(key=lambda f: f["path"])
    return out


class Handler(SimpleHTTPRequestHandler):
    vault: Path | None = None
    sample_default = False

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(HERE), **kwargs)

    def log_message(self, fmt, *args):  # quieter: only errors
        if args and str(args[1])[:1] in "45":
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, obj, status=HTTPStatus.OK):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_text(self, text: str):
        body = text.encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def root_for(self, query) -> Path | None:
        data = query.get("data", ["sample" if self.sample_default else "real"])[0]
        return SAMPLE if data == "sample" or self.vault is None else self.vault

    def do_GET(self):
        url = urlparse(self.path)
        if not url.path.startswith("/api/"):
            if url.path.endswith((".py",)):
                return self.send_error(HTTPStatus.NOT_FOUND)
            return super().do_GET()
        query = parse_qs(url.query)
        root = self.root_for(query)
        if root is None or not root.is_dir():
            return self.send_json({"error": f"vault not found: {root}"}, HTTPStatus.NOT_FOUND)
        root = root.resolve()

        if url.path == "/api/vault":
            return self.send_json(
                {"name": root.name, "sample": root == SAMPLE.resolve(), "files": list_files(root)}
            )
        if url.path == "/api/file":
            rel = query.get("path", [""])[0]
            allowed = {f["path"] for f in list_files(root)}
            target = (root / rel).resolve()
            if rel not in allowed or not target.is_relative_to(root):
                return self.send_json({"error": "not a vault file"}, HTTPStatus.FORBIDDEN)
            return self.send_text(target.read_text(encoding="utf-8"))
        if url.path == "/api/workspace":
            ws = root / "workspace.org"
            return self.send_text(ws.read_text(encoding="utf-8") if ws.exists() else "")
        if url.path == "/api/task-icons":
            if root != SAMPLE.resolve() and TASK_ICON_CACHE.exists():
                return self.send_text(TASK_ICON_CACHE.read_text(encoding="utf-8"))
            return self.send_json({})
        return self.send_error(HTTPStatus.NOT_FOUND)

    def do_HEAD(self):
        return self.send_error(HTTPStatus.METHOD_NOT_ALLOWED)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--vault", help="Org directory (default: $PS_ORG_BASE, then ~/.emacs.d/vaults.eld)")
    ap.add_argument("--sample", action="store_true", help="serve the synthetic sample vault by default")
    ap.add_argument("--host", default="127.0.0.1", help="use 0.0.0.0 to open it from the iPad or phone")
    ap.add_argument("--port", type=int, default=8650)
    args = ap.parse_args(argv)

    Handler.vault = resolve_vault(args.vault)
    Handler.sample_default = args.sample
    if Handler.vault is None and not args.sample:
        print("No vault found; serving the sample. Pass --vault or set PS_ORG_BASE.", file=sys.stderr)
        Handler.sample_default = True
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    src = "sample" if Handler.sample_default else Handler.vault
    print(f"Plan Viewer prototype on http://{args.host}:{args.port}/  (data: {src})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
