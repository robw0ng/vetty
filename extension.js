const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(cp.execFile);

const LAST_BRANCH_KEY = 'vetty.lastBranch';
const MAX_OPEN_WITHOUT_CONFIRM = 30;

// Own scheme for the diff's base side. Built-in `git:` errors on files absent from base (added
// files), breaking the diff; this provider returns '' for those so the left side just shows empty.
const BASE_SCHEME = 'vetty-base';
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

// Left side = the content snapshot taken when a file was last marked viewed (stored as a git blob).
// Lets the Unviewed group diff "what changed since I last reviewed it" instead of the full base diff.
const BLOB_SCHEME = 'vetty-blob';
function blobUriFor(fileUri, sha) {
  return fileUri.with({ scheme: BLOB_SCHEME, query: JSON.stringify({ path: fileUri.fsPath, sha }) });
}
const blobContentProvider = {
  provideTextDocumentContent(uri) {
    const cwd = getCwd();
    let q;
    try { q = JSON.parse(uri.query); } catch { return ''; }
    if (!cwd || !q.sha) return '';
    return git(cwd, ['cat-file', '-p', q.sha]).catch(() => '');
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
let diffTreeView = null;
let todoTree = null;
let extContext = null; // set in activate; lets command wrappers reach workspaceState
function refreshTree() {
  diffTree?.refresh();
  diffTree?.updateProgress();
}

function getCwd() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

/** Async git — non-blocking, so the extension host stays responsive. */
async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

// Case-sensitive (uppercase) so prose words like "note"/"bug" don't false-positive.
const TODO_RE = /\b(TODO|FIXME|HACK|XXX|BUG|NOTE|OPTIMIZE|REVIEW|WIP|TEMP|REFACTOR|DEPRECATED)\b/;

/** TODO/FIXME markers introduced vs base: added diff lines + every line of untracked files. */
async function findTodos(cwd, base) {
  const todos = []; // { rel, line, text }
  let out = '';
  try {
    out = await git(cwd, ['diff', '-U0', '--diff-filter=d', base]); // -U0 → only added lines, no context
  } catch {
    return todos;
  }
  let rel = null;
  let newLine = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('+++ ')) {
      rel = line.slice(4).replace(/^b\//, '');
      continue;
    }
    if (line.startsWith('---')) continue;
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) {
      newLine = parseInt(hunk[1], 10);
      continue;
    }
    if (line.startsWith('+')) {
      const content = line.slice(1);
      if (rel && TODO_RE.test(content)) todos.push({ rel, line: newLine, text: content.trim() });
      newLine++;
    }
    // '-' lines (deletions) don't advance the new-file counter; with -U0 there are no context lines.
  }
  for (const u of await untrackedFiles(cwd)) {
    try {
      fs.readFileSync(path.join(cwd, u), 'utf8').split('\n').forEach((l, i) => {
        if (TODO_RE.test(l)) todos.push({ rel: u, line: i + 1, text: l.trim() });
      });
    } catch {
      // unreadable/binary — skip
    }
  }
  return todos;
}

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

// Viewed marks are per base branch, stored as { relPath: { h: contentHash, b: gitBlobSha } }. A file
// counts as viewed only while its content still matches `h` (editing it re-flags it unviewed). `b` is
// the snapshot at mark time, used to diff "changes since last review". Legacy entries are bare hashes.
function viewedKey(base) {
  return `vetty.viewed.${base}`;
}
function getViewed(context, base) {
  const raw = context.workspaceState.get(viewedKey(base));
  return raw && !Array.isArray(raw) ? { ...raw } : {};
}
function setViewed(context, base, map) {
  return context.workspaceState.update(viewedKey(base), map);
}
function viewedHash(v) {
  return typeof v === 'string' ? v : v?.h; // tolerate legacy bare-hash entries
}
function reviewedBlob(map, rel) {
  const v = map[rel];
  return v && typeof v === 'object' ? v.b : null;
}
function isViewed(cwd, map, rel) {
  const h = viewedHash(map[rel]);
  return !!h && h === fileHash(cwd, rel);
}

/** Snapshot the working file into git's object store and return { h, b } for the viewed map. */
async function viewedEntry(cwd, rel) {
  const h = fileHash(cwd, rel);
  let b = null;
  try {
    b = (await git(cwd, ['hash-object', '-w', '--', path.join(cwd, rel)])).trim() || null;
  } catch {
    // blob snapshot best-effort; viewed-ness still works via hash
  }
  return { h, b };
}

// Ignored marks are a plain per-base list of paths — a deliberate exclusion, so (unlike viewed) it
// is not tied to content hash. Ignored files get their own tree group, out of Unviewed/Viewed.
function ignoredKey(base) {
  return `vetty.ignored.${base}`;
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

// Only auto-pick a base if a conventional base branch exists. Otherwise return null and let the user
// pick one manually (the tree shows "Select a branch to diff against…").
async function defaultBase(cwd) {
  let cur = '';
  try {
    cur = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  } catch {
    // detached/no HEAD — fall through
  }
  let names = [];
  try {
    names = (await git(cwd, ['branch', '--format=%(refname:short)']))
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
  for (const c of ['main', 'master', 'develop', 'dev', 'trunk']) {
    if (c !== cur && names.includes(c)) return c;
  }
  return null; // no common base branch found — user picks manually
}

/** On first run (no base chosen yet), seed the base with the best guess so the tree just works. */
async function ensureDefaultBase(context) {
  if (lastBranch(context)) return;
  const cwd = getCwd();
  if (!cwd) return;
  const base = await defaultBase(cwd);
  if (base) await context.workspaceState.update(LAST_BRANCH_KEY, base);
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
  vscode.commands.executeCommand('setContext', 'vetty.activeViewed', viewed);
}

// --- Local review comments: PR-style inline comment threads, persisted in workspaceState ---
const COMMENTS_KEY = 'vetty.comments';
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
/** 1-based "12" or "12-18" for a 0-based range. A range ending at column 0 doesn't include that line. */
function lineRef(sLine, eLine, eChar) {
  const last = eChar === 0 && eLine > sLine ? eLine : eLine + 1; // 1-based last included line
  const start = sLine + 1;
  return start === last ? `${start}` : `${start}-${last}`;
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
      lines.push(`- ${rel}:${lineRef(n.range[0], n.range[2], n.range[3])} — ${text}`);
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

async function copyComment(comment) {
  if (!comment?.body) return;
  const text = bodyText(comment).replace(/\s+/g, ' ').trim();
  const cwd = getCwd();
  const thread =
    commentThreads.find((t) => t.comments.includes(comment)) ||
    commentThreads.find((t) => t.comments.some((c) => bodyText(c) === bodyText(comment)));
  let line = `- ${text}`;
  if (thread && cwd) {
    const rel = thread.dbRel || relOf(cwd, thread.uri);
    const r = thread.range;
    if (rel) line = `- ${rel}:${lineRef(r.start.line, r.end.line, r.end.character)} — ${text}`; // same format as Export
  }
  await vscode.env.clipboard.writeText(line);
  vscode.window.setStatusBarMessage('Comment copied', 2000);
}

async function clearAllComments(context) {
  const stored = Object.keys(getComments(context)).length;
  if (!commentThreads.length && !stored) {
    vscode.window.showInformationMessage('No comments to clear.');
    return;
  }
  const ok = await vscode.window.showWarningMessage(
    'Delete ALL review comments? This cannot be undone.',
    { modal: true },
    'Delete all'
  );
  if (ok !== 'Delete all') return;
  for (const t of commentThreads) t.dispose();
  commentThreads.length = 0;
  await context.workspaceState.update(COMMENTS_KEY, {});
  vscode.window.showInformationMessage('Cleared all review comments.');
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  extContext = context;
  diffTree = new DiffTree(context);
  todoTree = new TodoTree(context);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, baseContentProvider),
    vscode.workspace.registerTextDocumentContentProvider(BLOB_SCHEME, blobContentProvider),
    vscode.window.registerFileDecorationProvider(fileDecorations),
    vscode.window.registerWebviewViewProvider('vettySearch', new SearchView()),
    (diffTreeView = vscode.window.createTreeView('vettyView', { treeDataProvider: diffTree, canSelectMany: true })),
    vscode.window.registerTreeDataProvider('vettyTodos', todoTree),
    vscode.commands.registerCommand('vetty.openTodo', (rel, line) => openTodo(rel, line)),
    vscode.commands.registerCommand('vetty.openAll', () => openAll(context)),
    vscode.commands.registerCommand('vetty.openUnviewed', () => openByViewed(context, false)),
    vscode.commands.registerCommand('vetty.openViewed', () => openByViewed(context, true)),
    vscode.commands.registerCommand('vetty.toggleViewed', () => applyViewed(context)),
    vscode.commands.registerCommand('vetty.markViewed', () => applyViewed(context, true)),
    vscode.commands.registerCommand('vetty.unmarkViewed', () => applyViewed(context, false)),
    vscode.commands.registerCommand('vetty.clearViewed', () => clearViewed(context)),
    // Tree (Activity Bar) commands.
    vscode.commands.registerCommand('vetty.treePickBranch', () => treePickBranch(context)),
    vscode.commands.registerCommand('vetty.treeRefresh', () => diffTree.load()),
    vscode.commands.registerCommand('vetty.treeOpenUnviewed', () => treeOpenUnviewed(context)),
    vscode.commands.registerCommand('vetty.treeOpenFile', (item, sel) => treeOpenFile(item, sel)),
    vscode.commands.registerCommand('vetty.treeOpenDiff', (item, sel) => treeOpenDiff(item, sel)),
    vscode.commands.registerCommand('vetty.treeView', (item, sel) => treeSetViewed(context, item, sel, true)),
    vscode.commands.registerCommand('vetty.treeUnview', (item, sel) => treeSetViewed(context, item, sel, false)),
    vscode.commands.registerCommand('vetty.treeIgnore', (item, sel) => treeSetIgnored(context, item, sel, true)),
    vscode.commands.registerCommand('vetty.treeUnignore', (item, sel) => treeSetIgnored(context, item, sel, false)),
    vscode.commands.registerCommand('vetty.viewAsTree', () => toggleNesting(context)),
    vscode.commands.registerCommand('vetty.viewAsList', () => toggleNesting(context)),
    vscode.commands.registerCommand('vetty.diffSinceReview', () => toggleSinceReview(context)),
    vscode.commands.registerCommand('vetty.diffFull', () => toggleSinceReview(context)),
    vscode.commands.registerCommand('vetty.copyPaths', () => copyPaths()),
    vscode.commands.registerCommand('vetty.treeOpenGroup', (item) => treeOpenGroup(item)),
    vscode.commands.registerCommand('vetty.treeMarkAllViewed', (item) => treeMarkAllViewed(context, item)),
    vscode.commands.registerCommand('vetty.treeMarkAllUnviewed', (item) => treeMarkAllUnviewed(context, item)),
    vscode.window.onDidChangeActiveTextEditor(() => updateViewedContext(context)),
    vscode.workspace.onDidSaveTextDocument(() => {
      updateViewedContext(context);
      refreshTree();
      todoTree.load();
    })
  );
  // Review comments: register the comment controller, hydrate stored comments as editors open.
  commentController = vscode.comments.createCommentController('vetty.comments', 'Vetty Comments');
  commentController.commentingRangeProvider = {
    provideCommentingRanges(doc) {
      return doc.uri.scheme === 'file' ? [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)] : [];
    },
  };
  context.subscriptions.push(
    commentController,
    vscode.commands.registerCommand('vetty.createComment', (reply) => createComment(context, reply)),
    vscode.commands.registerCommand('vetty.deleteComment', (thread) => deleteComment(context, thread)),
    vscode.commands.registerCommand('vetty.exportComments', () => exportComments(context)),
    vscode.commands.registerCommand('vetty.clearComments', () => clearAllComments(context)),
    vscode.commands.registerCommand('vetty.copyComment', (comment) => copyComment(comment)),
    vscode.workspace.onDidOpenTextDocument((doc) => hydrateComments(context, doc)),
    vscode.window.onDidChangeActiveTextEditor((ed) => ed && hydrateComments(context, ed.document))
  );
  for (const ed of vscode.window.visibleTextEditors) hydrateComments(context, ed.document);

  vscode.commands.executeCommand('setContext', 'vetty.nested', diffTree.nested);
  vscode.commands.executeCommand('setContext', 'vetty.sinceReview', sinceReviewMode(context));

  // Auto-refresh: react to git state (checkout/pull/commit) AND any working-tree edit, including
  // files written outside the editor (e.g. an AI tool editing files directly, no save event).
  const cwd = getCwd();
  if (cwd) {
    let timer = null;
    const bump = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => ensureDefaultBase(context).then(() => diffTree.load()), 400); // debounce edit bursts
    };
    const gitWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(cwd, '.git/{HEAD,ORIG_HEAD,index}')
    );
    // Working files. VS Code applies files.watcherExclude (node_modules, etc.) automatically.
    const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*');
    for (const w of [gitWatcher, fileWatcher]) {
      w.onDidChange(bump);
      w.onDidCreate(bump);
      w.onDidDelete(bump);
      context.subscriptions.push(w);
    }
  }

  (async () => {
    await ensureDefaultBase(context);
    updateViewedContext(context);
    await diffTree.load();
  })();
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
  if (next) viewed[rel] = await viewedEntry(cwd, rel);
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
    this.nested = !!context.workspaceState.get('vetty.nested'); // folder tree vs flat list
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
    this.updateProgress();
    fileDecorations.refresh();
    todoTree?.load();
  }

  /** Show "N/total viewed" next to the section title. */
  updateProgress() {
    if (!diffTreeView) return;
    const cwd = getCwd();
    if (!cwd || !this.base) {
      diffTreeView.description = '';
      return;
    }
    const viewed = getViewed(this.context, this.base);
    const ignored = getIgnored(this.context, this.base);
    const active = this.files.filter((f) => !ignored.has(f));
    const vw = active.filter((f) => isViewed(cwd, viewed, f)).length;
    diffTreeView.description = active.length ? `${vw}/${active.length} viewed` : '';
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
      it.command = { command: 'vetty.treePickBranch', title: 'Change Branch' };
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

    // Group or folder node: flat list, or one level of the folder tree when nested.
    const files = el.files || [];
    if (!this.nested) return files.map((f) => this._file(cwd, f, !!el.ignored));
    return this._folderChildren(cwd, files, el.prefix || '', !!el.ignored);
  }

  /** Immediate children (subfolders + files) of `prefix` within `files`, for the nested view. */
  _folderChildren(cwd, files, prefix, isIgnored) {
    const folders = new Map(); // segment → files under it
    const leaves = [];
    for (const rel of files) {
      const rest = rel.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) leaves.push(rel);
      else {
        const seg = rest.slice(0, slash);
        if (!folders.has(seg)) folders.set(seg, []);
        folders.get(seg).push(rel);
      }
    }
    const folderNodes = [...folders.entries()].map(([seg, fs]) => {
      const it = new vscode.TreeItem(seg, vscode.TreeItemCollapsibleState.Expanded);
      it.iconPath = vscode.ThemeIcon.Folder;
      it.files = fs;
      it.prefix = prefix + seg + '/';
      it.ignored = isIgnored;
      it.contextValue = 'folder';
      it.id = `folder:${this.base}:${it.prefix}`; // stable → keeps expand state
      return it;
    });
    return [...folderNodes, ...leaves.map((f) => this._file(cwd, f, isIgnored))];
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
    it.id = contextValue || 'group'; // stable id so VS Code keeps expand/collapse across refreshes
    return it;
  }

  _file(cwd, rel, isIgnored) {
    const dir = path.dirname(rel);
    const it = new vscode.TreeItem(path.basename(rel)); // filename first, like Source Control
    it.description = this.nested || dir === '.' ? '' : dir; // dir shown by hierarchy when nested
    const viewed = isViewed(cwd, getViewed(this.context, this.base), rel);
    it.rel = rel;
    it.resourceUri = vscode.Uri.file(path.join(cwd, rel));
    it.contextValue = isIgnored ? 'file-ignored' : viewed ? 'file-viewed' : 'file-unviewed';
    it.tooltip = `${rel} — ${isIgnored ? 'untracked' : viewed ? 'viewed' : 'unviewed'}`;
    // Added file → open whole file, UNLESS it has a since-review snapshot to diff against.
    const cmd = this.added.has(rel) && !hasSinceReviewDiff(this.context, cwd, this.base, rel)
      ? 'vetty.treeOpenFile'
      : 'vetty.treeOpenDiff';
    it.command = { command: cmd, title: 'Open', arguments: [it] };
    return it;
  }
}

/** Side-panel "New TODOs" view: TODO/FIXME markers introduced vs the selected branch. */
class TodoTree {
  constructor(context) {
    this.context = context;
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    this.items = [];
  }
  refresh() {
    this._emitter.fire();
  }
  async load() {
    const cwd = getCwd();
    const base = lastBranch(this.context);
    this.items = cwd && base ? await findTodos(cwd, base) : [];
    this.refresh();
  }
  getTreeItem(el) {
    return el;
  }
  getChildren(el) {
    if (el) return [];
    if (!this.items.length) {
      const it = new vscode.TreeItem('No TODOs');
      it.iconPath = new vscode.ThemeIcon('check');
      return [it];
    }
    return this.items.map((t) => {
      const msg = t.text.replace(/^\s*(\/\/+|#+|\/\*+|\*+|<!--|--)\s?/, '').replace(/\s*(\*\/|-->)\s*$/, '').trim();
      const it = new vscode.TreeItem(msg || t.text);
      it.description = `${path.basename(t.rel)}:${t.line}`; // filename:line, dimmed
      it.tooltip = `${t.rel}:${t.line}\n\n${t.text}`;
      it.iconPath = new vscode.ThemeIcon('checklist');
      it.command = { command: 'vetty.openTodo', title: 'Open', arguments: [t.rel, t.line] };
      return it;
    });
  }
}

async function openTodo(rel, line) {
  const cwd = getCwd();
  if (!cwd) return;
  const uri = vscode.Uri.file(path.join(cwd, rel));
  const sel = new vscode.Range(line - 1, 0, line - 1, 0);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { selection: sel });
}

/** Repo-relative paths from a tree action: the multi-selection if present, else the clicked row. */
function selectedRels(item, sel) {
  const items = Array.isArray(sel) && sel.length ? sel : item ? [item] : [];
  return items.map((i) => (typeof i === 'string' ? i : i?.rel)).filter(Boolean);
}

/** Ctrl+C in the Review tree: copy selected file paths (folders/groups expand to their files). */
async function copyPaths() {
  const rels = [];
  for (const it of diffTreeView?.selection || []) {
    if (it.rel) rels.push(it.rel);
    else if (Array.isArray(it.files)) rels.push(...it.files);
  }
  if (!rels.length) return;
  await vscode.env.clipboard.writeText([...new Set(rels)].join('\n'));
  vscode.window.setStatusBarMessage(`Copied ${new Set(rels).size} path(s)`, 2000);
}

async function treeOpenFile(item, sel) {
  const cwd = getCwd();
  const rels = selectedRels(item, sel);
  if (!cwd || !rels.length) return;
  const preview = rels.length === 1; // single → preview tab; multiple → keep them all open
  await Promise.all(
    rels.map((rel) =>
      vscode.window.showTextDocument(vscode.Uri.file(path.join(cwd, rel)), { preview, preserveFocus: !preview })
    )
  );
}

// Whether to diff unviewed files against their last-reviewed snapshot (vs the full base diff).
function sinceReviewMode(context) {
  return context.workspaceState.get('vetty.sinceReview') !== false; // default on
}

/** True when `rel` has a usable since-last-review snapshot to diff against (blob present, now unviewed). */
function hasSinceReviewDiff(context, cwd, base, rel) {
  if (!base || !sinceReviewMode(context)) return false;
  const viewed = getViewed(context, base);
  return !!reviewedBlob(viewed, rel) && !isViewed(cwd, viewed, rel);
}

/** Open one file's diff: against the last-reviewed snapshot when available + enabled, else base. */
function openOneDiff(context, cwd, base, rel, opts) {
  const fileUri = vscode.Uri.file(path.join(cwd, rel));
  if (hasSinceReviewDiff(context, cwd, base, rel)) {
    const blob = reviewedBlob(getViewed(context, base), rel);
    return vscode.commands.executeCommand(
      'vscode.diff', blobUriFor(fileUri, blob), fileUri, `${rel} (since last review)`, opts
    );
  }
  return vscode.commands.executeCommand(
    'vscode.diff', baseUriFor(fileUri, base), fileUri, `${rel} (${base} ↔ working)`, opts
  );
}

async function treeOpenDiff(item, sel) {
  const cwd = getCwd();
  const base = diffTree?.base;
  const rels = selectedRels(item, sel);
  if (!cwd || !base || !rels.length) return;
  const opts = { preview: rels.length === 1, preserveFocus: rels.length > 1 };
  await Promise.all(rels.map((rel) => openOneDiff(extContext, cwd, base, rel, opts)));
}

async function treeSetViewed(context, item, sel, makeViewed) {
  const cwd = getCwd();
  const base = diffTree?.base;
  const rels = selectedRels(item, sel);
  if (!cwd || !base || !rels.length) return;
  const viewed = getViewed(context, base);
  for (const rel of rels) {
    if (makeViewed) viewed[rel] = await viewedEntry(cwd, rel);
    else delete viewed[rel];
  }
  await setViewed(context, base, viewed);
  updateViewedContext(context);
  refreshTree();
  // Auto-advance: marking a single file viewed opens the next unviewed one.
  if (makeViewed && rels.length === 1) await openNextUnviewed(context, base, cwd, rels[0]);
}

/** After a file is marked viewed, open the next still-unviewed changed file (diff or file). */
async function openNextUnviewed(context, base, cwd, justViewed) {
  const ignored = getIgnored(context, base);
  const viewed = getViewed(context, base);
  const order = diffTree.files.filter((f) => !ignored.has(f));
  const start = order.indexOf(justViewed);
  const next = order.slice(start + 1).concat(order.slice(0, start + 1)).find((f) => !isViewed(cwd, viewed, f));
  if (!next) return; // all viewed
  if (diffTree.added.has(next) && !hasSinceReviewDiff(context, cwd, base, next)) {
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(cwd, next)), { preview: true });
  } else {
    await openOneDiff(context, cwd, base, next, { preview: true });
  }
}

async function toggleNesting(context) {
  if (!diffTree) return;
  diffTree.nested = !diffTree.nested;
  await context.workspaceState.update('vetty.nested', diffTree.nested);
  await vscode.commands.executeCommand('setContext', 'vetty.nested', diffTree.nested);
  refreshTree();
}

async function toggleSinceReview(context) {
  const next = !sinceReviewMode(context);
  await context.workspaceState.update('vetty.sinceReview', next);
  await vscode.commands.executeCommand('setContext', 'vetty.sinceReview', next);
  vscode.window.setStatusBarMessage(next ? 'Diff: since last review' : 'Diff: full (vs base)', 2500);
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
  for (const rel of item.files) viewed[rel] = await viewedEntry(cwd, rel);
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

async function treeSetIgnored(context, item, sel, makeIgnored) {
  const base = diffTree?.base;
  const rels = selectedRels(item, sel);
  if (!base || !rels.length) return;
  const ig = getIgnored(context, base);
  for (const rel of rels) (makeIgnored ? ig.add(rel) : ig.delete(rel));
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
