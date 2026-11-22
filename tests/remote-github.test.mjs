import { test } from "node:test";
import assert from "node:assert/strict";
import { createRemote, classifyStatus, RemoteError } from "../app/remote-github.js";
import { blobSha, bytesToBase64, bytesToText, toBytes } from "../app/gitobj.js";

/** A fake fetch: `routes` maps "METHOD path" to a handler returning { status, body, headers }. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    const u = new URL(url);
    const key = `${init.method} ${u.pathname}${u.search}`;
    calls.push({ key, init });
    const handler = routes[key];
    if (!handler) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    const r = await handler(init);
    if (r instanceof Error) throw r;
    const body = r.raw ?? (r.body === undefined ? null : JSON.stringify(r.body));
    return new Response(r.status === 304 ? null : body, { status: r.status || 200, headers: r.headers || {} });
  };
  fn.calls = calls;
  return fn;
}

const remoteWith = (routes, extra = {}) => {
  const fetch = fakeFetch(routes);
  return { fetch, remote: createRemote({ owner: "me", repo: "notes", branch: "main", token: "t0k", fetch, ...extra }) };
};

const LIMITS = { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4999", "x-ratelimit-reset": "1800000000", "x-ratelimit-resource": "core" };

test("head sends the token and API version, and reads the SHA and ETag", async () => {
  const { fetch, remote } = remoteWith({
    "GET /repos/me/notes/git/ref/heads/main": () => ({ body: { object: { sha: "abc" } }, headers: { etag: 'W/"e1"', ...LIMITS } }),
  });
  assert.deepEqual(await remote.head(), { changed: true, sha: "abc", etag: 'W/"e1"' });
  const { init } = fetch.calls[0];
  assert.equal(init.headers.Authorization, "Bearer t0k");
  assert.equal(init.headers["X-GitHub-Api-Version"], "2022-11-28");
  assert.equal(init.cache, "no-store");
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(remote.limits, { limit: 5000, remaining: 4999, reset: 1800000000000, resource: "core" });
});

test("head with the last ETag: a 304 means unchanged", async () => {
  const { fetch, remote } = remoteWith({
    "GET /repos/me/notes/git/ref/heads/main": (init) => (init.headers["If-None-Match"] === 'W/"e1"' ? { status: 304 } : { body: { object: { sha: "abc" } } }),
  });
  assert.deepEqual(await remote.head('W/"e1"'), { changed: false, sha: null, etag: 'W/"e1"' });
  assert.equal(fetch.calls[0].init.headers["If-None-Match"], 'W/"e1"');
});

test("tree and blob: entries kept, base64 decoded, SHA checks out", async () => {
  const text = "* TODO Ünïcode task\nbody\n";
  const sha = await blobSha(text);
  const b64 = bytesToBase64(toBytes(text)).replace(/(.{20})/g, "$1\n");
  const { remote } = remoteWith({
    "GET /repos/me/notes/git/trees/c1?recursive=1": () => ({
      body: { sha: "t1", truncated: false, tree: [{ path: "Inbox.org", type: "blob", mode: "100644", sha, size: 30, url: "x" }] },
    }),
    [`GET /repos/me/notes/git/blobs/${sha}`]: () => ({ body: { sha, encoding: "base64", content: b64 } }),
  });
  const tree = await remote.tree("c1");
  assert.deepEqual(tree, { sha: "t1", entries: [{ path: "Inbox.org", type: "blob", mode: "100644", sha, size: 30 }] });
  const bytes = await remote.blob(sha);
  assert.equal(bytesToText(bytes), text);
  assert.equal(await blobSha(bytes), sha);
});

test("a truncated tree is an error, never a partial file list", async () => {
  const { remote } = remoteWith({ "GET /repos/me/notes/git/trees/c1?recursive=1": () => ({ body: { sha: "t1", truncated: true, tree: [] } }) });
  await assert.rejects(remote.tree("c1"), (e) => e instanceof RemoteError && e.kind === "server");
});

test("raw fetches a file by path, folders and spaces encoded per segment", async () => {
  const { fetch, remote } = remoteWith({
    "GET /repos/me/notes/contents/10%20Notes/Financial%20plan.md?ref=main": () => ({ raw: "# Plan\n" }),
  });
  assert.equal(bytesToText(await remote.raw("10 Notes/Financial plan.md")), "# Plan\n");
  assert.equal(fetch.calls[0].init.headers.Accept, "application/vnd.github.raw+json");
});

test("commit, compare and log are mapped to plain objects", async () => {
  const { remote } = remoteWith({
    "GET /repos/me/notes/git/commits/c2": () => ({
      body: { sha: "c2", message: "Auto backup", author: { name: "A", date: "2026-11-22T10:00:00Z" }, tree: { sha: "t2" }, parents: [{ sha: "c1" }] },
    }),
    "GET /repos/me/notes/compare/c1...c2": () => ({ body: { status: "ahead", ahead_by: 1, behind_by: 0 } }),
    "GET /repos/me/notes/commits?sha=main&per_page=2&path=Inbox.org": () => ({
      body: [{ sha: "c2", commit: { message: "m", author: { name: "A", date: "d" } }, parents: [{ sha: "c1" }] }],
    }),
  });
  assert.deepEqual(await remote.commit("c2"), { sha: "c2", message: "Auto backup", author: "A", date: "2026-11-22T10:00:00Z", tree: "t2", parents: ["c1"] });
  assert.deepEqual(await remote.compare("c1", "c2"), { status: "ahead", aheadBy: 1, behindBy: 0 });
  assert.deepEqual(await remote.log({ path: "Inbox.org", perPage: 2 }), [{ sha: "c2", message: "m", author: "A", date: "d", parents: ["c1"] }]);
});

test("failure classes", async () => {
  const cases = [
    [{ status: 401, body: { message: "Bad credentials" } }, "auth"],
    [{ status: 403, body: { message: "Resource not accessible" } }, "auth"],
    [{ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" } }, "rate-limited"],
    [{ status: 429, headers: { "retry-after": "60" } }, "rate-limited"],
    [{ status: 404, body: { message: "Not Found" } }, "missing"],
    [{ status: 422, body: { message: "Update is not a fast forward" } }, "rejected"],
    [{ status: 502 }, "server"],
  ];
  for (const [response, kind] of cases) {
    const { remote } = remoteWith({ "GET /repos/me/notes/git/ref/heads/main": () => response });
    await assert.rejects(remote.head(), (e) => {
      assert.ok(e instanceof RemoteError);
      assert.equal(e.kind, kind, `status ${response.status}`);
      assert.equal(e.status, response.status);
      if (response.body?.message) assert.equal(e.detail, response.body.message);
      return true;
    });
  }
});

test("a rate limit says when it ends", async () => {
  const { remote } = remoteWith({
    "GET /repos/me/notes/git/ref/heads/main": () => ({ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" } }),
  });
  await assert.rejects(remote.head(), (e) => e.retryAt === 1800000000000);
});

test("a network error and a timeout are both offline", async () => {
  const { remote } = remoteWith({ "GET /repos/me/notes/git/ref/heads/main": () => new TypeError("Load failed") });
  await assert.rejects(remote.head(), (e) => e.kind === "offline" && e.status === null);

  const slow = createRemote({
    owner: "me",
    repo: "notes",
    token: "t",
    timeoutMs: 20,
    // A request that never answers. The held timer keeps Node's event loop alive until the abort:
    // AbortSignal.timeout's own timer doesn't (Node 22), and the test would be cancelled.
    fetch: (url, init) =>
      new Promise((_, reject) => {
        const hold = setTimeout(() => {}, 5000);
        init.signal.addEventListener("abort", () => (clearTimeout(hold), reject(init.signal.reason)));
      }),
  });
  await assert.rejects(slow.head(), (e) => e.kind === "offline" && e.detail === "timed out");
});

test("classifyStatus without a rate-limit header: 403 is auth, 429 is still a rate limit", () => {
  const none = new Headers();
  assert.equal(classifyStatus(403, none), "auth");
  assert.equal(classifyStatus(429, none), "rate-limited");
  assert.equal(classifyStatus(500, none), "server");
});

// ------------------------------------------------------------------- the write side, on the fake

import { createFakeGitHub } from "./fake-github.mjs";

function onFake() {
  const gh = createFakeGitHub();
  gh.push({ "Inbox.org": "* TODO Call\n", "Work/Plan.org": "* NEXT Write\n" }, "First");
  const remote = createRemote({ owner: gh.owner, repo: gh.repo, token: "t", fetch: gh.fetch });
  return { gh, remote };
}

test("commit makes blobs, a tree on the base tree and a commit; updateRef moves the branch", async () => {
  const { gh, remote } = onFake();
  const parent = gh.head();
  const base = await remote.commit(parent);
  const text = "* DONE Call  \n\n\n* TODO É\n";
  const c = await remote.makeCommit(parent, base.tree, { "Inbox.org": text }, "Rumbo: Done \"Call\" (iPad)");
  assert.equal(c.blobs["Inbox.org"], await blobSha(text));
  assert.equal(gh.head(), parent, "creating a commit doesn't move the branch");
  await remote.updateRef(c.sha);
  assert.equal(gh.head(), c.sha);
  assert.deepEqual(gh.filesAt(c.sha), { "Inbox.org": text, "Work/Plan.org": "* NEXT Write\n" });
  const [top] = gh.log();
  assert.equal(top.message, "Rumbo: Done \"Call\" (iPad)");
  assert.deepEqual(top.parents, [parent]);
  assert.equal((await remote.commit(c.sha)).tree, c.tree);
});

test("a ref update that is not a fast-forward is rejected", async () => {
  const { gh, remote } = onFake();
  const parent = gh.head();
  const tree = (await remote.commit(parent)).tree;
  const c = await remote.makeCommit(parent, tree, { "Inbox.org": "* mine\n" }, "Rumbo: mine");
  gh.push({ "Work/Plan.org": "* theirs\n" });
  await assert.rejects(remote.updateRef(c.sha), (e) => e.kind === "rejected" && e.status === 422 && /fast forward/.test(e.detail));
  assert.notEqual(gh.head(), c.sha);
});

test("a blob GitHub stores under another SHA is an error", async () => {
  const { gh } = onFake();
  const fetch = async (url, init) => {
    const res = await gh.fetch(url, init);
    if (!String(url).endsWith("/git/blobs")) return res;
    return new Response(JSON.stringify({ sha: "0".repeat(40) }), { status: 201 });
  };
  const remote = createRemote({ owner: gh.owner, repo: gh.repo, token: "t", fetch });
  await assert.rejects(remote.createBlob("x\n"), (e) => e.kind === "server" && /checksum/.test(e.message));
});

test("createBranch makes a new ref, and refuses one that exists", async () => {
  const { gh, remote } = onFake();
  await remote.createBranch("rumbo/rescue-2026-11-22-1800", gh.head());
  assert.equal(gh.ref("rumbo/rescue-2026-11-22-1800"), gh.head());
  await assert.rejects(remote.createBranch("main", gh.head()), (e) => e.kind === "rejected");
});
