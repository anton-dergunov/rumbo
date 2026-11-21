#!/usr/bin/env python3
"""Serve the Plan Viewer prototype and a read-only view of the Org vault.

The vault is found the same way the Emacs config finds it, so there is one setting to change:
  --vault DIR  >  $PS_ORG_BASE  >  :current in ~/.emacs.d/vaults.eld
`?data=sample` on any /api/ call (or --sample) serves the synthetic vault in prototype/sample-vault.

GET  /api/vault         folders and files after the Emacs exclusions
GET  /api/file?path=    raw text of one listed .org file; its ETag is the version a save must match
GET  /api/workspace     the vault's workspace.org (icons, folder order, tag meanings)
GET  /api/task-icons    the Emacs task-icon cache, or {}
POST /api/save          {data, files: [{path, version, text}]}: write files whose version still matches
POST /api/sample/reset  copy the committed sample vault over the working copy again

Saving is allowed only for the sample vault, and it writes to a working copy in .sample-work/
(gitignored), never to the committed sample-vault/. The real vault is read-only in the prototype.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import threading
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
SAMPLE = HERE / "sample-vault"
WORK = HERE / ".sample-work"  # the editable copy of the sample vault
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


def version_of(data: bytes) -> str:
    """A file's version: a hash of its bytes, because Dropbox and editors touch mtimes freely."""
    return hashlib.sha256(data).hexdigest()[:32]


_work_lock = threading.Lock()


def ensure_work(work: Path, reset: bool = False) -> Path:
    """Create (or recreate) the editable copy of the sample vault. Locked, so no request reads a half-made copy."""
    with _work_lock:
        if reset and work.exists():
            shutil.rmtree(work)
        if not work.exists():
            tmp = work.with_name(work.name + ".new")
            shutil.rmtree(tmp, ignore_errors=True)
            shutil.copytree(SAMPLE, tmp)
            os.replace(tmp, work)
    return work


def write_atomic(path: Path, text: str) -> None:
    """Write through a temporary file and rename it over the old one, so a reader never sees half a file."""
    tmp = path.with_name(f".{path.name}.tmp")
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    shutil.copymode(path, tmp)
    os.replace(tmp, path)


class Handler(SimpleHTTPRequestHandler):
    vault: Path | None = None
    sample_default = False
    work: Path = WORK

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

    def send_text(self, text: str, etag: str | None = None):
        body = text.encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        if etag:
            self.send_header("ETag", f'"{etag}"')
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def root_for(self, query) -> Path | None:
        data = query.get("data", ["sample" if self.sample_default else "real"])[0]
        return ensure_work(self.work) if data == "sample" or self.vault is None else self.vault

    def is_sample(self, root: Path) -> bool:
        return root.resolve() == self.work.resolve()

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
                {"name": root.name, "sample": self.is_sample(root), "writable": self.is_sample(root), "files": list_files(root)}
            )
        if url.path == "/api/file":
            rel = query.get("path", [""])[0]
            allowed = {f["path"] for f in list_files(root)}
            target = (root / rel).resolve()
            if rel not in allowed or not target.is_relative_to(root):
                return self.send_json({"error": "not a vault file"}, HTTPStatus.FORBIDDEN)
            data = target.read_bytes()
            return self.send_text(data.decode("utf-8"), etag=version_of(data))
        if url.path == "/api/workspace":
            ws = root / "workspace.org"
            return self.send_text(ws.read_text(encoding="utf-8") if ws.exists() else "")
        if url.path == "/api/task-icons":
            if not self.is_sample(root) and TASK_ICON_CACHE.exists():
                return self.send_text(TASK_ICON_CACHE.read_text(encoding="utf-8"))
            return self.send_json({})
        return self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self):
        url = urlparse(self.path)
        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self.send_json({"error": "bad request"}, HTTPStatus.BAD_REQUEST)
        root = self.root_for({"data": [payload.get("data", "real")]})
        if root is None or not root.is_dir():
            return self.send_json({"error": "vault not found"}, HTTPStatus.NOT_FOUND)
        if not self.is_sample(root):
            return self.send_json({"error": "the real vault is read-only in the prototype"}, HTTPStatus.FORBIDDEN)
        root = root.resolve()

        if url.path == "/api/sample/reset":
            ensure_work(self.work, reset=True)
            return self.send_json({"ok": True})
        if url.path != "/api/save":
            return self.send_error(HTTPStatus.NOT_FOUND)

        files = payload.get("files") or []
        allowed = {f["path"] for f in list_files(root)}
        targets = []
        for f in files:
            rel = f.get("path", "")
            target = (root / rel).resolve()
            if rel not in allowed or not target.is_relative_to(root) or not isinstance(f.get("text"), str):
                return self.send_json({"error": f"not a vault file: {rel}"}, HTTPStatus.FORBIDDEN)
            targets.append((rel, target, f))
        # Check every file before writing any, so a move between two files is all or nothing.
        conflicts = []
        for rel, target, f in targets:
            data = target.read_bytes()
            if version_of(data) != f.get("version"):
                conflicts.append({"path": rel, "version": version_of(data), "text": data.decode("utf-8")})
        if conflicts:
            return self.send_json({"error": "changed since it was read", "conflicts": conflicts}, HTTPStatus.CONFLICT)
        saved = []
        for rel, target, f in targets:
            write_atomic(target, f["text"])
            saved.append({"path": rel, "version": version_of(f["text"].encode("utf-8"))})
        return self.send_json({"saved": saved})

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
    ensure_work(Handler.work)
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
