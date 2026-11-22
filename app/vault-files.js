// Which files of the vault's git tree the app reads. The same rules as Emacs
// (agentic-org-planner/lisp/ps-org-files.el, `ps/org-files-exclude-directories` and
// `ps/org-files-exclude-files`), applied to repo-relative paths.

const EXCLUDE_DIRECTORIES = [/^\./, /^Journal$/, /^Archive$/];
const EXCLUDE_FILES = [/^init\.org$/, /^workspace\.org$/, /conflicted copy/];

/** Files the app downloads besides the agenda files: the workspace settings and the task icons. */
export const SUPPORT_FILES = ["workspace.org", ".ps/task-icons.json"];

/** A `.org` file Emacs would scan: no excluded folder on its path, and not an excluded file name. */
export function isIncluded(path) {
  if (!path.endsWith(".org")) return false;
  const parts = path.split("/");
  const name = parts.pop();
  if (parts.some((dir) => EXCLUDE_DIRECTORIES.some((rx) => rx.test(dir)))) return false;
  return !EXCLUDE_FILES.some((rx) => rx.test(name));
}

export const isSupportFile = (path) => SUPPORT_FILES.includes(path);

/** Whether the app keeps a copy of this path from the tree: the agenda files and the support files. */
export const isWanted = (path) => isIncluded(path) || isSupportFile(path);
