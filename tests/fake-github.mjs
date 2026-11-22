// An in-memory GitHub for one repo (docs/plans/real-app.md §8, "A fake GitHub"), behind an
// injected `fetch`, so remote-github.js and sync.js run against it unchanged.
//
// Read side: refs with ETags and 304s, recursive trees, blobs, commits, compare and the commit
// list. Write side: blobs, trees (with base_tree), commits, the ref update (only a fast-forward,
// as GitHub does with force: false) and new branches. Objects are hashed the way git hashes
// them. Failures can be injected per request, before it is carried out or after (the answer is
// lost), and `beforeRequest` lets another actor (Emacs) push between any two requests.

import { createHash } from "node:crypto";

const sha1 = (...parts) => {
  const h = createHash("sha1");
  for (const p of parts) h.update(p);
  return h.digest("hex");
};
const enc = new TextEncoder();
const toBytes = (data) => (typeof data === "string" ? enc.encode(data) : data);

function gitObject(type, body) {
  const bytes = toBytes(body);
  return sha1(enc.encode(`${type} ${bytes.byteLength}\0`), bytes);
}

export function createFakeGitHub({ owner = "me", repo = "vault", branch = "main", rateLimit = 5000 } = {}) {
  const blobs = new Map(); // sha -> bytes
  const trees = new Map(); // sha -> [{ name, mode, type, sha }]
  const commits = new Map(); // sha -> { tree, parents, message, author, date }
  const refs = new Map(); // branch -> commit sha
  const failures = [];
  const calls = [];
  let requests = 0;
  let remaining = rateLimit;
  let clock = Date.parse("2026-11-01T09:00:00Z");

  function putBlob(data) {
    const bytes = toBytes(data);
    const sha = gitObject("blob", bytes);
    blobs.set(sha, bytes);
    return sha;
  }

  /** A tree from `{ path: bytes|text }`, written the way git writes trees; returns its SHA. */
  function putTree(files) {
    const here = new Map();
    const sub = new Map();
    for (const [path, data] of Object.entries(files)) {
      const slash = path.indexOf("/");
      if (slash < 0) here.set(path, data);
      else {
        const dir = path.slice(0, slash);
        if (!sub.has(dir)) sub.set(dir, {});
        sub.get(dir)[path.slice(slash + 1)] = data;
      }
    }
    const entries = [];
    for (const [name, data] of here) entries.push({ name, mode: "100644", type: "blob", sha: data?.blobSha || putBlob(data) });
    for (const [name, inner] of sub) entries.push({ name, mode: "40000", type: "tree", sha: putTree(inner) });
    // Git orders entries by name, a directory as if its name ended in "/".
    const sortKey = (e) => (e.type === "tree" ? `${e.name}/` : e.name);
    entries.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
    const parts = entries.flatMap((e) => [enc.encode(`${e.mode} ${e.name}\0`), Buffer.from(e.sha, "hex")]);
    const body = Buffer.concat(parts);
    const sha = gitObject("tree", body);
    trees.set(sha, entries);
    return sha;
  }

  function flatten(treeSha, prefix = "") {
    const out = [];
    for (const e of trees.get(treeSha)) {
      const path = prefix + e.name;
      if (e.type === "tree") {
        out.push({ path, mode: e.mode, type: "tree", sha: e.sha });
        out.push(...flatten(e.sha, `${path}/`));
      } else out.push({ path, mode: e.mode, type: "blob", sha: e.sha, size: blobs.get(e.sha).byteLength });
    }
    return out;
  }

  const filesAt = (commitSha) => {
    if (!commitSha) return {};
    const out = {};
    for (const e of flatten(commits.get(commitSha).tree)) if (e.type === "blob") out[e.path] = blobs.get(e.sha);
    return out;
  };

  function makeCommit(tree, parents, message, author = "Emacs") {
    clock += 60_000;
    const date = new Date(clock).toISOString();
    const stamp = `${author} <${author.toLowerCase()}@example.com> ${Math.floor(clock / 1000)} +0000`;
    const body = [`tree ${tree}`, ...parents.map((p) => `parent ${p}`), `author ${stamp}`, `committer ${stamp}`, "", message].join("\n");
    const sha = gitObject("commit", body);
    commits.set(sha, { tree, parents, message, author, date });
    return sha;
  }

  /** Ancestors of a commit, with their distance (first match wins). */
  function ancestry(sha) {
    const dist = new Map([[sha, 0]]);
    const queue = [sha];
    while (queue.length) {
      const c = queue.shift();
      for (const p of commits.get(c)?.parents || []) {
        if (!dist.has(p)) {
          dist.set(p, dist.get(c) + 1);
          queue.push(p);
        }
      }
    }
    return dist;
  }

  // ------------------------------------------------------------------- what tests do to it

  const fake = {
    owner,
    repo,
    branch,
    calls,
    blobs,
    commits,
    head: () => refs.get(branch) || null,
    ref: (name) => refs.get(name) || null,
    /** The files of a commit as text: { path: text }. */
    filesAt: (sha) => Object.fromEntries(Object.entries(filesAt(sha)).map(([p, b]) => [p, new TextDecoder().decode(b)])),
    /** The first-parent history of the branch, newest first: [{ sha, message, author, parents }]. */
    log(name = branch) {
      const out = [];
      for (let sha = refs.get(name); sha; sha = commits.get(sha).parents[0]) out.push({ sha, ...commits.get(sha) });
      return out;
    },
    /** Called before each request is handled, with its number (from 1), method and path. */
    beforeRequest: null,
    /**
     * Commit on the branch (as Emacs would push): `changes` maps a path to its new text, or to
     * null to delete it. Returns the new commit's SHA.
     */
    push(changes, message = "Auto backup", author = "Emacs") {
      const parent = refs.get(branch) || null;
      const files = { ...filesAt(parent) };
      for (const [path, data] of Object.entries(changes)) {
        if (data === null) delete files[path];
        else files[path] = data;
      }
      const sha = makeCommit(putTree(files), parent ? [parent] : [], message, author);
      refs.set(branch, sha);
      return sha;
    },
    /** Rewrite the branch: a new root commit with exactly `files`. */
    forcePush(files, message = "Rewritten") {
      const sha = makeCommit(putTree(files), [], message);
      refs.set(branch, sha);
      return sha;
    },
    /**
     * Make matching requests fail. `match(path, init)` picks them; `times` how many (default 1).
     * `status` with optional `headers`, or `network: true` for a request that never arrives, or
     * `after: true` for one that is carried out but whose answer is lost.
     */
    fail({ match = () => true, times = 1, status = 500, headers = {}, network = false, after = false, message = "fake failure" }) {
      failures.push({ match, times, status, headers, network, after, message });
    },
    rateLimit: () => remaining,
    requests: () => requests,
    fetch: async (url, init = {}) => {
      const u = new URL(url);
      const n = ++requests;
      await fake.beforeRequest?.(n, init.method || "GET", decodeURIComponent(u.pathname));
      return handle(u, init);
    },
  };

  // ------------------------------------------------------------------------- the endpoints

  const limitHeaders = () => ({
    "x-ratelimit-limit": String(rateLimit),
    "x-ratelimit-remaining": String(remaining),
    "x-ratelimit-reset": String(Math.floor(clock / 1000) + 3600),
    "x-ratelimit-resource": "core",
  });
  const json = (body, status = 200, extra = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...limitHeaders(), ...extra } });
  const notFound = () => json({ message: "Not Found" }, 404);

  async function handle(url, init) {
    const path = decodeURIComponent(url.pathname);
    const method = init.method || "GET";
    calls.push(`${method} ${path}${url.search}`);
    const header = (name) => {
      const h = init.headers || {};
      const k = Object.keys(h).find((x) => x.toLowerCase() === name);
      return k ? h[k] : null;
    };

    const failure = failures.find((f) => f.times > 0 && f.match(path, init));
    if (failure) {
      failure.times -= 1;
      if (failure.after) {
        await serve(url, init, path, method, header);
        throw new TypeError("Failed to fetch");
      }
      if (failure.network) throw new TypeError("Failed to fetch");
      return json({ message: failure.message }, failure.status, failure.headers);
    }
    return serve(url, init, path, method, header);
  }

  async function serve(url, init, path, method, header) {
    const prefix = `/repos/${owner}/${repo}`;
    if (!path.startsWith(prefix)) return notFound();
    const rest = path.slice(prefix.length);
    let m;

    const body = () => JSON.parse(init.body || "{}");

    if (method === "POST" && rest === "/git/blobs") {
      remaining -= 1;
      const b = body();
      if (b.encoding !== "base64") return json({ message: "encoding" }, 422);
      return json({ sha: putBlob(new Uint8Array(Buffer.from(b.content, "base64"))) }, 201);
    }
    if (method === "POST" && rest === "/git/trees") {
      remaining -= 1;
      const b = body();
      const files = {};
      if (b.base_tree) {
        if (!trees.has(b.base_tree)) return json({ message: "base_tree not found" }, 422);
        for (const e of flatten(b.base_tree)) if (e.type === "blob") files[e.path] = { blobSha: e.sha };
      }
      for (const e of b.tree || []) {
        if (e.sha === null) delete files[e.path];
        else if (!blobs.has(e.sha)) return json({ message: `blob ${e.sha} not found` }, 422);
        else files[e.path] = { blobSha: e.sha };
      }
      return json({ sha: putTree(files) }, 201);
    }
    if (method === "POST" && rest === "/git/commits") {
      remaining -= 1;
      const b = body();
      if (!trees.has(b.tree) || (b.parents || []).some((p) => !commits.has(p))) return json({ message: "tree or parent not found" }, 422);
      const sha = makeCommit(b.tree, b.parents || [], b.message, "Rumbo");
      return json({ sha, tree: { sha: b.tree }, parents: (b.parents || []).map((p) => ({ sha: p })), message: b.message }, 201);
    }
    if (method === "PATCH" && (m = rest.match(/^\/git\/refs\/heads\/(.+)$/))) {
      remaining -= 1;
      const b = body();
      const cur = refs.get(m[1]);
      if (!cur) return json({ message: "Reference does not exist" }, 422);
      if (!commits.has(b.sha)) return json({ message: "Object does not exist" }, 422);
      if (!b.force && !ancestry(b.sha).has(cur)) return json({ message: "Update is not a fast forward" }, 422);
      refs.set(m[1], b.sha);
      return json({ ref: `refs/heads/${m[1]}`, object: { sha: b.sha, type: "commit" } });
    }
    if (method === "POST" && rest === "/git/refs") {
      remaining -= 1;
      const b = body();
      const name = String(b.ref || "").replace(/^refs\/heads\//, "");
      if (refs.has(name)) return json({ message: "Reference already exists" }, 422);
      if (!commits.has(b.sha)) return json({ message: "Object does not exist" }, 422);
      refs.set(name, b.sha);
      return json({ ref: `refs/heads/${name}`, object: { sha: b.sha, type: "commit" } }, 201);
    }

    if ((m = rest.match(/^\/git\/ref\/heads\/(.+)$/))) {
      const sha = refs.get(m[1]);
      if (!sha) return notFound();
      const etag = `W/"${sha}"`;
      // A conditional request that matches costs nothing, as on GitHub.
      if (header("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag, ...limitHeaders() } });
      remaining -= 1;
      return json({ ref: `refs/heads/${m[1]}`, object: { sha, type: "commit" } }, 200, { etag });
    }
    remaining -= 1;

    if ((m = rest.match(/^\/git\/trees\/([0-9a-f]{40})$/))) {
      const tree = commits.has(m[1]) ? commits.get(m[1]).tree : m[1];
      if (!trees.has(tree)) return notFound();
      const entries = url.searchParams.get("recursive") ? flatten(tree) : trees.get(tree).map((e) => ({ path: e.name, mode: e.mode, type: e.type, sha: e.sha }));
      return json({ sha: tree, tree: entries, truncated: false });
    }
    if ((m = rest.match(/^\/git\/blobs\/([0-9a-f]{40})$/))) {
      const bytes = blobs.get(m[1]);
      if (!bytes) return notFound();
      // GitHub wraps base64 at 60 characters.
      const b64 = Buffer.from(bytes).toString("base64").replace(/.{60}/g, "$&\n");
      return json({ sha: m[1], size: bytes.byteLength, content: b64, encoding: "base64" });
    }
    if ((m = rest.match(/^\/git\/commits\/([0-9a-f]{40})$/))) {
      const c = commits.get(m[1]);
      if (!c) return notFound();
      return json({ sha: m[1], message: c.message, author: { name: c.author, date: c.date }, tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })) });
    }
    if ((m = rest.match(/^\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/))) {
      const [, base, head] = m;
      if (!commits.has(base) || !commits.has(head)) return notFound();
      const up = ancestry(head);
      const down = ancestry(base);
      if (base === head) return json({ status: "identical", ahead_by: 0, behind_by: 0 });
      if (up.has(base)) return json({ status: "ahead", ahead_by: up.get(base), behind_by: 0 });
      if (down.has(head)) return json({ status: "behind", ahead_by: 0, behind_by: down.get(head) });
      return json({ status: "diverged", ahead_by: up.size, behind_by: down.size });
    }
    if (rest === "/commits") {
      let sha = refs.get(url.searchParams.get("sha") || branch);
      const only = url.searchParams.get("path");
      const perPage = Number(url.searchParams.get("per_page") || 30);
      const list = [];
      while (sha && list.length < perPage) {
        const c = commits.get(sha);
        const before = filesAt(c.parents[0]);
        const after = filesAt(sha);
        const touched = !only || Buffer.compare(Buffer.from(before[only] || []), Buffer.from(after[only] || [])) !== 0 || (only in before) !== (only in after);
        if (touched) list.push({ sha, commit: { message: c.message, author: { name: c.author, date: c.date } }, parents: c.parents.map((p) => ({ sha: p })) });
        sha = c.parents[0];
      }
      return json(list);
    }
    return notFound();
  }

  return fake;
}
