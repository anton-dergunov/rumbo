// Build the model every view reads from the replica's files (docs/plans/real-app.md §9). Pure: no
// network and no IndexedDB, so the first paint needs neither and tests can run it on any texts.

import { parseOrg, agendaSections, countSubtree, OPEN_STATES } from "./org.js";
import { iconKey, parseIconFile } from "./icon-keys.js";
import { parseWorkspace, sortFolders } from "./workspace.js";
import { isIncluded } from "./vault-files.js";
import { countSpacing } from "./spacing.js";

/** A short, stable tag per path, so heading ids don't shift when another file is added. */
export function pathTag(path) {
  let h = 5381;
  for (let i = 0; i < path.length; i++) h = ((h * 33) ^ path.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** What the views need to know about a path: its folder, its base name and its display name. */
export function describePath(path) {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const base = name.replace(/\.org$/, "");
  return { path, folder: slash < 0 ? "" : path.slice(0, slash), base, name: base.replace(/_/g, " ") };
}

/** Parse one file's text into the file object the views read. */
function buildFile(f, i, text, version, ws) {
  const doc = parseOrg(text, { states: [...OPEN_STATES, "DONE"], idPrefix: `f${pathTag(f.path)}h` });
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

/**
 * The model, from the replica's file records `{ path, sha, text, work, readOnly }`. The agenda
 * files are the included `.org` paths; `workspace.org` and `.ps/task-icons.json` are read for
 * settings. `name` is what the navigation shows as the vault's name.
 */
export function buildModel(records, { name = "Plans" } = {}) {
  const byRecord = new Map(records.map((r) => [r.path, r]));
  const textOf = (r) => (r.work ?? r.text ?? "");
  const ws = parseWorkspace(byRecord.has("workspace.org") ? textOf(byRecord.get("workspace.org")) : "");
  const icons = parseIconFile(byRecord.has(".ps/task-icons.json") ? textOf(byRecord.get(".ps/task-icons.json")) : "");

  const agendaRecords = records.filter((r) => isIncluded(r.path)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const headingById = new Map();
  const files = agendaRecords.map((r, i) => {
    const file = buildFile(describePath(r.path), i, textOf(r), r.sha, ws);
    file.readOnly = r.readOnly || null;
    for (const h of file.doc.headings) headingById.set(h.id, { file, heading: h });
    return file;
  });

  const folderNames = sortFolders([...new Set(files.filter((f) => f.folder).map((f) => f.folder))], ws.order);
  const folders = folderNames.map((folder) => ({
    name: folder,
    icon: ws.folderIcons[folder] || ws.folderIcons[folder.split("/").pop()] || "folder",
    files: files.filter((f) => f.folder === folder),
  }));
  const loose = files.filter((f) => !f.folder);
  if (loose.length) folders.push({ name: "", icon: null, files: loose });

  const byBase = new Map(files.map((f) => [f.base.toLowerCase(), f]));

  return {
    name,
    sample: false,
    // Edits become local commits in the replica (edits.js, store.js).
    writable: true,
    ws,
    files,
    folders,
    agenda: agendaSections(files),
    // The blank-line rule for new seams, counted from the vault's own files (spacing.js): the vault is the setting.
    spacing: countSpacing(files.map((f) => f.doc)),
    headingById,
    byPath: new Map(files.map((f) => [f.path, f])),
    findFile(ref) {
      const base = ref.replace(/\.org$/, "").split("/").pop().toLowerCase();
      return this.byPath.get(ref) || byBase.get(base) || null;
    },
    // Emacs's icons (.ps/task-icons.json), keyed as Emacs keys them (icon-keys.js). `guesses` is
    // the on-device model's map for tasks Emacs hasn't seen yet (icons.js); Emacs's answer wins,
    // and its "" (no icon) counts as an answer.
    icons,
    guesses: null,
    iconKey(h) {
      return iconKey(h, icons.inputs);
    },
    /** Emacs's answer for heading `h`: an icon name, "" for none, or undefined when it has none yet. */
    emacsIcon(h) {
      const key = iconKey(h, icons.inputs);
      return key == null ? undefined : icons.map.get(key);
    },
    taskIcon(h) {
      const key = iconKey(h, icons.inputs);
      if (key == null) return null;
      const emacs = icons.map.get(key);
      if (emacs !== undefined) return emacs || null;
      return this.guesses?.get(key) || null;
    },
  };
}
