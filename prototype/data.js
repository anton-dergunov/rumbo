// Load the vault from serve.py and build the model every view reads.

import { parseOrg, agendaSections, countSubtree, OPEN_STATES } from "./org.js";
import { plainText } from "./inline.js";
import { parseWorkspace, sortFolders } from "./workspace.js";

async function get(url, kind) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return kind === "json" ? res.json() : res.text();
}

export async function loadVault(data) {
  const q = data === "sample" ? "data=sample" : "data=real";
  const [vault, wsText, iconCache] = await Promise.all([
    get(`/api/vault?${q}`, "json"),
    get(`/api/workspace?${q}`, "text"),
    get(`/api/task-icons?${q}`, "json").catch(() => ({})),
  ]);
  const ws = parseWorkspace(wsText);
  const texts = await Promise.all(vault.files.map((f) => get(`/api/file?${q}&path=${encodeURIComponent(f.path)}`, "text")));

  const headingById = new Map();
  const files = vault.files.map((f, i) => {
    const doc = parseOrg(texts[i], { states: [...OPEN_STATES, "DONE"], idPrefix: `f${i}h` });
    for (const h of doc.headings) headingById.set(h.id, { file: null, heading: h });
    const topFolder = f.folder.split("/")[0];
    const file = {
      ...f,
      doc,
      title: doc.keywords.TITLE && !/->/.test(doc.keywords.TITLE) ? doc.keywords.TITLE : f.name,
      subtitle: doc.keywords.SUBTITLE || "",
      icon: ws.folderContentIcons[f.folder] || ws.folderContentIcons[topFolder] || ws.fileIcons[f.base] || "draft",
      counts: countSubtree(doc.children),
    };
    for (const h of doc.headings) headingById.get(h.id).file = file;
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
    sample: vault.sample,
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
