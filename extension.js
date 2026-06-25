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
  U: 'gitDecoration.untrackedResourceForeground',
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

/** GitHub CLI — used for PR review (checkout/cleanup). Errors bubble up for the caller to surface. */
async function gh(cwd, args) {
  const { stdout } = await execFileAsync('gh', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

const REVIEW_KEY = 'diffbranch.review'; // { original, prBranch, number } while reviewing a PR

/** New files git doesn't track yet (never committed) — git diff omits these, so list them separately. */
async function untrackedFiles(cwd) {
  try {
    return (await git(cwd, ['ls-files', '--others', '--exclude-standard']))
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
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

// --- Local review comments: PR-style inline comment threads, persisted in workspaceState ---
const COMMENTS_KEY = 'diffbranch.comments';
let commentController = null;
const commentThreads = []; // live threads we manage
const builtDocs = new Set(); // uri.toString() already hydrated this session

function getComments(context) {
  return context.workspaceState.get(COMMENTS_KEY) || {};
}
function relOf(cwd, uri) {
  if (uri.scheme !== 'file') return null;
  const rel = path.relative(cwd, uri.fsPath);
  if (!rel || rel.startsWith('..')) return null;
  return rel.split(path.sep).join('/');
}
function makeComment(text) {
  return { body: new vscode.MarkdownString(text), mode: vscode.CommentMode.Preview, author: { name: 'Comment' } };
}
function bodyText(c) {
  return typeof c.body === 'string' ? c.body : c.body.value;
}

/** Reserialize all live threads back to workspaceState as { relPath: [{range, comments}] }. */
async function persistComments(context) {
  const cwd = getCwd();
  const map = {};
  for (const t of commentThreads) {
    const rel = t.dbRel || (cwd && relOf(cwd, t.uri));
    if (!rel || !t.comments.length) continue;
    (map[rel] ||= []).push({
      range: [t.range.start.line, t.range.start.character, t.range.end.line, t.range.end.character],
      comments: t.comments.map(bodyText),
    });
  }
  await context.workspaceState.update(COMMENTS_KEY, map);
}

/** Recreate stored threads for a document the first time it opens this session. */
function hydrateComments(context, doc) {
  const cwd = getCwd();
  if (!commentController || !cwd || doc.uri.scheme !== 'file') return;
  const key = doc.uri.toString();
  if (builtDocs.has(key)) return;
  builtDocs.add(key);
  const rel = relOf(cwd, doc.uri);
  if (!rel) return;
  for (const n of getComments(context)[rel] || []) {
    const range = new vscode.Range(n.range[0], n.range[1], n.range[2], n.range[3]);
    const thread = commentController.createCommentThread(doc.uri, range, n.comments.map(makeComment));
    thread.dbRel = rel;
    thread.contextValue = 'hasComment'; // gates the Delete Comment button (not shown on empty drafts)
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    commentThreads.push(thread);
  }
}

async function createComment(context, reply) {
  const thread = reply.thread;
  const cwd = getCwd();
  thread.dbRel = thread.dbRel || (cwd && relOf(cwd, thread.uri));
  thread.comments = [...thread.comments, makeComment(reply.text)];
  thread.contextValue = 'hasComment';
  thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  if (!commentThreads.includes(thread)) commentThreads.push(thread);
  await persistComments(context);
}

/** Copy all comments as a paste-ready task list (file:line — comment). */
async function exportComments(context) {
  const comments = getComments(context);
  const lines = [];
  for (const rel of Object.keys(comments)) {
    for (const n of comments[rel] || []) {
      const text = n.comments.join(' / ').replace(/\s+/g, ' ').trim();
      lines.push(`- ${rel}:${n.range[0] + 1} — ${text}`);
    }
  }
  if (!lines.length) {
    vscode.window.showInformationMessage('No comments to export.');
    return;
  }
  await vscode.env.clipboard.writeText(`Address these review comments:\n\n${lines.join('\n')}\n`);
  vscode.window.showInformationMessage(`Copied ${lines.length} comment(s) to the clipboard.`);
}

async function deleteComment(context, thread) {
  const i = commentThreads.indexOf(thread);
  if (i >= 0) commentThreads.splice(i, 1);
  thread.dispose();
  await persistComments(context);
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  diffTree = new DiffTree(context);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, baseContentProvider),
    vscode.window.registerFileDecorationProvider(fileDecorations),
    vscode.window.registerWebviewViewProvider('diffbranchSearch', new SearchView()),
    vscode.window.registerTreeDataProvider('diffbranchView', diffTree),
    vscode.commands.registerCommand('branchDiff.openAll', () => openAll(context)),
    vscode.commands.registerCommand('branchDiff.openUnviewed', () => openByViewed(context, false)),
    vscode.commands.registerCommand('branchDiff.openViewed', () => openByViewed(context, true)),
    vscode.commands.registerCommand('branchDiff.toggleViewed', () => applyViewed(context)),
    vscode.commands.registerCommand('branchDiff.markViewed', () => applyViewed(context, true)),
    vscode.commands.registerCommand('branchDiff.unmarkViewed', () => applyViewed(context, false)),
    vscode.commands.registerCommand('branchDiff.clearViewed', () => clearViewed(context)),
    // Tree (Activity Bar) commands.
    vscode.commands.registerCommand('branchDiff.reviewPr', () => reviewPr(context)),
    vscode.commands.registerCommand('branchDiff.finishReview', () => finishReview(context)),
    vscode.commands.registerCommand('branchDiff.treePickBranch', () => treePickBranch(context)),
    vscode.commands.registerCommand('branchDiff.treeRefresh', () => diffTree.load()),
    vscode.commands.registerCommand('branchDiff.treeOpenUnviewed', () => treeOpenUnviewed(context)),
    vscode.commands.registerCommand('branchDiff.treeOpenFile', (rel) => treeOpenFile(rel)),
    vscode.commands.registerCommand('branchDiff.treeOpenDiff', (item) => treeOpenDiff(item)),
    vscode.commands.registerCommand('branchDiff.treeToggleViewed', (item) => treeToggleViewed(context, item)),
    vscode.commands.registerCommand('branchDiff.treeIgnore', (item) => treeIgnore(context, item)),
    vscode.commands.registerCommand('branchDiff.treeUnignore', (item) => treeUnignore(context, item)),
    vscode.commands.registerCommand('branchDiff.treeOpenGroup', (item) => treeOpenGroup(item)),
    vscode.commands.registerCommand('branchDiff.treeMarkAllViewed', (item) => treeMarkAllViewed(context, item)),
    vscode.commands.registerCommand('branchDiff.treeMarkAllUnviewed', (item) => treeMarkAllUnviewed(context, item)),
    vscode.window.onDidChangeActiveTextEditor(() => updateViewedContext(context)),
    vscode.workspace.onDidSaveTextDocument(() => {
      updateViewedContext(context);
      refreshTree();
    })
  );
  // Review comments: register the comment controller, hydrate stored comments as editors open.
  commentController = vscode.comments.createCommentController('diffbranch.comments', 'DiffBranch Comments');
  commentController.commentingRangeProvider = {
    provideCommentingRanges(doc) {
      return doc.uri.scheme === 'file' ? [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)] : [];
    },
  };
  context.subscriptions.push(
    commentController,
    vscode.commands.registerCommand('branchDiff.createComment', (reply) => createComment(context, reply)),
    vscode.commands.registerCommand('branchDiff.deleteComment', (thread) => deleteComment(context, thread)),
    vscode.commands.registerCommand('branchDiff.exportComments', () => exportComments(context)),
    vscode.workspace.onDidOpenTextDocument((doc) => hydrateComments(context, doc)),
    vscode.window.onDidChangeActiveTextEditor((ed) => ed && hydrateComments(context, ed.document))
  );
  for (const ed of vscode.window.visibleTextEditors) hydrateComments(context, ed.document);

  updateViewedContext(context);
  vscode.commands.executeCommand('setContext', 'diffbranch.reviewing', !!context.workspaceState.get(REVIEW_KEY));
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
        const name = line.slice(tab + 1).trim();
        // Include current branch too: diffing against it shows just the working-tree changes.
        if (name) branches.push(name);
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
    const seen = new Set(files);
    for (const rel of await untrackedFiles(cwd)) if (!seen.has(rel)) files.push(rel);
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

/** The "Search" section above the tree: two real input boxes (filename filter + text search). */
class SearchView {
  resolveWebviewView(view) {
    view.webview.options = { enableScripts: true };
    const nonce = crypto.randomBytes(16).toString('hex');
    view.webview.html = `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { padding: 8px; }
  .field { display: flex; flex-direction: column; gap: 3px; margin-bottom: 10px; }
  label { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); }
  .box { position: relative; }
  input {
    width: 100%; box-sizing: border-box; padding: 4px 6px; font-size: var(--vscode-font-size);
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; outline: none;
  }
  input:focus { border-color: var(--vscode-focusBorder); }
  input::placeholder { color: var(--vscode-input-placeholderForeground); }
  #search { padding-right: 76px; }
  .toggles { position: absolute; right: 3px; top: 50%; transform: translateY(-50%); display: flex; gap: 2px; }
  .toggle {
    display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 20px;
    border-radius: 3px; cursor: pointer; user-select: none; font-size: 11px; border: 1px solid transparent;
    color: var(--vscode-input-foreground); opacity: .65;
  }
  .toggle:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .toggle.active {
    opacity: 1; background: var(--vscode-inputOption-activeBackground);
    border-color: var(--vscode-inputOption-activeBorder); color: var(--vscode-inputOption-activeForeground);
  }
</style></head><body>
  <div class="field">
    <label for="filter">Filter files by name</label>
    <div class="box"><input id="filter" type="text" placeholder="substring…" /></div>
  </div>
  <div class="field">
    <label for="search">Search in changed files</label>
    <div class="box">
      <input id="search" type="text" placeholder="text, then Enter" />
      <div class="toggles">
        <span class="toggle" id="t-case" title="Match Case">Aa</span>
        <span class="toggle" id="t-word" title="Match Whole Word">\\b</span>
        <span class="toggle" id="t-regex" title="Use Regular Expression">.*</span>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const f = document.getElementById('filter'), s = document.getElementById('search');
    const toggles = { case: document.getElementById('t-case'), word: document.getElementById('t-word'), regex: document.getElementById('t-regex') };
    const state = Object.assign({ filter: '', search: '', case: false, word: false, regex: false }, vscode.getState());
    f.value = state.filter; s.value = state.search;
    for (const k of ['case', 'word', 'regex']) toggles[k].classList.toggle('active', !!state[k]);
    const save = () => vscode.setState(state);
    const doSearch = () => { if (s.value) vscode.postMessage({ type: 'search', value: s.value, caseSensitive: state.case, wholeWord: state.word, regex: state.regex }); };
    f.addEventListener('input', () => { state.filter = f.value; save(); vscode.postMessage({ type: 'filter', value: f.value }); });
    s.addEventListener('input', () => { state.search = s.value; save(); });
    s.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
    for (const k of ['case', 'word', 'regex']) toggles[k].addEventListener('click', () => {
      state[k] = !state[k]; toggles[k].classList.toggle('active', state[k]); save(); doSearch();
    });
  </script>
</body></html>`;
    view.webview.onDidReceiveMessage((m) => {
      if (m.type === 'filter') {
        diffTree.nameFilter = (m.value || '').trim().toLowerCase();
        refreshTree();
      } else if (m.type === 'search' && m.value) {
        const files = diffTree?.files ?? [];
        if (!files.length) {
          vscode.window.showInformationMessage('No changed files to search.');
          return;
        }
        vscode.commands.executeCommand('workbench.action.findInFiles', {
          query: m.value,
          filesToInclude: files.join(','), // scope to the changed files only
          triggerSearch: true,
          isCaseSensitive: !!m.caseSensitive,
          matchWholeWord: !!m.wholeWord,
          isRegex: !!m.regex,
        });
      }
    });
  }
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
    this.nameFilter = ''; // lowercased filename filter; '' = show all
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
        for (const rel of await untrackedFiles(cwd)) {
          if (status.has(rel)) continue;
          files.push(rel);
          status.set(rel, 'U');
          added.add(rel); // no base version → open as file, not diff
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
      const shown = this.nameFilter
        ? this.files.filter((f) => f.toLowerCase().includes(this.nameFilter))
        : this.files;
      const active = shown.filter((f) => !ignored.has(f));
      const unv = active.filter((f) => !isViewed(cwd, viewed, f));
      const vw = active.filter((f) => isViewed(cwd, viewed, f));
      const ig = shown.filter((f) => ignored.has(f));
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

/** Open every file in a tree group (Unviewed / Viewed / Untracked) via the shared open flow. */
async function treeOpenGroup(item) {
  const cwd = getCwd();
  const base = diffTree?.base;
  if (!cwd || !base || !item?.files?.length) return;
  await openFiles(cwd, base, item.files);
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

/** Pick an open PR, check it out via gh, and diff it against its base branch. */
async function reviewPr(context) {
  const cwd = getCwd();
  if (!cwd) {
    vscode.window.showErrorMessage('Open a folder first.');
    return;
  }
  let prs;
  try {
    const out = await gh(cwd, ['pr', 'list', '--json', 'number,title,headRefName,baseRefName', '--limit', '50']);
    prs = JSON.parse(out);
  } catch (e) {
    vscode.window.showErrorMessage(`Could not list PRs (need GitHub CLI \`gh\`, authenticated): ${e.message}`);
    return;
  }
  if (!prs.length) {
    vscode.window.showInformationMessage('No open PRs.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    prs.map((p) => ({ label: `#${p.number} ${p.title}`, description: `${p.headRefName} → ${p.baseRefName}`, pr: p })),
    { placeHolder: 'Pick a PR to review' }
  );
  if (!pick) return;
  const pr = pick.pr;

  // Block the review if the working tree is dirty — don't touch the user's uncommitted changes.
  if ((await git(cwd, ['status', '--porcelain'])).trim()) {
    vscode.window.showErrorMessage('Commit or stash your working changes before reviewing a PR.');
    return;
  }

  let original;
  try {
    original = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    await gh(cwd, ['pr', 'checkout', String(pr.number)]);
  } catch (e) {
    vscode.window.showErrorMessage(`PR checkout failed: ${e.message}`);
    return;
  }
  const prBranch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();

  await context.workspaceState.update(REVIEW_KEY, { original, prBranch, number: pr.number });
  await context.workspaceState.update(LAST_BRANCH_KEY, pr.baseRefName); // ponytail: plain base name — fine when it exists locally (usually main); diff errors otherwise
  await vscode.commands.executeCommand('setContext', 'diffbranch.reviewing', true);
  updateViewedContext(context);
  await diffTree.load();
  vscode.window.showInformationMessage(`Reviewing PR #${pr.number} (${prBranch}) vs ${pr.baseRefName}.`);
}

/** Return to the pre-review branch and delete the checked-out PR branch locally. */
async function finishReview(context) {
  const cwd = getCwd();
  const st = context.workspaceState.get(REVIEW_KEY);
  if (!cwd || !st?.prBranch) {
    vscode.window.showInformationMessage('No active PR review.');
    return;
  }
  const ok = await vscode.window.showWarningMessage(
    `Finish review: return to "${st.original}" and delete local branch "${st.prBranch}"?`,
    { modal: true },
    'Delete branch'
  );
  if (ok !== 'Delete branch') return;
  try {
    await git(cwd, ['checkout', st.original]);
    await git(cwd, ['branch', '-D', st.prBranch]);
  } catch (e) {
    vscode.window.showErrorMessage(`Cleanup failed (uncommitted changes?): ${e.message}`);
    return;
  }
  await context.workspaceState.update(REVIEW_KEY, undefined);
  await vscode.commands.executeCommand('setContext', 'diffbranch.reviewing', false);
  await diffTree.load();
  vscode.window.showInformationMessage(`Removed "${st.prBranch}", back on "${st.original}".`);
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
