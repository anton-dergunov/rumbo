// The vault's git repo on GitHub, through the REST API (docs/plans/real-app.md §3, "Remote
// interface"). Only api.github.com sends CORS headers, so the app talks to it directly: no proxy,
// and no third party sees the vault. Reads (head, tree, blob, commit, compare, log) and writes
// (blobs, trees, commits, the ref update, new branches) through the Git Data API.

import { base64ToBytes, bytesToBase64, blobSha, toBytes } from "./gitobj.js";

const API = "https://api.github.com";
const JSON_ACCEPT = "application/vnd.github+json";
const RAW_ACCEPT = "application/vnd.github.raw+json";
const TIMEOUT_MS = 15_000;

/**
 * A failed request, sorted into the classes the sync engine acts on:
 * - `offline`: a network error or a timeout; retry with backoff.
 * - `auth`: 401, or 403 without a rate limit; ask to sign in again.
 * - `rate-limited`: wait until `retryAt` (ms since the epoch).
 * - `missing`: 404; the repo or branch is wrong, or the token can't see it (GitHub answers 404
 *   rather than 403 for a private repo the token has no access to).
 * - `rejected`: 409 or 422; the request was refused as it stands (a ref update that is not a
 *   fast-forward, for example).
 * - `server`: 5xx and anything else unexpected; retry with backoff.
 */
export class RemoteError extends Error {
  constructor(kind, message, { status = null, retryAt = null, detail = "" } = {}) {
    super(message);
    this.name = "RemoteError";
    this.kind = kind;
    this.status = status;
    this.retryAt = retryAt;
    this.detail = detail;
  }
}

const MESSAGES = {
  offline: "GitHub can't be reached. Edits stay on this device until it can.",
  auth: "GitHub refused the token. Sign in again with a new token; nothing on this device is lost.",
  "rate-limited": "GitHub's hourly request limit is used up. Syncing waits until it resets.",
  missing: "GitHub can't find the repo or branch. Check the names, and that the token can see that repo.",
  rejected: "GitHub refused the change as it stands.",
  server: "GitHub had a problem. Syncing will try again shortly.",
};

/** The class of an HTTP failure, from its status and headers (`headers` has a `get`). */
export function classifyStatus(status, headers) {
  if (status === 401) return "auth";
  if (status === 403 || status === 429) {
    if (headers.get("x-ratelimit-remaining") === "0" || headers.get("retry-after")) return "rate-limited";
    return status === 429 ? "rate-limited" : "auth";
  }
  if (status === 404) return "missing";
  if (status === 409 || status === 422) return "rejected";
  return "server";
}

/** When a rate limit ends, in ms since the epoch, or null when the response doesn't say. */
function retryAtOf(headers, now = Date.now()) {
  const after = headers.get("retry-after");
  if (after && /^\d+$/.test(after)) return now + Number(after) * 1000;
  const reset = headers.get("x-ratelimit-reset");
  return reset && /^\d+$/.test(reset) ? Number(reset) * 1000 : null;
}

async function httpError(res) {
  const kind = classifyStatus(res.status, res.headers);
  let detail = "";
  try {
    detail = (await res.json()).message || "";
  } catch {
    // Not JSON; the status says enough.
  }
  return new RemoteError(kind, MESSAGES[kind], {
    status: res.status,
    retryAt: kind === "rate-limited" ? retryAtOf(res.headers) : null,
    detail,
  });
}

/** Path segments are encoded one by one, so `/` keeps separating folders. */
const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");

/**
 * A remote for one repo and branch. `fetch` is injected so tests run against a fake.
 * `limits` and `tokenExpiry` hold what the last response said about the rate limit and the token.
 */
export function createRemote({ owner, repo, branch = "main", token, fetch: fetchFn = globalThis.fetch, timeoutMs = TIMEOUT_MS, api = API }) {
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const remote = {
    owner,
    repo,
    branch,
    limits: null,
    // GitHub sends the token's expiry in `github-authentication-token-expiration`, but its CORS
    // policy doesn't expose that header, so in a browser this stays null and Setup asks for the date.
    tokenExpiry: null,
  };

  function note(headers) {
    const limit = headers.get("x-ratelimit-limit");
    if (limit) {
      remote.limits = {
        limit: Number(limit),
        remaining: Number(headers.get("x-ratelimit-remaining")),
        reset: Number(headers.get("x-ratelimit-reset")) * 1000,
        resource: headers.get("x-ratelimit-resource") || "",
      };
    }
    const expiry = headers.get("github-authentication-token-expiration");
    if (expiry) remote.tokenExpiry = expiry;
  }

  async function request(path, { method = "GET", accept = JSON_ACCEPT, etag = null, body } = {}) {
    const headers = { Accept: accept, "X-GitHub-Api-Version": "2022-11-28" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (etag) headers["If-None-Match"] = etag;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res;
    try {
      res = await fetchFn(api + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        // The app's own If-None-Match decides freshness; the browser's HTTP cache must not answer.
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timeout = e?.name === "TimeoutError" || e?.name === "AbortError";
      throw new RemoteError("offline", MESSAGES.offline, { detail: timeout ? "timed out" : String(e?.message || e) });
    }
    note(res.headers);
    if (res.status === 304) return res;
    if (!res.ok) throw await httpError(res);
    return res;
  }

  const json = async (path, opts) => (await request(path, opts)).json();

  /**
   * The branch head. With the ETag of the last answer, an unchanged head comes back as a 304,
   * which doesn't count against the rate limit: `{ changed: false, etag }`.
   */
  remote.head = async (etag = null) => {
    const res = await request(`${repoPath}/git/ref/heads/${encodePath(branch)}`, { etag });
    if (res.status === 304) return { changed: false, sha: null, etag };
    const ref = await res.json();
    return { changed: true, sha: ref.object.sha, etag: res.headers.get("etag") };
  };

  /** The whole tree of a commit or tree: `{ sha, entries: [{ path, type, mode, sha, size }] }`. */
  remote.tree = async (sha) => {
    const t = await json(`${repoPath}/git/trees/${encodeURIComponent(sha)}?recursive=1`);
    // Far beyond this vault's size (100,000 entries or 7 MB); a partial tree would look like
    // deleted files, so it is an error rather than a quiet loss.
    if (t.truncated) throw new RemoteError("server", "GitHub sent only part of the file list.", { detail: "tree truncated" });
    return { sha: t.sha, entries: t.tree.map(({ path, type, mode, sha, size }) => ({ path, type, mode, sha, size })) };
  };

  /** A blob's bytes. */
  remote.blob = async (sha) => {
    const b = await json(`${repoPath}/git/blobs/${encodeURIComponent(sha)}`);
    if (b.encoding !== "base64") throw new RemoteError("server", "GitHub sent a blob in an unexpected encoding.", { detail: b.encoding });
    return base64ToBytes(b.content);
  };

  /** A file's bytes by path, at `ref` (default: the branch). Used for notes in the Obsidian repo. */
  remote.raw = async (path, ref = branch) => {
    const res = await request(`${repoPath}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`, { accept: RAW_ACCEPT });
    return new Uint8Array(await res.arrayBuffer());
  };

  /** One commit's message, author, time, tree and parents, for the Sync page. */
  remote.commit = async (sha) => {
    const c = await json(`${repoPath}/git/commits/${encodeURIComponent(sha)}`);
    return {
      sha: c.sha,
      message: c.message,
      author: c.author?.name || "",
      date: c.author?.date || "",
      tree: c.tree.sha,
      parents: c.parents.map((p) => p.sha),
    };
  };

  /** How `head` relates to `base`: `{ status: "ahead" | "behind" | "identical" | "diverged", aheadBy, behindBy }`. */
  remote.compare = async (base, head) => {
    const c = await json(`${repoPath}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
    return { status: c.status, aheadBy: c.ahead_by, behindBy: c.behind_by };
  };

  /** Recent commits on the branch, optionally only those touching `path`. */
  remote.log = async ({ path = null, perPage = 30 } = {}) => {
    const q = new URLSearchParams({ sha: branch, per_page: String(perPage) });
    if (path) q.set("path", path);
    const list = await json(`${repoPath}/commits?${q}`);
    return list.map((c) => ({
      sha: c.sha,
      message: c.commit.message,
      author: c.commit.author?.name || "",
      date: c.commit.author?.date || "",
      parents: c.parents.map((p) => p.sha),
    }));
  };

  // ------------------------------------------------------------------------------ writing

  /** Upload a blob; returns its SHA, checked against the SHA computed here. */
  remote.createBlob = async (data) => {
    const bytes = toBytes(data);
    const [res, mine] = await Promise.all([json(`${repoPath}/git/blobs`, { method: "POST", body: { content: bytesToBase64(bytes), encoding: "base64" } }), blobSha(bytes)]);
    if (res.sha !== mine) throw new RemoteError("server", "GitHub stored a file with a different checksum.", { detail: `${mine.slice(0, 7)} became ${String(res.sha).slice(0, 7)}` });
    return res.sha;
  };

  /** A tree on `baseTree` with `entries` [{path, sha}] (sha null deletes the path); returns its SHA. */
  remote.createTree = async (baseTree, entries) => {
    const tree = entries.map(({ path, sha }) => ({ path, mode: "100644", type: "blob", sha }));
    return (await json(`${repoPath}/git/trees`, { method: "POST", body: { base_tree: baseTree, tree } })).sha;
  };

  /** A commit object (the branch doesn't move): `{ sha, tree }`. */
  remote.createCommit = async ({ message, tree, parents }) => {
    const c = await json(`${repoPath}/git/commits`, { method: "POST", body: { message, tree, parents } });
    return { sha: c.sha, tree: c.tree?.sha || tree };
  };

  /**
   * A commit of `files` ({path: text}) on `parent`, whose tree is `baseTree`: one blob per file,
   * then the tree, then the commit (§3). The branch doesn't move. Returns `{ sha, tree, blobs }`.
   */
  remote.makeCommit = async (parent, baseTree, files, message) => {
    const paths = Object.keys(files);
    const shas = await Promise.all(paths.map((p) => remote.createBlob(files[p])));
    const blobs = Object.fromEntries(paths.map((p, i) => [p, shas[i]]));
    const tree = await remote.createTree(baseTree, paths.map((p) => ({ path: p, sha: blobs[p] })));
    const c = await remote.createCommit({ message, tree, parents: [parent] });
    return { sha: c.sha, tree, blobs };
  };

  /** Move the branch to `sha`, only as a fast-forward. Anything else is `rejected` (422). */
  remote.updateRef = async (sha) => {
    await json(`${repoPath}/git/refs/heads/${encodePath(branch)}`, { method: "PATCH", body: { sha, force: false } });
  };

  /** A new branch `name` at `sha` (the rescue branch). */
  remote.createBranch = async (name, sha) => {
    await json(`${repoPath}/git/refs`, { method: "POST", body: { ref: `refs/heads/${name}`, sha } });
  };

  return remote;
}
