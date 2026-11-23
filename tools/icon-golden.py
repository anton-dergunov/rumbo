"""The Python half of Rumbo's icon checks: the answers of agentic-org-planner's matcher.

Run by tools/icon-golden.mjs and tools/icon-check.mjs with uv, never by the app:

  uv run --no-project python -I tools/icon-golden.py --queries MATCHER.py < {spec, tasks}
      -> the query text of each task (org-plain, "<parent>: <title>")
  uv run --no-project --with onnxruntime --with tokenizers --with numpy \
      python -I tools/icon-golden.py --golden MATCHER.py MODEL_DIR BUNDLE_DIR < {spec, tasks, texts}
      -> {tasks: [{query, ids, icon, z}], texts: [{text, ids}]}

MODEL_DIR holds model_int8.onnx and tokenizer.json; BUNDLE_DIR the bundle (manifest.json, ...).
"""

import importlib.util
import json
import sys
from pathlib import Path


def load_matcher(path):
    spec = importlib.util.spec_from_file_location("org_task_icon_matcher", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    mode, matcher_path = sys.argv[1], sys.argv[2]
    m = load_matcher(matcher_path)
    req = json.loads(sys.stdin.read())
    if mode == "--queries":
        print(json.dumps([m.compose_query(t, req["spec"]) for t in req["tasks"]], ensure_ascii=False))
        return

    import numpy as np
    import onnxruntime as ort
    from tokenizers import Tokenizer

    model_dir, bundle_dir = Path(sys.argv[3]), Path(sys.argv[4])
    manifest = json.loads((bundle_dir / "manifest.json").read_text(encoding="utf-8"))
    enc_spec = manifest["encoder"]
    model_file = model_dir / enc_spec["model"]["url"].rsplit("/", 1)[-1]

    class LocalEncoder(m.Encoder):
        """The matcher's encoder, on local files instead of downloaded ones."""

        def __init__(self):
            self.tokenizer = Tokenizer.from_file(str(model_dir / "tokenizer.json"))
            self.tokenizer.enable_truncation(enc_spec["max_length"])
            opts = ort.SessionOptions()
            opts.log_severity_level = 3
            opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
            self.session = ort.InferenceSession(str(model_file), opts, providers=["CPUExecutionProvider"])
            self.inputs = {i.name for i in self.session.get_inputs()}
            self.prefix = enc_spec["query_prefix"]

    enc = LocalEncoder()
    matcher = m.Matcher(bundle_dir, encoder=enc)
    ids = lambda text: enc.tokenizer.encode(enc.prefix + text).ids
    out_tasks = []
    for t in req["tasks"]:
        q = m.compose_query(t, req["spec"])
        scores = matcher.dense @ enc.encode(q) + matcher.prior
        out_tasks.append({
            "query": q,
            "ids": ids(q),
            "icon": matcher.names[int(np.argmax(scores))],
            "z": round(m.confidence(scores), 4),
        })
    out_texts = [{"text": x, "ids": ids(x)} for x in req.get("texts", [])]
    print(json.dumps({"tasks": out_tasks, "texts": out_texts}, ensure_ascii=False))


if __name__ == "__main__":
    main()
