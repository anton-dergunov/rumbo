"""The prototype server's save endpoint: version checks, two-file saves, and a read-only real vault.

Run: uv run python -m unittest discover tests
"""

import json
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "prototype"))
import serve  # noqa: E402


class SaveTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        cls.real = cls.tmp / "real"
        shutil.copytree(serve.SAMPLE, cls.real)
        serve.Handler.vault = cls.real
        serve.Handler.work = cls.tmp / "work"
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), serve.Handler)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        shutil.rmtree(cls.tmp)

    def setUp(self):
        self.post("/api/sample/reset", {"data": "sample"})

    def get(self, path):
        with urlopen(self.base + path) as r:
            return r.read().decode(), r.headers.get("ETag", "").strip('"')

    def post(self, path, body):
        req = Request(self.base + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urlopen(req) as r:
                return r.status, json.loads(r.read())
        except HTTPError as e:
            return e.code, json.loads(e.read())

    def test_save_then_conflict(self):
        text, version = self.get("/api/file?data=sample&path=Inbox.org")
        status, reply = self.post("/api/save", {"data": "sample", "files": [{"path": "Inbox.org", "version": version, "text": text + "* New\n"}]})
        self.assertEqual(status, 200)
        self.assertTrue((serve.Handler.work / "Inbox.org").read_text().endswith("* New\n"))
        self.assertNotIn("* New", (serve.SAMPLE / "Inbox.org").read_text(), "the committed sample is never written")
        # The old version no longer matches.
        status, reply = self.post("/api/save", {"data": "sample", "files": [{"path": "Inbox.org", "version": version, "text": text}]})
        self.assertEqual(status, 409)
        self.assertTrue(reply["conflicts"][0]["text"].endswith("* New\n"))
        self.assertEqual(reply["conflicts"][0]["version"], self.get("/api/file?data=sample&path=Inbox.org")[1])

    def test_two_files_all_or_nothing(self):
        a, va = self.get("/api/file?data=sample&path=Inbox.org")
        b, vb = self.get("/api/file?data=sample&path=Misc.org")
        status, _ = self.post("/api/save", {"data": "sample", "files": [{"path": "Inbox.org", "version": va, "text": a + "x\n"}, {"path": "Misc.org", "version": "stale", "text": b + "y\n"}]})
        self.assertEqual(status, 409)
        self.assertEqual(self.get("/api/file?data=sample&path=Inbox.org")[0], a, "nothing was written")
        status, reply = self.post("/api/save", {"data": "sample", "files": [{"path": "Inbox.org", "version": va, "text": a + "x\n"}, {"path": "Misc.org", "version": vb, "text": b + "y\n"}]})
        self.assertEqual(status, 200)
        self.assertEqual(len(reply["saved"]), 2)

    def test_real_vault_and_bad_paths_refused(self):
        text, version = self.get("/api/file?data=real&path=Inbox.org")
        status, _ = self.post("/api/save", {"data": "real", "files": [{"path": "Inbox.org", "version": version, "text": ""}]})
        self.assertEqual(status, 403)
        self.assertEqual((self.real / "Inbox.org").read_text(), text)
        status, _ = self.post("/api/save", {"data": "sample", "files": [{"path": "../serve.py", "version": "", "text": ""}]})
        self.assertEqual(status, 403)
        status, _ = self.post("/api/save", {"data": "sample", "files": [{"path": "workspace.org", "version": "", "text": ""}]})
        self.assertEqual(status, 403)


if __name__ == "__main__":
    unittest.main()
