const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(cp.execFile);

const LAST_BRANCH_KEY = 'diffbranch.lastBranch';
const MAX_OPEN_WITHOUT_CONFIRM = 30;

// Own scheme for the diff's base side. Built-in `git:` errors on files absent from base (added
// files), breaking the diff; this provider returns '' for those so the left side just shows empty.
const BASE_SCHEME = 'diffbranch-base';
function baseUriFor(fileUri, base) {
  return fileUri.with({ scheme: BASE_SCHEME, query: JSON.stringify({ path: fileUri.fsPath, ref: base }) });
}
const baseContentProvider = {
  provideTextDocumentContent(uri) {
    const cwd = getCwd();
    let q;
    try { q = JSON.parse(uri.query); } catch { return ''; }
    if (!cwd || !q.path || !q.ref) return '';
    const rel = path.relative(cwd, q.path).split(path.sep).join('/');
    return git(cwd, ['show', `${q.ref}:${rel}`]).catch(() => ''); // missing in base (added file) → empty
  },
};

// Git-style badge + color on each changed file, reusing VS Code's built-in gitDecoration colors.
const STATUS_COLOR = {
  A: 'gitDecoration.addedResourceForeground',
  C: 'gitDecoration.addedResourceForeground',
  M: 'gitDecoration.modifiedResourceForeground',
  T: 'gitDecoration.modifiedResourceForeground',
  R: 'gitDecoration.renamedResourceForeground',
};
const fileDecorations = {
  _emitter: new vscode.EventEmitter(),
  get onDidChangeFileDecorations() {
    return this._emitter.event;
  },
  refresh() {
    this._emitter.fire(undefined); // undefined → re-query all decorations
  },
  provideFileDecoration(uri) {
    const cwd = getCwd();
    if (uri.scheme !== 'file' || !cwd || !diffTree) return;
    const rel = path.relative(cwd, uri.fsPath).split(path.sep).join('/');
    const letter = diffTree.status.get(rel);
    if (!letter) return;
    const color = STATUS_COLOR[letter];
    return {
      badge: letter,
      tooltip: `Changed vs ${diffTree.base} (${letter})`,
      color: color ? new vscode.ThemeColor(color) : undefined,
    };
  },
};

/** The Activity Bar tree provider (set in activate). */
let diffTree = null;
function refreshTree() {
  diffTree?.refresh();
}

function getCwd() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

/** Async git — non-blocking, so the extension host stays responsive. */
async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** Content hash of the working file, or '' if unreadable — used to auto-unview a file once it changes. */
function fileHash(cwd, rel) {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(path.join(cwd, rel))).digest('hex');
  } catch {
    return '';
  }
}

// Viewed marks are per base branch, stored as { relPath: contentHashWhenMarked }. A file counts as
// viewed only while its current content still matches that hash (so editing it re-flags it unviewed).
function viewedKey(base) {
  return `diffbranch.viewed.${base}`;
}
function getViewed(context, base) {
  const raw = context.workspaceState.get(viewedKey(base));
  return raw && !Array.isArray(raw) ? { ...raw } : {};
}
function setViewed(context, base, map) {
  return context.workspaceState.update(viewedKey(base), map);
}
function isViewed(cwd, map, rel) {
  return !!map[rel] && map[rel] === fileHash(cwd, rel);
}

// Ignored marks are a plain per-base list of paths — a deliberate exclusion, so (unlike viewed) it
// is not tied to content hash. Ignored files get their own tree group, out of Unviewed/Viewed.
function ignoredKey(base) {
  return `diffbranch.ignored.${base}`;
}
function getIgnored(context, base) {
  const raw = context.workspaceState.get(ignoredKey(base));
  return new Set(Array.isArray(raw) ? raw : []);
}
function setIgnored(context, base, set) {
  return context.workspaceState.update(ignoredKey(base), [...set]);
}

/** Repo-relative, forward-slash path of the active editor's file (handles diff `git:` sides), or null. */
function activeRelPath(cwd) {
  const uri = vscode.window.activeTextEditor?.document.uri;
  if (!uri) return null;
  let fsPath;
  if (uri.scheme === 'file') {
    fsPath = uri.fsPath;
  } else if (uri.scheme === BASE_SCHEME) {
    try {
      fsPath = JSON.parse(uri.query).path;
    } catch {
      return null;
    }
  } else {
    return null;
  }
  const rel = path.relative(cwd, fsPath);
  if (!rel || rel.startsWith('..')) return null;
  return rel.split(path.sep).join('/');
}

function lastBranch(context) {
  const b = context.workspaceState.get(LAST_BRANCH_KEY);
  return typeof b === 'string' && b ? b : null;
}

/** Drives the editor-title icon: eye when unviewed, eye-closed when viewed. */
function updateViewedContext(context) {
  const cwd = getCwd();
  const base = lastBranch(context);
  const rel = cwd ? activeRelPath(cwd) : null;
  const viewed = !!(cwd && base && rel && isViewed(cwd, getViewed(context, base), rel));
  vscode.commands.executeCommand('setContext', 'diffbranch.activeViewed', viewed);
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  diffTree = new DiffTree(context);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, baseContentProvider),
    vscode.window.registerFileDecorationProvider(fileDecorations),
    vscode.window.registerTreeDataProvider('diffbranchView', diffTree),
    vscode.commands.registerCommand('branchDiff.openAll', () => openAll(context)),
    vscode.commands.registerCommand('branchDiff.openUnviewed', () => openByViewed(context, false)),
    vscode.commands.registerCommand('branchDiff.openViewed', () => openByViewed(context, true)),
    vscode.commands.registerCommand('branchDiff.toggleViewed', () => applyViewed(context)),
    vscode.commands.registerCommand('branchDiff.markViewed', () => applyViewed(context, true)),
    vscode.commands.registerCommand('branchDiff.unmarkViewed', () => applyViewed(context, false)),
    vscode.commands.registerCommand('branchDiff.clearViewed', () => clearViewed(context)),
    // Tree (Activity Bar) commands.
    vscode.commands.registerCommand('branchDiff.treePickBranch', () => treePickBranch(context)),
    vscode.commands.registerCommand('branchDiff.treeRefresh', () => diffTree.load()),
    vscode.commands.registerCommand('branchDiff.treeOpenUnviewed', () => treeOpenUnviewed(context)),
    vscode.commands.registerCommand('branchDiff.treeOpenFile', (rel) => treeOpenFile(rel)),
    vscode.commands.registerCommand('branchDiff.treeOpenDiff', (item) => treeOpenDiff(item)),
    vscode.commands.registerCommand('branchDiff.treeToggleViewed', (item) => treeToggleViewed(context, item)),
    vscode.commands.registerCommand('branchDiff.treeIgnore', (item) => treeIgnore(context, item)),
    vscode.commands.registerCommand('branchDiff.treeUnignore', (item) => treeUnignore(context, item)),
    vscode.commands.registerCommand('branchDiff.treeMarkAllViewed', (item) => treeMarkAllViewed(context, item)),
    vscode.commands.registerCommand('branchDiff.treeMarkAllUnviewed', (item) => treeMarkAllUnviewed(context, item)),
    vscode.window.onDidChangeActiveTextEditor(() => updateViewedContext(context)),
    vscode.workspace.onDidSaveTextDocument(() => {
      updateViewedContext(context);
      refreshTree();
    })
  );
  updateViewedContext(context);
  diffTree.load();
}

/** Branch picker — one async git call, shown via a Promise so it appears instantly with a spinner. */
async function pickBranch(context, cwd) {
  const last = lastBranch(context);
  const branchesPromise = git(cwd, [
    'branch',
    '--format=%(HEAD)%09%(refname:short)', // %(HEAD) is `*` for the current branch (skipped).
    '--sort=-committerdate',
  ])
    .then((out) => {
      const branches = [];
      for (const line of out.split('\n')) {
        const tab = line.indexOf('\t');
        if (tab < 0) continue;
        const isCurrent = line.slice(0, tab) === '*';
        const name = line.slice(tab + 1).trim();
        if (name && !isCurrent) branches.push(name);
      }
      return last && branches.includes(last)
        ? [last, ...branches.filter((b) => b !== last)]
        : branches;
    })
    .catch((e) => {
      vscode.window.showErrorMessage(`Could not list branches: ${e.message}`);
      return [];
    });

  const base = await vscode.window.showQuickPick(branchesPromise, {
    placeHolder: 'Diff against which local branch?',
  });
  if (!base) return null;
  await context.workspaceState.update(LAST_BRANCH_KEY, base);
  updateViewedContext(context);
  return base;
}

/** Files differing from the branch tip (committed + uncommitted), deletes excluded. */
async function changedFiles(cwd, base) {
  let files;
  try {
    files = (await git(cwd, ['diff', '--name-only', '--diff-filter=d', base]))
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (e) {
    vscode.window.showErrorMessage(`git diff failed: ${e.message}`);
    return null;
  }
  if (!files.length) {
    vscode.window.showInformationMessage(`No changes vs ${base}.`);
    return null;
  }
  return files;
}

/** Confirm-if-many, ask diff/files, then open in parallel without stealing focus. */
async function openFiles(cwd, base, files) {
  if (!files.length) {
    vscode.window.showInformationMessage('Nothing to open.');
    return;
  }
  if (files.length > MAX_OPEN_WITHOUT_CONFIRM) {
    const ok = await vscode.window.showWarningMessage(
      `Open ${files.length} editors?`,
      { modal: true },
      'Open'
    );
    if (ok !== 'Open') return;
  }

  const mode = await vscode.window.showQuickPick(['Open files', 'Open as diff'], {
    placeHolder: 'How should they open?',
  });
  if (!mode) return; // Escape cancels.
  const asDiff = mode === 'Open as diff';

  await Promise.all(
    files.map((rel) => {
      const fileUri = vscode.Uri.file(path.join(cwd, rel));
      if (asDiff) {
        const baseUri = baseUriFor(fileUri, base);
        return vscode.commands.executeCommand(
          'vscode.diff',
          baseUri,
          fileUri,
          `${rel} (${base} ↔ working)`,
          { preview: false, preserveFocus: true }
        );
      }
      return vscode.workspace
        .openTextDocument(fileUri)
        .then((doc) => vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true }));
    })
  );
  vscode.window.showInformationMessage(`Opened ${files.length} file(s) vs ${base}.`);
}

async function openAll(context) {
  const cwd = getCwd();
  if (!cwd) {
    vscode.window.showErrorMessage('Open a folder first.');
    return;
  }
  const base = await pickBranch(context, cwd);
  if (!base) return;
  const allFiles = await changedFiles(cwd, base);
  if (!allFiles) return;

  // Top "All unviewed" shortcut (pre-checked), then every file listed unchecked.
  const viewed = getViewed(context, base);
  const unviewed = allFiles.filter((f) => !isViewed(cwd, viewed, f));
  const ALL_UNVIEWED = '$(checklist) All unviewed files';

  const picks = await vscode.window.showQuickPick(
    [
      { label: ALL_UNVIEWED, detail: `${unviewed.length} file(s)`, picked: true, alwaysShow: true },
      { label: 'Files', kind: vscode.QuickPickItemKind.Separator },
      ...allFiles.map((f) => ({
        label: f,
        picked: false,
        description: isViewed(cwd, viewed, f) ? 'viewed' : undefined,
      })),
    ],
    {
      canPickMany: true,
      placeHolder: `${allFiles.length} changed vs ${base} — pick "All unviewed", or check individual files`,
    }
  );
  if (!picks || !picks.length) return;

  const labels = picks.map((p) => p.label);
  const files = labels.includes(ALL_UNVIEWED)
    ? unviewed
    : labels.filter((l) => l !== ALL_UNVIEWED);
  await openFiles(cwd, base, files);
}

/** Open just the viewed (or just the unviewed) changed files — no per-file picker. */
async function openByViewed(context, wantViewed) {
  const cwd = getCwd();
  if (!cwd) {
    vscode.window.showErrorMessage('Open a folder first.');
    return;
  }
  const base = await pickBranch(context, cwd);
  if (!base) return;
  const allFiles = await changedFiles(cwd, base);
  if (!allFiles) return;

  const viewed = getViewed(context, base);
  const files = allFiles.filter((f) => isViewed(cwd, viewed, f) === wantViewed);
  if (!files.length) {
    vscode.window.showInformationMessage(`No ${wantViewed ? 'viewed' : 'unviewed'} files changed vs ${base}.`);
    return;
  }
  await openFiles(cwd, base, files);
}

/** Sets the active file viewed/unviewed (vs the last-used branch). `makeViewed` omitted = toggle. */
async function applyViewed(context, makeViewed) {
  const cwd = getCwd();
  if (!cwd) return;
  const base = lastBranch(context);
  if (!base) {
    vscode.window.showInformationMessage('Pick a branch first via "db: Open All Files Changed vs Branch".');
    return;
  }
  const rel = activeRelPath(cwd);
  if (!rel) {
    vscode.window.showInformationMessage('No file in the active editor.');
    return;
  }
  const viewed = getViewed(context, base);
  const next = makeViewed === undefined ? !isViewed(cwd, viewed, rel) : makeViewed;
  if (next) viewed[rel] = fileHash(cwd, rel);
  else delete viewed[rel];
  await setViewed(context, base, viewed);
  updateViewedContext(context);
  refreshTree();
  vscode.window.setStatusBarMessage(`${next ? 'Marked viewed' : 'Unmarked'} (vs ${base}): ${rel}`, 2500);
}

async function clearViewed(context) {
  const base = lastBranch(context);
  if (!base) {
    vscode.window.showInformationMessage('No branch selected yet.');
    return;
  }
  await setViewed(context, base, {});
  updateViewedContext(context);
  refreshTree();
  vscode.window.setStatusBarMessage(`Cleared viewed marks for ${base}`, 2500);
}

/** Activity Bar view: changed files grouped into Unviewed / Viewed, vs the selected branch. */
class DiffTree {
  constructor(context) {
    this.context = context;
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    this.base = lastBranch(context);
    this.files = [];
    this.added = new Set(); // files absent from base — diff left side would be empty, so open them as files
    this.status = new Map(); // rel → status letter (A/M/R/C/T) for the file decoration badge
  }

  refresh() {
    this._emitter.fire();
  }

  async load() {
    const cwd = getCwd();
    this.base = lastBranch(this.context);
    const files = [];
    const added = new Set();
    const status = new Map();
    if (cwd && this.base) {
      try {
        const out = await git(cwd, ['diff', '--name-status', '--diff-filter=d', this.base]);
        for (const line of out.split('\n')) {
          const parts = line.split('\t');
          if (parts.length < 2) continue;
          const rel = parts[parts.length - 1].trim(); // rename → new path
          if (!rel) continue;
          const letter = parts[0].trim()[0];
          files.push(rel);
          status.set(rel, letter);
          if (letter === 'A') added.add(rel);
        }
      } catch {
        // leave empty
      }
    }
    this.files = files;
    this.added = added;
    this.status = status;
    this.refresh();
    fileDecorations.refresh();
  }

  getTreeItem(el) {
    return el;
  }

  getChildren(el) {
    const cwd = getCwd();
    if (!cwd) return [];

    if (!this.base) {
      const it = new vscode.TreeItem('Select a branch to diff against…');
      it.iconPath = new vscode.ThemeIcon('git-branch');
      it.command = { command: 'branchDiff.treePickBranch', title: 'Change Branch' };
      return [it];
    }

    if (!el) {
      const viewed = getViewed(this.context, this.base);
      const ignored = getIgnored(this.context, this.base);
      const active = this.files.filter((f) => !ignored.has(f));
      const unv = active.filter((f) => !isViewed(cwd, viewed, f));
      const vw = active.filter((f) => isViewed(cwd, viewed, f));
      const ig = this.files.filter((f) => ignored.has(f));
      return [
        this._group(`Unviewed (${unv.length}) · vs ${this.base}`, unv, true, false, 'group-unviewed'),
        this._group(`Viewed (${vw.length})`, vw, false, false, 'group-viewed'),
        this._group(`Untracked (${ig.length})`, ig, false, true, 'group-ignored'),
      ];
    }

    return (el.files || []).map((f) => this._file(cwd, f, !!el.ignored));
  }

  _group(label, files, expanded, ignored, contextValue) {
    const it = new vscode.TreeItem(
      label,
      expanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
    );
    it.files = files;
    it.ignored = !!ignored;
    it.contextValue = contextValue || 'group';
    return it;
  }

  _file(cwd, rel, isIgnored) {
    const it = new vscode.TreeItem(rel);
    const viewed = isViewed(cwd, getViewed(this.context, this.base), rel);
    it.rel = rel;
    it.resourceUri = vscode.Uri.file(path.join(cwd, rel));
    it.contextValue = isIgnored ? 'file-ignored' : viewed ? 'file-viewed' : 'file-unviewed';
    it.tooltip = `${rel} — ${isIgnored ? 'untracked' : viewed ? 'viewed' : 'unviewed'}`;
    const cmd = this.added.has(rel) ? 'branchDiff.treeOpenFile' : 'branchDiff.treeOpenDiff';
    it.command = { command: cmd, title: 'Open', arguments: [it] };
    return it;
  }
}

function treeOpenFile(arg) {
  const cwd = getCwd();
  const rel = typeof arg === 'string' ? arg : arg?.rel;
  if (!cwd || !rel) return;
  return vscode.window.showTextDocument(vscode.Uri.file(path.join(cwd, rel)), { preview: true });
}

function treeOpenDiff(item) {
  const cwd = getCwd();
  const base = diffTree?.base;
  if (!cwd || !base || !item?.rel) return;
  const fileUri = vscode.Uri.file(path.join(cwd, item.rel));
  const baseUri = baseUriFor(fileUri, base);
  return vscode.commands.executeCommand(
    'vscode.diff',
    baseUri,
    fileUri,
    `${item.rel} (${base} ↔ working)`
  );
}

async function treeToggleViewed(context, item) {
  const cwd = getCwd();
  const base = diffTree?.base;
  if (!cwd || !base || !item?.rel) return;
  const viewed = getViewed(context, base);
  if (isViewed(cwd, viewed, item.rel)) delete viewed[item.rel];
  else viewed[item.rel] = fileHash(cwd, item.rel);
  await setViewed(context, base, viewed);
  updateViewedContext(context);
  refreshTree();
}

async function treeMarkAllViewed(context, item) {
  const cwd = getCwd();
  const base = diffTree?.base;
  if (!cwd || !base || !item?.files) return;
  const viewed = getViewed(context, base);
  for (const rel of item.files) viewed[rel] = fileHash(cwd, rel);
  await setViewed(context, base, viewed);
  updateViewedContext(context);
  refreshTree();
}

async function treeMarkAllUnviewed(context, item) {
  const base = diffTree?.base;
  if (!base || !item?.files) return;
  const viewed = getViewed(context, base);
  for (const rel of item.files) delete viewed[rel];
  await setViewed(context, base, viewed);
  updateViewedContext(context);
  refreshTree();
}

async function treeIgnore(context, item) {
  const base = diffTree?.base;
  if (!base || !item?.rel) return;
  const ig = getIgnored(context, base);
  ig.add(item.rel);
  await setIgnored(context, base, ig);
  refreshTree();
}

async function treeUnignore(context, item) {
  const base = diffTree?.base;
  if (!base || !item?.rel) return;
  const ig = getIgnored(context, base);
  ig.delete(item.rel);
  await setIgnored(context, base, ig);
  refreshTree();
}

async function treePickBranch(context) {
  const cwd = getCwd();
  if (!cwd) {
    vscode.window.showErrorMessage('Open a folder first.');
    return;
  }
  const base = await pickBranch(context, cwd);
  if (base) await diffTree.load();
}

async function treeOpenUnviewed(context) {
  const cwd = getCwd();
  const base = diffTree?.base;
  if (!cwd || !base) {
    vscode.window.showInformationMessage('Pick a branch first (the branch button above).');
    return;
  }
  const viewed = getViewed(context, base);
  const files = diffTree.files.filter((f) => !isViewed(cwd, viewed, f));
  await openFiles(cwd, base, files);
}

function deactivate() {}

module.exports = { activate, deactivate };
