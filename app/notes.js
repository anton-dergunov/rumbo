// Obsidian notes (docs/plans/real-app.md §6). The vault links to notes by bare name
// (`[[obsidian:Note name]]`), and every name is unique in the Obsidian vault, so a name → path
// index from that repo's tree finds the file. The index is kept in IndexedDB and refreshed when
// that repo's head moves (a 304 on an unchanged head costs nothing). Notes and the images they
// embed are fetched as blobs by SHA, online only, and kept in memory for the session: nothing of
// a note is stored on the device.

// A note that isn't valid UTF-8 is still shown, with replacement characters.
const utf8Decode = (bytes) => new TextDecoder("utf-8").decode(bytes);

const isHidden = (path) => path.split("/").some((part) => part.startsWith("."));
const baseName = (path) => path.split("/").pop();
const noteKey = (name) => name.trim().replace(/\.md$/i, "").toLowerCase();

/** Re-check the head at most this often while the app is open. */
const CHECK_MS = 60_000;

/**
 * The note index from a tree's entries: `notes` maps a note's name (lower case) to
 * `{ name, path, sha }`, `files` an embeddable file's name (lower case) to `{ path, sha }`. Dot
 * folders (`.obsidian/`, `.trash/`) are left out. On a clash the first path wins.
 */
export function noteIndex(entries) {
  const notes = {};
  const files = {};
  for (const e of entries) {
    if (e.type !== "blob" || isHidden(e.path)) continue;
    const name = baseName(e.path);
    if (/\.md$/i.test(name)) {
      const key = noteKey(name);
      notes[key] ??= { name: name.replace(/\.md$/i, ""), path: e.path, sha: e.sha };
    } else files[name.toLowerCase()] ??= { path: e.path, sha: e.sha };
  }
  return { notes, files };
}

/** The URL that opens a note in Obsidian, as Emacs opens it (agentic-org-planner ps-links.el). */
export function obsidianUrl(vault, name) {
  return `obsidian://open?vault=${encodeURIComponent(vault || "obsidian")}&file=${encodeURIComponent(name)}`;
}

const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp" };

/** An image's media type from its name; an SVG in an `<img>` runs no script. */
export function imageType(path) {
  return MIME[/\.([a-z0-9]+)$/i.exec(path)?.[1].toLowerCase()] || "application/octet-stream";
}

/** What a failed request means for the note page. */
function failure(e, name) {
  if (e?.kind === "offline") return { status: "offline", name };
  if (e?.kind === "missing") return { status: "error", name, message: "GitHub can't find the notes repo. Check its name in Setup, and that the token can read it." };
  return { status: "error", name, message: e?.message || String(e) };
}

/**
 * The notes of one Obsidian repo. `remote` is a `createRemote` for it (null when Setup named no
 * notes repo); `repo` is its "owner/name", so an index kept for another repo is not used.
 * `now` is injected for tests.
 */
export function createNotes({ store, remote, repo, now = () => Date.now() }) {
  let current = null; // the index in use
  let checkedAt = -Infinity;
  let flight = null;
  const texts = new Map(); // blob SHA -> text
  const images = new Map(); // blob SHA -> object URL (a promise)

  async function stored() {
    const kept = await store.getNotesIndex().catch(() => null);
    return kept?.repo === repo ? kept : null;
  }

  async function refresh() {
    const old = current || (await stored());
    try {
      const head = await remote.head(old?.etag || null);
      checkedAt = now();
      if (old && (!head.changed || head.sha === old.head)) {
        current = head.changed ? { ...old, etag: head.etag } : old;
        if (head.changed) await store.setNotesIndex(current).catch(() => {});
        return current;
      }
      const commit = await remote.commit(head.sha);
      const tree = await remote.tree(commit.tree);
      current = { repo, head: head.sha, etag: head.etag, ...noteIndex(tree.entries) };
      await store.setNotesIndex(current).catch(() => {});
      return current;
    } catch (e) {
      // GitHub can't be reached: the index kept on the device still says which notes exist.
      if (old) return { ...old, stale: e };
      throw e;
    }
  }

  /** The index: the one in memory if checked within a minute, else checked against the head. */
  function index() {
    if (current && now() - checkedAt < CHECK_MS) return Promise.resolve(current);
    return (flight ??= refresh().finally(() => (flight = null)));
  }

  const lookups = (idx) => ({
    note: (name) => idx.notes[noteKey(name)]?.name ?? null,
    file: (name) => idx.files[baseName(name).toLowerCase()]?.path ?? null,
  });

  /**
   * A note by name: `{ status: "ok", name, path, text, note, file }` (with the lookups its links
   * and embeds need), or a status of "missing", "offline", "unset" or "error" (with `message`).
   */
  async function load(name) {
    if (!remote) return { status: "unset", name };
    let idx;
    try {
      idx = await index();
    } catch (e) {
      return failure(e, name);
    }
    const hit = idx.notes[noteKey(name)];
    // Missing from an index that couldn't be checked: the note may be new, so say offline.
    if (!hit) return idx.stale ? failure(idx.stale, name) : { status: "missing", name };
    try {
      if (!texts.has(hit.sha)) texts.set(hit.sha, utf8Decode(await remote.blob(hit.sha)));
    } catch (e) {
      return failure(e, hit.name);
    }
    return { status: "ok", name: hit.name, path: hit.path, text: texts.get(hit.sha), ...lookups(idx) };
  }

  /** An embedded file's object URL, by its path in the index. */
  function image(path) {
    const entry = current && Object.values(current.files).find((f) => f.path === path);
    if (!entry) return Promise.resolve(null);
    if (!images.has(entry.sha)) {
      const url = remote.blob(entry.sha).then((bytes) => URL.createObjectURL(new Blob([bytes], { type: imageType(path) })));
      url.catch(() => images.delete(entry.sha));
      images.set(entry.sha, url);
    }
    return images.get(entry.sha);
  }

  return { index, load, image };
}
