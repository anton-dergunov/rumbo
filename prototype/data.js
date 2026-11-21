// Load the vault from serve.py and build the model every view reads.

import { parseOrg, agendaSections, countSubtree, OPEN_STATES } from "./org.js";
import { plainText } from "./inline.js";
import { parseWorkspace, sortFolders } from "./workspace.js";

async function get(url, kind) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return kind === "json" ? res.json() : res.text();
}

/** A file's text and the version a save must match (the server's ETag). */
export async function getFile(data, path) {
  const res = await fetch(`/api/file?data=${data === "sample" ? "sample" : "real"}&path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return { text: await res.text(), version: (res.headers.get("ETag") || "").replace(/"/g, "") };
}

/** Parse one file's text into the file object the views read. `i` keeps heading ids stable per file. */
function buildFile(f, i, text, version, ws) {
  const doc = parseOrg(text, { states: [...OPEN_STATES, "DONE"], idPrefix: `f${i}h` });
  const topFolder = f.folder.split("/")[0];
  return {
    ...f,
    index: i,
    text,
    version,
    doc,
    title: doc.keywords.TITLE && !/->/.test(doc.keywords.TITLE) ? doc.keywords.TITLE : f.name,
    subtitle: doc.keywords.SUBTITLE || "",
    icon: ws.folderContentIcons[f.folder] || ws.folderContentIcons[topFolder] || ws.fileIcons[f.base] || "draft",
    counts: countSubtree(doc.children),
  };
}

/**
 * Replace one file's text in the model after an edit or a reload: re-parse it and refresh every
 * index that points into it. The file object is updated in place, so views holding it stay valid.
 */
export function rebuildFile(model, path, text, version) {
  const file = model.byPath.get(path);
  for (const h of file.doc.headings) model.headingById.delete(h.id);
  const fresh = buildFile(file, file.index, text, version ?? file.version, model.ws);
  Object.assign(file, fresh);
  for (const h of file.doc.headings) model.headingById.set(h.id, { file, heading: h });
  model.agenda = agendaSections(model.files);
  return file;
}

export async function loadVault(data) {
  const q = data === "sample" ? "data=sample" : "data=real";
  const [vault, wsText, iconCache] = await Promise.all([
    get(`/api/vault?${q}`, "json"),
    get(`/api/workspace?${q}`, "text"),
    get(`/api/task-icons?${q}`, "json").catch(() => ({})),
  ]);
  const ws = parseWorkspace(wsText);
  const texts = await Promise.all(vault.files.map((f) => getFile(data, f.path)));

  const headingById = new Map();
  const files = vault.files.map((f, i) => {
    const file = buildFile(f, i, texts[i].text, texts[i].version, ws);
    for (const h of file.doc.headings) headingById.set(h.id, { file, heading: h });
    return file;
  });

  const folderNames = sortFolders([...new Set(files.filter((f) => f.folder).map((f) => f.folder))], ws.order);
  const folders = folderNames.map((name) => ({
    name,
    icon: ws.folderIcons[name] || ws.folderIcons[name.split("/").pop()] || "folder",
    files: files.filter((f) => f.folder === name),
  }));
  const loose = files.filter((f) => !f.folder);
  if (loose.length) folders.push({ name: "", icon: null, files: loose });

  const byBase = new Map(files.map((f) => [f.base.toLowerCase(), f]));
  const iconMap = iconCache.map || {};

  return {
    name: vault.name,
    data,
    sample: vault.sample,
    writable: !!vault.writable, // only the sample working copy is saved; real-vault edits stay in memory
    ws,
    files,
    folders,
    agenda: agendaSections(files),
    headingById,
    byPath: new Map(files.map((f) => [f.path, f])),
    findFile(ref) {
      const base = ref.replace(/\.org$/, "").split("/").pop().toLowerCase();
      return this.byPath.get(ref) || byBase.get(base) || null;
    },
    taskIcon(h) {
      const key = JSON.stringify({ title: h.title });
      return iconMap[key] || iconMap[JSON.stringify({ title: plainText(h.title) })] || null;
    },
  };
}
