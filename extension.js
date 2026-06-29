const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const path = require('path');
const { promisify } = require('util');
const { lineRef, buildSearchRegex, parseAheadBehind, parseNumstat, parseTodoHunks } = require('./lib');

const execFileAsync = promisify(cp.execFile);

const LAST_BRANCH_KEY = 'vetty.lastBranch';
const MAX_OPEN_WITHOUT_CONFIRM = 30;
const PAGE_SIZE = 500; // flat-view rows per group before a "Show more" row appears

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
  postSearchCounts();
  todoTree?.refresh(); // re-slice TODOs to the active filter
}

function getCwd() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

/** Async git — non-blocking, so the extension host stays responsive. */
async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

// Resolve the ref to diff against: the merge-base of `base` and HEAD, NOT base's tip. This matches
// GitHub's "files changed" (only what this branch added since it forked) — diffing against the tip
// of a base that has since advanced would wrongly include every file the base moved ahead on.
// If base IS an ancestor (e.g. the current branch), merge-base ≈ HEAD, so working changes still show.
async function mergeBaseRef(cwd, base) {
  try {
    const mb = (await git(cwd, ['merge-base', base, 'HEAD'])).trim();
    return mb || base;
  } catch {
    return base;
  }
}

/** GitHub CLI. PR features are gated on this being present + authenticated. */
async function gh(cwd, args) {
  const { stdout } = await execFileAsync('gh', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}
let hasGh = false; // gh installed + authed
function prEnabled() {
  return vscode.workspace.getConfiguration('vetty').get('pullRequests.enabled', false); // experimental, opt-in
}
async function updatePrMode() {
  // PR features require both the setting AND a working gh.
  await vscode.commands.executeCommand('setContext', 'vetty.prMode', hasGh && prEnabled());
}
async function detectGh(cwd) {
  try {
    await execFileAsync('gh', ['auth', 'status'], { cwd });
    hasGh = true;
  } catch {
    hasGh = false;
  }
  await updatePrMode();
  return hasGh;
}

const REVIEW_KEY = 'vetty.review'; // { original, prBranch, number, repo, headSha } while reviewing a PR

// Case-sensitive (uppercase) so prose words like "note"/"bug" don't false-positive.
const TODO_RE = /\b(TODO|FIXME|HACK|XXX|BUG|NOTE|OPTIMIZE|REVIEW|WIP|TEMP|REFACTOR|DEPRECATED)\b/;

/** TODO/FIXME markers on added diff lines vs `ref` + every line of untracked files. */
async function findTodos(cwd, ref) {
  let out = '';
  try {
    out = await git(cwd, ['diff', '-U0', '--diff-filter=d', ref]); // -U0 → only added lines, no context
  } catch {
    return [];
  }
  const todos = parseTodoHunks(out, TODO_RE); // { rel, line, text }[]
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

// Groups: a per-base { relPath: groupName } map. Lets you bucket changed files (by intent) and stage
// a bucket at a time — a lightweight, working-copy-only changelist. Shown as a [name] tag on the row.
function groupsKey(base) {
  return `vetty.groups.${base}`;
}
function getGroups(context, base) {
  const raw = context.workspaceState.get(groupsKey(base));
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
}
function setGroups(context, base, map) {
  return context.workspaceState.update(groupsKey(base), map);
}
function groupNames(map) {
  return [...new Set(Object.values(map))];
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

/** Commits in HEAD-not-branch (ahead) and branch-not-HEAD (behind). null if it can't be computed. */
async function aheadBehind(cwd, branch) {
  try {
    return parseAheadBehind(await git(cwd, ['rev-list', '--left-right', '--count', `${branch}...HEAD`]));
  } catch {
    return null; // unrelated histories / bad ref
  }
}

const MAX_REL_BRANCHES = 50; // cap ahead/behind computation to the most-recent branches (perf)

async function currentBranch(cwd) {
  try {
    return (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  } catch {
    return '';
  }
}

async function localBranches(cwd) {
  try {
    return (await git(cwd, ['branch', '--format=%(refname:short)', '--sort=-committerdate']))
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Git stores no parent, so infer it: a branch whose tip is an ANCESTOR of HEAD (behind === 0, ahead > 0)
// is one this branch was built on; the DIRECT parent is the ancestor closest to HEAD (fewest commits
// ahead). Falls back to a conventional base branch, then the most recent other branch.
async function defaultBase(cwd) {
  const cur = await currentBranch(cwd);
  const names = await localBranches(cwd);
  if (!names.length) return null;
  const others = names.filter((n) => n !== cur).slice(0, MAX_REL_BRANCHES);

  let parent = null;
  let parentAhead = Infinity;
  await Promise.all(
    others.map(async (b) => {
      const ab = await aheadBehind(cwd, b);
      if (ab && ab.behind === 0 && ab.ahead > 0 && ab.ahead < parentAhead) {
        parentAhead = ab.ahead;
        parent = b;
      }
    })
  );
  if (parent) return parent;
  for (const c of ['main', 'master', 'develop', 'dev', 'trunk']) {
    if (c !== cur && names.includes(c)) return c;
  }
  return names.filter((n) => n !== cur)[0] || null;
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

// Read-only comment threads pulled FROM the PR being reviewed (so you see teammates' existing review).
let prCommentMap = new Map(); // rel → [{ line, body, author }]
const prThreads = []; // live read-only PR threads (disposed when the review ends)
const prBuiltDocs = new Set();

function getComments(context) {
  return context.workspaceState.get(COMMENTS_KEY) || {};
}
function commentCount(context) {
  return Object.values(getComments(context)).reduce((n, arr) => n + (arr?.length || 0), 0);
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

/** Reserialize all live threads back to workspaceState. `anchor` = the start line's text, so the
 *  comment can re-find its line if the file is later rewritten (e.g. by an AI edit). */
async function persistComments(context) {
  const cwd = getCwd();
  const map = {};
  for (const t of commentThreads) {
    if (t.isPr) continue; // never persist pulled-from-PR threads as local comments
    const rel = t.dbRel || (cwd && relOf(cwd, t.uri));
    if (!rel || !t.comments.length) continue;
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === t.uri.toString());
    const anchor = open && t.range.start.line < open.lineCount ? open.lineAt(t.range.start.line).text.trim() : '';
    (map[rel] ||= []).push({
      range: [t.range.start.line, t.range.start.character, t.range.end.line, t.range.end.character],
      anchor,
      comments: t.comments.map(bodyText),
    });
  }
  await context.workspaceState.update(COMMENTS_KEY, map);
}

/** Find which line `anchor` is on now — the stored line if unchanged, else the nearest line that matches. */
function relocateLine(doc, storedLine, anchor) {
  if (!anchor) return storedLine; // no/empty anchor → can't relocate reliably
  if (storedLine < doc.lineCount && doc.lineAt(storedLine).text.trim() === anchor) return storedLine;
  for (let d = 1; d < doc.lineCount; d++) {
    const dn = storedLine + d;
    const up = storedLine - d;
    if (dn < doc.lineCount && doc.lineAt(dn).text.trim() === anchor) return dn;
    if (up >= 0 && doc.lineAt(up).text.trim() === anchor) return up;
  }
  return storedLine; // anchor gone (line deleted/changed) → keep original position
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
    const start = relocateLine(doc, n.range[0], n.anchor); // re-find the line if the file changed
    const delta = start - n.range[0];
    const range = new vscode.Range(start, n.range[1], n.range[2] + delta, n.range[3]);
    const thread = commentController.createCommentThread(doc.uri, range, n.comments.map(makeComment));
    thread.dbRel = rel;
    thread.contextValue = 'hasComment'; // gates the Delete Comment button (not shown on empty drafts)
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    commentThreads.push(thread);
  }
  addPrThreads(doc);
}

/** Fetch the active PR's existing review comments (read-only) so they show inline. */
async function fetchPrComments(cwd, repo, number) {
  prCommentMap = new Map();
  try {
    const out = await gh(cwd, ['api', '--paginate', `repos/${repo}/pulls/${number}/comments?per_page=100`]);
    for (const c of JSON.parse(out)) {
      const ln = c.line ?? c.original_line; // original_line for outdated comments
      if (!c.path || !ln) continue;
      if (!prCommentMap.has(c.path)) prCommentMap.set(c.path, []);
      prCommentMap.get(c.path).push({ line: ln, body: c.body || '', author: c.user?.login || 'reviewer' });
    }
  } catch {
    // no comments / API hiccup — leave empty
  }
}

/** Render the PR's existing comments as read-only threads in a freshly opened doc. */
function addPrThreads(doc) {
  const cwd = getCwd();
  if (!commentController || !cwd || !prCommentMap.size || doc.uri.scheme !== 'file') return;
  const key = doc.uri.toString();
  if (prBuiltDocs.has(key)) return;
  prBuiltDocs.add(key);
  const rel = relOf(cwd, doc.uri);
  for (const c of prCommentMap.get(rel) || []) {
    const range = new vscode.Range(c.line - 1, 0, c.line - 1, 0);
    const comment = { body: new vscode.MarkdownString(c.body), mode: vscode.CommentMode.Preview, author: { name: c.author } };
    const thread = commentController.createCommentThread(doc.uri, range, [comment]);
    thread.isPr = true; // never persisted, no edit/delete
    thread.canReply = false;
    thread.contextValue = 'prComment';
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    prThreads.push(thread);
  }
}

function clearPrThreads() {
  for (const t of prThreads) t.dispose();
  prThreads.length = 0;
  prBuiltDocs.clear();
  prCommentMap = new Map();
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
    vscode.commands.registerCommand('vetty.openMatch', (rel, line, col, len) => openMatch(rel, line, col, len)),
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
    vscode.commands.registerCommand('vetty.pickDiffMode', () => pickDiffMode(context)),
    vscode.commands.registerCommand('vetty.copyPaths', () => copyPaths()),
    vscode.commands.registerCommand('vetty.showMore', (key) => showMore(key)),
    vscode.commands.registerCommand('vetty.fetch', () => fetchAndRefresh(context)),
    vscode.commands.registerCommand('vetty.reviewPr', () => reviewPr(context)),
    vscode.commands.registerCommand('vetty.finishReview', () => finishReview(context)),
    vscode.commands.registerCommand('vetty.submitReview', () => submitReview(context)),
    vscode.commands.registerCommand('vetty.nextUnviewed', () => navigateUnviewed(context, 1)),
    vscode.commands.registerCommand('vetty.prevUnviewed', () => navigateUnviewed(context, -1)),
    vscode.commands.registerCommand('vetty.viewCurrent', () => applyViewed(context)),
    vscode.commands.registerCommand('vetty.togglePrMode', () => togglePrMode()),
    vscode.commands.registerCommand('vetty.stageViewed', () => stageViewed(context)),
    vscode.commands.registerCommand('vetty.stageFile', (item, sel) => stageFiles(context, item, sel)),
    vscode.commands.registerCommand('vetty.addToGroup', (item, sel) => addToGroup(context, item, sel)),
    vscode.commands.registerCommand('vetty.removeFromGroup', (item, sel) => removeFromGroup(context, item, sel)),
    vscode.commands.registerCommand('vetty.stageGroup', () => stageGroup(context)),
    vscode.commands.registerCommand('vetty.markGroupViewed', () => markGroupViewed(context)),
    vscode.commands.registerCommand('vetty.openGroup', () => openGroup(context)),
    vscode.commands.registerCommand('vetty.ungroup', () => ungroup(context)),
    vscode.commands.registerCommand('vetty.clearGroups', () => clearGroups(context)),
    vscode.commands.registerCommand('vetty.collapseAll', () => vscode.commands.executeCommand('workbench.actions.treeView.vettyView.collapseAll')),
    vscode.commands.registerCommand('vetty.hideWhitespace', () => toggleWhitespace(context)),
    vscode.commands.registerCommand('vetty.showWhitespace', () => toggleWhitespace(context)),
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('vetty.pullRequests.enabled')) return;
      await updatePrMode();
      // Disabling mid-review → clean up the checkout so the user isn't stranded on the PR branch.
      if (!prEnabled() && context.workspaceState.get(REVIEW_KEY)) await finishReview(context);
    }),
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
  vscode.commands.executeCommand('setContext', 'vetty.diffMode', diffMode(context));
  vscode.commands.executeCommand('setContext', 'vetty.hideWhitespace', diffTree.hideWhitespace);
  vscode.commands.executeCommand('setContext', 'vetty.reviewing', !!context.workspaceState.get(REVIEW_KEY));
  updatePrTitle(context);

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
    if (cwd) await detectGh(cwd);
    await ensureDefaultBase(context);
    updateViewedContext(context);
    await diffTree.load();
  })();
}

/** Branch picker — local branches, labeled by their relationship to the current branch (parent /
 *  ancestor / descendant / diverged), with the inferred direct parent surfaced first. */
async function pickBranch(context, cwd) {
  const last = lastBranch(context);
  const itemsPromise = (async () => {
    const cur = await currentBranch(cwd);
    const others = (await localBranches(cwd)).filter((n) => n !== cur);
    if (!others.length) return [];
    const rels = new Map();
    await Promise.all(others.slice(0, MAX_REL_BRANCHES).map(async (b) => rels.set(b, await aheadBehind(cwd, b))));

    const items = others.map((b) => {
      const ab = rels.get(b);
      let description = '';
      let rank = 5; // sort bucket: parent(0) ancestor(1) same(2) diverged(3) descendant(4) unknown(5)
      let ahead = Infinity;
      if (ab) {
        ahead = ab.ahead;
        if (ab.behind === 0 && ab.ahead > 0) (description = `ancestor · ${ab.ahead} ahead`), (rank = 1);
        else if (ab.ahead === 0 && ab.behind > 0) (description = `descendant · ${ab.behind} behind`), (rank = 4);
        else if (ab.ahead > 0 && ab.behind > 0) (description = `↑${ab.ahead} ↓${ab.behind}`), (rank = 3);
        else (description = 'up to date'), (rank = 2);
      }
      return { label: b, description, branch: b, rank, ahead };
    });

    // Direct parent = the ancestor closest to HEAD (fewest commits ahead).
    const parent = items.filter((i) => i.rank === 1).sort((a, b) => a.ahead - b.ahead)[0];
    if (parent) {
      parent.description = `parent · ${parent.ahead} ahead`;
      parent.rank = 0;
    }
    // Sort by bucket; within ancestors/parent, nearest first (fewest commits ahead) = stack order.
    items.sort((a, b) => a.rank - b.rank || a.ahead - b.ahead);
    if (last) {
      const i = items.findIndex((x) => x.branch === last);
      if (i > 0) items.unshift(items.splice(i, 1)[0]); // last-used to the very top
    }
    return items;
  })().catch((e) => {
    vscode.window.showErrorMessage(`Could not list branches: ${e.message}`);
    return [];
  });

  const pick = await vscode.window.showQuickPick(itemsPromise, {
    placeHolder: 'Diff against which local branch?',
  });
  if (!pick) return null;
  const base = pick.branch;
  await context.workspaceState.update(LAST_BRANCH_KEY, base);
  updateViewedContext(context);
  return base;
}

/** Files this branch changed vs base (merge-base, committed + uncommitted), deletes excluded. */
async function changedFiles(cwd, base) {
  let files;
  try {
    const ref = await mergeBaseRef(cwd, base);
    files = (await git(cwd, ['diff', '--name-only', '--diff-filter=d', ref]))
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
  const ref = await mergeBaseRef(cwd, base); // diff left side = merge-base, not base tip

  await Promise.all(
    files.map((rel) => {
      const fileUri = vscode.Uri.file(path.join(cwd, rel));
      if (asDiff) {
        const baseUri = baseUriFor(fileUri, ref);
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

let searchWebview = null; // set in SearchView.resolveWebviewView; used to push match counts

/** Push "shown of total" file counts to the Search panel. */
function postSearchCounts() {
  if (!searchWebview || !diffTree) return;
  const cwd = getCwd();
  if (!cwd || !diffTree.base) {
    searchWebview.postMessage({ type: 'counts', shown: 0, total: 0 });
    return;
  }
  const ignored = getIgnored(diffTree.context, diffTree.base);
  const total = diffTree.files.filter((f) => !ignored.has(f)).length;
  searchWebview.postMessage({ type: 'counts', shown: diffTree.visibleFiles(cwd).length, total });
  postGroups();
}

/** Push group names (with viewed/total counts) + the active filter to the Search panel dropdown. */
function postGroups() {
  if (!searchWebview || !diffTree || !diffTree.base) return;
  const cwd = getCwd();
  const map = getGroups(diffTree.context, diffTree.base);
  const viewed = getViewed(diffTree.context, diffTree.base);
  const names = groupNames(map);
  const groups = names.map((name) => {
    const files = Object.keys(map).filter((r) => map[r] === name);
    const vw = cwd ? files.filter((f) => isViewed(cwd, viewed, f)).length : 0;
    return { name, total: files.length, viewed: vw };
  });
  const active = (diffTree.groupFilter || []).filter((n) => names.includes(n));
  diffTree.groupFilter = active.length ? active : null;
  searchWebview.postMessage({ type: 'groups', groups, active });
}


/** Search the shown files (in JS — works for tracked + untracked) and fold results INTO the Review tree. */
function runScopedSearch(m) {
  const cwd = getCwd();
  if (!cwd || !diffTree) return;
  diffTree.searchMatches = null; // search the filter+scope set, not last run's matches
  const files = diffTree.visibleFiles(cwd);
  if (!files.length) {
    vscode.window.showInformationMessage('No files in scope to search.');
    return;
  }
  let re;
  try {
    re = buildSearchRegex(m);
  } catch (e) {
    vscode.window.showErrorMessage(`Invalid regex: ${e.message}`);
    return;
  }
  const matches = new Map();
  let n = 0;
  outer: for (const rel of files) {
    let content;
    try {
      content = fs.readFileSync(path.join(cwd, rel), 'utf8');
    } catch {
      continue; // unreadable
    }
    if (content.indexOf('\0') !== -1) continue; // binary
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const mt = lines[i].match(re); // re has no /g → first match, with .index for highlighting
      if (mt) {
        if (!matches.has(rel)) matches.set(rel, []);
        matches.get(rel).push({ line: i + 1, text: lines[i], col: mt.index, len: mt[0].length });
        if (++n >= 2000) break outer; // safety cap
      }
    }
  }
  diffTree.searchMatches = matches;
  diffTree.refresh();
  diffTree.updateProgress();
  postSearchCounts();
  todoTree?.refresh(); // re-slice TODOs to the search results too
  vscode.commands.executeCommand('vettyView.focus'); // stay in the Vetty panel
  if (!matches.size) vscode.window.setStatusBarMessage('No matches in shown files', 2500);
}

/** The "Search" section above the tree: scope chips, filename filter, and a scoped text search. */
class SearchView {
  resolveWebviewView(view) {
    view.webview.options = { enableScripts: true };
    searchWebview = view.webview;
    const nonce = crypto.randomBytes(16).toString('hex');
    view.webview.html = `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { padding: 8px; }
  .field { display: flex; flex-direction: column; gap: 3px; margin-bottom: 10px; }
  label { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); display: flex; justify-content: space-between; }
  .count { text-transform: none; letter-spacing: 0; opacity: .8; }
  .box { position: relative; }
  input[type="text"] {
    width: 100%; box-sizing: border-box; padding: 4px 6px; font-size: var(--vscode-font-size);
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; outline: none;
  }
  input[type="text"]:focus { border-color: var(--vscode-focusBorder); }
  input[type="text"]::placeholder { color: var(--vscode-input-placeholderForeground); }
  select {
    width: 100%; box-sizing: border-box; padding: 4px 6px; font-size: var(--vscode-font-size);
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; outline: none;
  }
  select:focus { border-color: var(--vscode-focusBorder); }
  .dropdown { position: relative; }
  .dd-btn {
    width: 100%; box-sizing: border-box; padding: 4px 6px; text-align: left; cursor: pointer;
    display: flex; justify-content: space-between; align-items: center; gap: 6px; font-size: var(--vscode-font-size);
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px;
  }
  .dd-btn:focus { outline: none; border-color: var(--vscode-focusBorder); }
  .dd-btn .chev { opacity: .7; }
  .gmenu { flex: 0 0 auto; width: 30px; justify-content: center; }
  .dd-panel {
    position: absolute; left: 0; right: 0; top: calc(100% + 2px); z-index: 5;
    background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-contrastBorder, #555));
    border-radius: 2px; max-height: 160px; overflow-y: auto; padding: 4px; box-shadow: 0 2px 8px rgba(0,0,0,.4);
  }
  .dd-panel[hidden] { display: none; }
  .dd-panel label {
    display: flex; align-items: center; gap: 6px; padding: 3px 4px; cursor: pointer; border-radius: 3px;
    text-transform: none; letter-spacing: 0; font-size: var(--vscode-font-size); color: var(--vscode-foreground);
  }
  .dd-panel label:hover { background: var(--vscode-list-hoverBackground); }
  .dd-panel input { flex: 0 0 auto; width: auto; margin: 0; accent-color: var(--vscode-inputOption-activeBackground); }
  .dd-panel label span { flex: 1; text-align: left; }
  .dd-panel label .gcount { flex: 0 0 auto; opacity: .6; font-size: 11px; }
  .dd-empty { color: var(--vscode-descriptionForeground); font-size: 11px; padding: 4px; }
  #filter { padding-right: 24px; }
  #search { padding-right: 100px; }
  .chips { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 10px; }
  .chip {
    padding: 2px 8px; border-radius: 10px; cursor: pointer; user-select: none; font-size: 11px;
    border: 1px solid var(--vscode-input-border, var(--vscode-contrastBorder, transparent));
    color: var(--vscode-foreground); opacity: .75;
  }
  .chip:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .chip.active {
    opacity: 1; background: var(--vscode-inputOption-activeBackground);
    border-color: var(--vscode-inputOption-activeBorder); color: var(--vscode-inputOption-activeForeground);
  }
  .clear {
    position: absolute; top: 50%; transform: translateY(-50%); width: 18px; height: 18px;
    display: none; align-items: center; justify-content: center; cursor: pointer; border-radius: 3px;
    opacity: .6; font-size: 13px;
  }
  .clear:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .clear.show { display: inline-flex; }
  #f-clear { right: 4px; }
  #s-clear { right: 80px; }
  .toggles { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); display: flex; gap: 2px; }
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
  <div class="chips" id="chips">
    <span class="chip" data-scope="all">All</span>
    <span class="chip" data-scope="unviewed">Unviewed</span>
    <span class="chip" data-scope="added">Added</span>
    <span class="chip" data-scope="modified">Modified</span>
  </div>
  <div class="field">
    <label for="filter"><span>Filter files by name</span><span class="count" id="count"></span></label>
    <div class="box">
      <input id="filter" type="text" placeholder="substring…" />
      <span class="clear" id="f-clear" title="Clear">✕</span>
    </div>
  </div>
  <div class="field">
    <label for="search">Search in shown files</label>
    <div class="box">
      <input id="search" type="text" placeholder="text, then Enter" />
      <span class="clear" id="s-clear" title="Clear">✕</span>
      <div class="toggles">
        <span class="toggle" id="t-case" title="Match Case">Aa</span>
        <span class="toggle" id="t-word" title="Match Whole Word">\\b</span>
        <span class="toggle" id="t-regex" title="Use Regular Expression">.*</span>
      </div>
    </div>
  </div>
  <div class="field" id="group-field">
    <label>Groups <span class="count">none = all</span></label>
    <div class="dropdown" style="display:flex; gap:4px;">
      <button type="button" class="dd-btn" id="group-btn" style="flex:1"><span id="group-label">All groups</span><span class="chev">▾</span></button>
      <button type="button" class="dd-btn gmenu" id="group-menu" title="Group actions">⋯</button>
      <div class="dd-panel" id="group-panel" hidden></div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const f = document.getElementById('filter'), s = document.getElementById('search');
    const fClear = document.getElementById('f-clear'), sClear = document.getElementById('s-clear');
    const count = document.getElementById('count');
    const groupBtn = document.getElementById('group-btn'), groupPanel = document.getElementById('group-panel'), groupLabel = document.getElementById('group-label');
    document.getElementById('group-menu').addEventListener('click', () => vscode.postMessage({ type: 'groupMenu' }));
    const esc = (n) => n.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const groupSummary = (a) => (!a.length ? 'All groups' : a.length === 1 ? a[0] : a.length + ' groups');
    const chips = [...document.querySelectorAll('.chip')];
    const toggles = { case: document.getElementById('t-case'), word: document.getElementById('t-word'), regex: document.getElementById('t-regex') };
    const state = Object.assign({ filter: '', search: '', scope: 'all', case: false, word: false, regex: false }, vscode.getState());
    f.value = state.filter; s.value = state.search;
    const save = () => vscode.setState(state);
    const syncUi = () => {
      for (const k of ['case', 'word', 'regex']) toggles[k].classList.toggle('active', !!state[k]);
      chips.forEach((c) => c.classList.toggle('active', c.dataset.scope === state.scope));
      fClear.classList.toggle('show', !!f.value);
      sClear.classList.toggle('show', !!s.value);
    };
    const doSearch = () => { if (s.value) vscode.postMessage({ type: 'search', value: s.value, caseSensitive: state.case, wholeWord: state.word, regex: state.regex }); };
    f.addEventListener('input', () => { state.filter = f.value; save(); syncUi(); vscode.postMessage({ type: 'filter', value: f.value }); });
    s.addEventListener('input', () => { state.search = s.value; save(); syncUi(); if (!s.value) vscode.postMessage({ type: 'searchClear' }); });
    s.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
    fClear.addEventListener('click', () => { f.value = ''; state.filter = ''; save(); syncUi(); vscode.postMessage({ type: 'filter', value: '' }); f.focus(); });
    sClear.addEventListener('click', () => { s.value = ''; state.search = ''; save(); syncUi(); vscode.postMessage({ type: 'searchClear' }); s.focus(); });
    for (const k of ['case', 'word', 'regex']) toggles[k].addEventListener('click', () => { state[k] = !state[k]; save(); syncUi(); doSearch(); });
    chips.forEach((c) => c.addEventListener('click', () => { state.scope = c.dataset.scope; save(); syncUi(); vscode.postMessage({ type: 'scope', value: state.scope }); }));
    groupBtn.addEventListener('click', () => { groupPanel.hidden = !groupPanel.hidden; });
    document.addEventListener('click', (ev) => { if (!ev.target.closest('.dropdown')) groupPanel.hidden = true; });
    groupPanel.addEventListener('change', () => {
      const vals = [...groupPanel.querySelectorAll('input:checked')].map((c) => c.value);
      groupLabel.textContent = groupSummary(vals);
      vscode.postMessage({ type: 'groupFilter', value: vals });
    });
    window.addEventListener('message', (e) => {
      if (e.data?.type === 'counts') count.textContent = e.data.total ? (e.data.shown === e.data.total ? e.data.total + ' files' : e.data.shown + ' of ' + e.data.total) : '';
      else if (e.data?.type === 'groups') {
        const groups = e.data.groups || [], active = e.data.active || [];
        groupPanel.innerHTML = groups.length
          ? groups.map((g) => '<label><input type="checkbox" value="' + esc(g.name) + '"' + (active.includes(g.name) ? ' checked' : '') + '><span>' + esc(g.name) + '</span><span class="gcount">' + g.viewed + '/' + g.total + '</span></label>').join('')
          : '<div class="dd-empty">No groups yet</div>';
        groupLabel.textContent = groupSummary(active);
      }
    });
    syncUi();
    vscode.postMessage({ type: 'scope', value: state.scope }); // re-apply persisted scope on (re)load
    if (state.filter) vscode.postMessage({ type: 'filter', value: state.filter });
  </script>
</body></html>`;
    postSearchCounts(); // seed counts + group dropdown now that the webview is live
    view.webview.onDidReceiveMessage(async (m) => {
      if (m.type === 'groupMenu') {
        const sel = diffTree?.groupFilter || [];
        const scope = sel.length ? (sel.length === 1 ? `"${sel[0]}"` : `${sel.length} selected groups`) : 'a group…';
        const a = await vscode.window.showQuickPick(
          [
            { label: `$(layers) Stage ${scope}`, cmd: 'vetty.stageGroup' },
            { label: `$(go-to-file) Open ${scope}`, cmd: 'vetty.openGroup' },
            { label: `$(eye-closed) Mark ${scope} viewed`, cmd: 'vetty.markGroupViewed' },
            { label: `$(close) Ungroup ${scope}`, cmd: 'vetty.ungroup' },
            { label: '$(clear-all) Ungroup all', cmd: 'vetty.clearGroups' },
          ],
          { placeHolder: sel.length ? `Acting on ${scope}` : 'Group actions (pick a group next)' }
        );
        if (a) vscode.commands.executeCommand(a.cmd);
        return;
      }
      if (m.type === 'filter') {
        diffTree.nameFilter = (m.value || '').trim().toLowerCase();
        refreshTree();
      } else if (m.type === 'scope') {
        diffTree.scope = m.value || 'all';
        refreshTree();
      } else if (m.type === 'groupFilter') {
        const sel = (Array.isArray(m.value) ? m.value : [m.value]).filter(Boolean);
        diffTree.groupFilter = sel.length ? sel : null;
        refreshTree();
      } else if (m.type === 'search' && m.value) {
        runScopedSearch(m); // in-panel results — no swap to VS Code's Search viewlet
      } else if (m.type === 'searchClear') {
        if (diffTree?.searchMatches) {
          diffTree.searchMatches = null;
          refreshTree();
        }
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
    this.stat = new Map(); // rel → { add, del } line counts from --numstat
    this.nameFilter = ''; // lowercased filename filter; '' = show all
    this.scope = 'all'; // all | unviewed | added | modified — scope chips in the Search panel
    this.groupFilter = null; // null/[] = all groups; else array of group names to show (multi-select)
    this.searchMatches = null; // null = no text search; else Map rel → [{line, text}] (filters the tree)
    this.realChanged = new Set(); // files with non-whitespace changes (git diff -w)
    this.hideWhitespace = !!context.workspaceState.get('vetty.hideWhitespace');
    this.nested = !!context.workspaceState.get('vetty.nested'); // folder tree vs flat list
    this.pageLimits = {}; // per-group shown-row cap for the flat view (huge-PR paging)
    this.baseRef = this.base; // merge-base of base+HEAD (resolved in load); what we actually diff against
    this.itemByRel = new Map(); // rel → last-rendered file TreeItem, for reveal()
  }

  /** True if `rel` passes the active name filter + scope chip (+ text-search match set). */
  _matches(cwd, viewed, rel) {
    if (this.searchMatches && !this.searchMatches.has(rel)) return false;
    if (this.groupFilter && this.groupFilter.length && !this.groupFilter.includes(getGroups(this.context, this.base)[rel]))
      return false;
    // Whitespace-only modified files: present in the full diff but absent from `git diff -w`.
    if (this.hideWhitespace && this.status.get(rel) !== 'U' && !this.realChanged.has(rel)) return false;
    if (this.nameFilter && !rel.toLowerCase().includes(this.nameFilter)) return false;
    switch (this.scope) {
      case 'unviewed':
        return !isViewed(cwd, viewed, rel);
      case 'added':
        return ['A', 'U'].includes(this.status.get(rel));
      case 'modified':
        return ['M', 'T', 'R', 'C'].includes(this.status.get(rel));
      default:
        return true;
    }
  }

  /** Files currently shown (name filter + scope), excluding untracked-from-review. For text search scoping. */
  visibleFiles(cwd) {
    const viewed = getViewed(this.context, this.base);
    const ignored = getIgnored(this.context, this.base);
    return this.files.filter((f) => !ignored.has(f) && this._matches(cwd, viewed, f));
  }

  refresh() {
    this._emitter.fire();
  }

  async load() {
    const cwd = getCwd();
    this.base = lastBranch(this.context);
    this.baseRef = cwd && this.base ? await mergeBaseRef(cwd, this.base) : this.base;
    // In "since last commit" mode, list working-tree-vs-HEAD (like Source Control); else the branch's changes.
    this.listRef = diffMode(this.context) === 'commit' ? 'HEAD' : this.baseRef;
    const files = [];
    const added = new Set();
    const status = new Map();
    const stat = new Map();
    const realChanged = new Set();
    if (cwd && this.base) {
      try {
        const out = await git(cwd, ['diff', '--name-status', '--diff-filter=d', this.listRef]);
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
        // +/- line counts (binary files report "-\t-"); skipped silently.
        const ns = await git(cwd, ['diff', '--numstat', '--diff-filter=d', this.listRef]);
        parseNumstat(ns).forEach((v, k) => stat.set(k, v));
        // Files with real (non-whitespace) changes — anything else is formatting-only.
        for (const r of (await git(cwd, ['diff', '--name-only', '-w', '--diff-filter=d', this.listRef])).split('\n')) {
          const rel = r.trim();
          if (rel) realChanged.add(rel);
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
    this.stat = stat;
    this.realChanged = realChanged;
    // Drop group assignments for files no longer changed (committed/reverted). Skip in commit mode,
    // where `files` is only the uncommitted subset — pruning then would wrongly forget branch files.
    if (cwd && this.base && diffMode(this.context) !== 'commit') {
      const groups = getGroups(this.context, this.base);
      const fileSet = new Set(files);
      let changed = false;
      for (const r of Object.keys(groups)) if (!fileSet.has(r)) (delete groups[r], (changed = true));
      if (changed) await setGroups(this.context, this.base, groups);
    }
    this.refresh();
    this.updateProgress();
    postSearchCounts();
    fileDecorations.refresh();
    todoTree?.load();
  }

  /** Show "N/total viewed · <mode>" by the title + a comment-count badge on the view. */
  updateProgress() {
    if (!diffTreeView) return;
    vscode.commands.executeCommand('setContext', 'vetty.hasBase', !!this.base); // drives viewsWelcome
    const cwd = getCwd();
    const mode = DIFF_MODE_SHORT[diffMode(this.context)];
    if (!cwd || !this.base) {
      diffTreeView.description = mode;
      diffTreeView.badge = undefined;
      return;
    }
    const viewed = getViewed(this.context, this.base);
    const ignored = getIgnored(this.context, this.base);
    const active = this.files.filter((f) => !ignored.has(f));
    const vw = active.filter((f) => isViewed(cwd, viewed, f)).length;
    const progress = !active.length ? '' : vw === active.length ? `✓ all ${active.length} reviewed` : `${vw}/${active.length} viewed`;
    diffTreeView.description = [progress, mode].filter(Boolean).join('  ·  ');
    const cc = commentCount(this.context);
    diffTreeView.badge = cc ? { value: cc, tooltip: `${cc} review comment(s)` } : undefined;
  }

  getTreeItem(el) {
    return el;
  }

  getParent(el) {
    return el ? el.parent : undefined;
  }

  /** Reveal + select a file row (used by auto-advance so the list highlights the open file). */
  revealFile(rel) {
    const it = this.itemByRel.get(rel);
    if (it && diffTreeView && diffTreeView.visible) diffTreeView.reveal(it, { select: true, focus: false }).then(undefined, () => {});
  }

  // Stamp each child with its parent (for getParent/reveal) and index file rows by path.
  getChildren(el) {
    if (!el) this.itemByRel = new Map();
    const children = this._children(el) || [];
    for (const c of children) {
      c.parent = el || undefined;
      if (c.rel) this.itemByRel.set(c.rel, c);
    }
    return children;
  }

  _children(el) {
    const cwd = getCwd();
    if (!cwd) return [];

    // A file row in search mode expands to its matching lines.
    if (el && el.matches) {
      return el.matches.map((mt) => {
        const it = new vscode.TreeItem(`${mt.line}: ${mt.text.trim().slice(0, 120)}`);
        it.iconPath = new vscode.ThemeIcon('search');
        it.tooltip = `${el.rel}:${mt.line}`;
        // Select the matched text so it's highlighted on open.
        it.command = { command: 'vetty.openMatch', title: 'Open', arguments: [el.rel, mt.line, mt.col || 0, mt.len || 0] };
        return it;
      });
    }

    if (!this.base) return []; // viewsWelcome shows the "pick a branch" message

    if (!el) {
      if (!this.files.length) return []; // viewsWelcome shows the "no changes" message
      const viewed = getViewed(this.context, this.base);
      const ignored = getIgnored(this.context, this.base);
      const shown = this.files.filter((f) => this._matches(cwd, viewed, f));
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

    // Group or folder node: flat list (paged), or one level of the folder tree when nested.
    const files = el.files || [];
    if (this.nested) return this._folderChildren(cwd, files, el.prefix || '', !!el.ignored);

    // Flat mode can be thousands of rows; page it so a huge PR stays responsive.
    const key = el.contextValue || 'group';
    const limit = this.pageLimits[key] || PAGE_SIZE;
    const rows = files.slice(0, limit).map((f) => this._file(cwd, f, !!el.ignored));
    if (files.length > limit) {
      const more = new vscode.TreeItem(`Show ${Math.min(PAGE_SIZE, files.length - limit)} more… (${files.length - limit} hidden)`);
      more.iconPath = new vscode.ThemeIcon('ellipsis');
      more.command = { command: 'vetty.showMore', title: 'Show more', arguments: [key] };
      rows.push(more);
    }
    return rows;
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
    const hits = this.searchMatches && this.searchMatches.get(rel);
    const it = new vscode.TreeItem(
      path.basename(rel), // filename first, like Source Control
      hits ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
    );
    const s = this.stat.get(rel);
    const counts = s ? `+${s.add} −${s.del}` : ''; // triage signal: how big is this change
    const dirPart = this.nested || dir === '.' ? '' : dir; // dir shown by hierarchy when nested
    const matchPart = hits ? `${hits.length} match${hits.length === 1 ? '' : 'es'}` : '';
    const group = getGroups(this.context, this.base)[rel];
    const groupPart = group ? `[${group}]` : '';
    it.description = [groupPart, matchPart, counts, dirPart].filter(Boolean).join('  ·  ');
    if (hits) it.matches = hits; // makes the row expandable into its matching lines
    const viewed = isViewed(cwd, getViewed(this.context, this.base), rel);
    it.rel = rel;
    it.id = `file:${this.base}:${rel}`; // stable id so reveal() can match across refreshes
    it.resourceUri = vscode.Uri.file(path.join(cwd, rel));
    it.contextValue = isIgnored ? 'file-ignored' : viewed ? 'file-viewed' : 'file-unviewed';
    it.tooltip = `${rel} — ${isIgnored ? 'untracked' : viewed ? 'viewed' : 'unviewed'}`;
    // During a search, clicking the row toggles its matches (no command) instead of opening.
    if (!hits) {
      // Added file → open whole file, UNLESS it has a since-review snapshot to diff against.
      const cmd = this.added.has(rel) && !hasSinceReviewDiff(this.context, cwd, this.base, rel)
        ? 'vetty.treeOpenFile'
        : 'vetty.treeOpenDiff';
      it.command = { command: cmd, title: 'Open', arguments: [it] };
    }
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
    const ref = diffTree?.listRef; // honor the active diff mode (branch merge-base vs HEAD)
    this.items = cwd && ref ? await findTodos(cwd, ref) : [];
    this.refresh();
  }
  getTreeItem(el) {
    return el;
  }
  getChildren(el) {
    if (el) return [];
    const cwd = getCwd();
    // Slice TODOs by the Review panel's active filter (group / scope / name / search) for a focused view.
    const visible = cwd && diffTree ? new Set(diffTree.visibleFiles(cwd)) : null;
    const items = visible ? this.items.filter((t) => visible.has(t.rel)) : this.items;
    if (!items.length) {
      const it = new vscode.TreeItem('No TODOs');
      it.iconPath = new vscode.ThemeIcon('check');
      return [it];
    }
    return items.map((t) => {
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

/** Open a file and select (highlight) the matched text at a search hit. */
async function openMatch(rel, line, col, len) {
  const cwd = getCwd();
  if (!cwd) return;
  const uri = vscode.Uri.file(path.join(cwd, rel));
  const sel = new vscode.Range(line - 1, col, line - 1, col + len);
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

// Diff left-side mode: 'branch' (whole branch vs merge-base), 'review' (since last viewed), 'commit' (since last commit / HEAD).
const DIFF_MODES = ['branch', 'review', 'commit'];
const DIFF_MODE_LABEL = { branch: 'Whole branch', review: 'Since last review', commit: 'Since last commit' };
const DIFF_MODE_SHORT = { branch: 'whole branch', review: 'since review', commit: 'since commit' };
function diffMode(context) {
  const m = context.workspaceState.get('vetty.diffMode');
  return DIFF_MODES.includes(m) ? m : 'review'; // default: since last review
}

/** True when `rel` has a usable since-last-review snapshot (review mode + blob present + now unviewed). */
function hasSinceReviewDiff(context, cwd, base, rel) {
  if (!base || diffMode(context) !== 'review') return false;
  const viewed = getViewed(context, base);
  return !!reviewedBlob(viewed, rel) && !isViewed(cwd, viewed, rel);
}

/** Open one file's diff with the left side chosen by the active diff mode. */
function openOneDiff(context, cwd, base, rel, opts) {
  const fileUri = vscode.Uri.file(path.join(cwd, rel));
  const mode = diffMode(context);
  if (mode === 'review' && hasSinceReviewDiff(context, cwd, base, rel)) {
    const blob = reviewedBlob(getViewed(context, base), rel);
    return vscode.commands.executeCommand('vscode.diff', blobUriFor(fileUri, blob), fileUri, `${rel} (since last review)`, opts);
  }
  if (mode === 'commit') {
    // Working tree vs HEAD = uncommitted changes only. New/untracked files → empty left side.
    return vscode.commands.executeCommand('vscode.diff', baseUriFor(fileUri, 'HEAD'), fileUri, `${rel} (since last commit)`, opts);
  }
  const ref = (diffTree && diffTree.baseRef) || base; // whole branch: diff against the merge-base
  return vscode.commands.executeCommand('vscode.diff', baseUriFor(fileUri, ref), fileUri, `${rel} (${base} ↔ working)`, opts);
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
  const viewed = getViewed(context, base);
  const order = diffTree.visibleFiles(cwd); // stay within the filtered slice (group/scope/search/name)
  const start = order.indexOf(justViewed);
  const next = order.slice(start + 1).concat(order.slice(0, start + 1)).find((f) => !isViewed(cwd, viewed, f));
  if (!next) return; // all viewed
  await openReviewFile(context, cwd, base, next);
  diffTree.revealFile(next); // highlight it in the list
}

/** Open a changed file the right way: whole file for new files, else its diff. */
async function openReviewFile(context, cwd, base, rel, opts = { preview: true }) {
  if (diffTree.added.has(rel) && !hasSinceReviewDiff(context, cwd, base, rel)) {
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(cwd, rel)), opts);
  } else {
    await openOneDiff(context, cwd, base, rel, opts);
  }
}

/** j/k navigation: open the next/prev unviewed file relative to the active one. */
async function navigateUnviewed(context, dir) {
  const cwd = getCwd();
  const base = diffTree?.base;
  if (!cwd || !base) return;
  const viewed = getViewed(context, base);
  const unviewed = diffTree.visibleFiles(cwd).filter((f) => !isViewed(cwd, viewed, f)); // within the filtered slice
  if (!unviewed.length) {
    vscode.window.setStatusBarMessage('No unviewed files', 2000);
    return;
  }
  const cur = activeRelPath(cwd);
  const idx = cur ? unviewed.indexOf(cur) : -1;
  const next =
    idx >= 0 ? unviewed[(idx + dir + unviewed.length) % unviewed.length] : unviewed[dir > 0 ? 0 : unviewed.length - 1];
  await openReviewFile(context, cwd, base, next);
  diffTree.revealFile(next); // highlight it in the list
}

/** Bridge review → SCM: git-add every file you've marked viewed, then commit in Source Control. */
async function stageViewed(context) {
  const cwd = getCwd();
  const base = diffTree?.base;
  if (!cwd || !base) return;
  const viewed = getViewed(context, base);
  const files = diffTree.visibleFiles(cwd).filter((f) => isViewed(cwd, viewed, f)); // only the filtered slice
  if (!files.length) {
    vscode.window.showInformationMessage('No viewed files to stage.');
    return;
  }
  try {
    await git(cwd, ['add', '--', ...files]);
  } catch (e) {
    vscode.window.showErrorMessage(`git add failed: ${e.message}`);
    return;
  }
  vscode.window.showInformationMessage(`Staged ${files.length} viewed file(s). Commit them in Source Control.`);
}

/** git-add the selected file(s) — per-row / multi-select staging. */
async function stageFiles(context, item, sel) {
  const cwd = getCwd();
  const rels = selectedRels(item, sel);
  if (!cwd || !rels.length) return;
  try {
    await git(cwd, ['add', '--', ...rels]);
  } catch (e) {
    vscode.window.showErrorMessage(`git add failed: ${e.message}`);
    return;
  }
  vscode.window.setStatusBarMessage(`Staged ${rels.length} file(s). Commit in Source Control.`, 2500);
}

/** Assign the selected file(s) to a group (pick an existing one or name a new one). */
async function addToGroup(context, item, sel) {
  const base = diffTree?.base;
  const rels = selectedRels(item, sel);
  if (!base || !rels.length) return;
  const groups = getGroups(context, base);
  const NEW = '$(add) New group…';
  const pick = await vscode.window.showQuickPick([NEW, ...groupNames(groups)], { placeHolder: 'Add to group' });
  if (!pick) return;
  let name = pick;
  if (pick === NEW) {
    name = (await vscode.window.showInputBox({ prompt: 'Group name' }))?.trim();
    if (!name) return;
  }
  for (const r of rels) groups[r] = name;
  await setGroups(context, base, groups);
  refreshTree();
}

/** Remove the selected file(s) from whatever group they're in. */
async function removeFromGroup(context, item, sel) {
  const base = diffTree?.base;
  const rels = selectedRels(item, sel);
  if (!base || !rels.length) return;
  const groups = getGroups(context, base);
  for (const r of rels) delete groups[r];
  await setGroups(context, base, groups);
  refreshTree();
}

/** Group names to act on: the checked groups in the dropdown, else prompt for one. null = cancel/none. */
async function targetGroupNames(context, placeHolder) {
  const base = diffTree?.base;
  const names = groupNames(getGroups(context, base));
  if (!names.length) {
    vscode.window.showInformationMessage('No groups yet — right-click files → Add to Group.');
    return null;
  }
  if (diffTree.groupFilter && diffTree.groupFilter.length) return diffTree.groupFilter; // act on checked groups
  const one = await vscode.window.showQuickPick(names, { placeHolder });
  return one ? [one] : null;
}
const filesInGroups = (map, names) => Object.keys(map).filter((r) => names.includes(map[r]));
const groupsTitle = (names) => (names.length === 1 ? `"${names[0]}"` : `${names.length} groups`);

/** Stage every file in the target group(s) (then commit it in Source Control). */
async function stageGroup(context) {
  const cwd = getCwd();
  const base = diffTree?.base;
  if (!cwd || !base) return;
  const names = await targetGroupNames(context, 'Stage which group?');
  if (!names) return;
  const files = filesInGroups(getGroups(context, base), names);
  if (!files.length) return;
  const viewed = getViewed(context, base);
  const unviewed = files.filter((f) => !isViewed(cwd, viewed, f)).length;
  if (unviewed) {
    const ok = await vscode.window.showWarningMessage(
      `Stage ${groupsTitle(names)}? ${unviewed} of ${files.length} file(s) are still unviewed.`,
      { modal: true },
      'Stage anyway'
    );
    if (ok !== 'Stage anyway') return;
  }
  try {
    await git(cwd, ['add', '--', ...files]);
  } catch (e) {
    vscode.window.showErrorMessage(`git add failed: ${e.message}`);
    return;
  }
  vscode.window.setStatusBarMessage(`Staged ${groupsTitle(names)} (${files.length} file(s)). Commit in Source Control.`, 3000);
}

/** Mark every file in the target group(s) viewed. */
async function markGroupViewed(context) {
  const cwd = getCwd();
  const base = diffTree?.base;
  if (!cwd || !base) return;
  const names = await targetGroupNames(context, 'Mark which group viewed?');
  if (!names) return;
  const viewed = getViewed(context, base);
  for (const r of filesInGroups(getGroups(context, base), names)) viewed[r] = await viewedEntry(cwd, r);
  await setViewed(context, base, viewed);
  updateViewedContext(context);
  refreshTree();
}

/** Open every file in the target group(s) (honors the active diff mode). */
async function openGroup(context) {
  const cwd = getCwd();
  const base = diffTree?.base;
  if (!cwd || !base) return;
  const names = await targetGroupNames(context, 'Open which group?');
  if (!names) return;
  const files = filesInGroups(getGroups(context, base), names);
  if (!files.length) return;
  if (files.length > MAX_OPEN_WITHOUT_CONFIRM) {
    const ok = await vscode.window.showWarningMessage(`Open ${files.length} editors?`, { modal: true }, 'Open');
    if (ok !== 'Open') return;
  }
  for (const f of files) await openReviewFile(context, cwd, base, f, { preview: false, preserveFocus: true });
}

/** Ungroup the target group(s) — remove their files (files untouched); the group(s) disappear. */
async function ungroup(context) {
  const base = diffTree?.base;
  if (!base) return;
  const names = await targetGroupNames(context, 'Ungroup which group?');
  if (!names) return;
  const groups = getGroups(context, base);
  for (const r of Object.keys(groups)) if (names.includes(groups[r])) delete groups[r];
  if (diffTree.groupFilter) diffTree.groupFilter = diffTree.groupFilter.filter((n) => !names.includes(n));
  await setGroups(context, base, groups);
  refreshTree();
}

async function clearGroups(context) {
  const base = diffTree?.base;
  if (!base) return;
  await setGroups(context, base, {});
  diffTree.groupFilter = null;
  refreshTree();
}

/** Flip the PR-mode setting (the config listener handles cleanup if a review is active). */
async function togglePrMode() {
  const cfg = vscode.workspace.getConfiguration('vetty');
  const next = !cfg.get('pullRequests.enabled', true);
  await cfg.update('pullRequests.enabled', next, vscode.ConfigurationTarget.Global);
  vscode.window.setStatusBarMessage(`PR mode ${next ? 'enabled' : 'disabled'}`, 2500);
}

function showMore(groupKey) {
  if (!diffTree) return;
  diffTree.pageLimits[groupKey] = (diffTree.pageLimits[groupKey] || PAGE_SIZE) + PAGE_SIZE;
  diffTree.refresh();
}

async function toggleNesting(context) {
  if (!diffTree) return;
  diffTree.nested = !diffTree.nested;
  await context.workspaceState.update('vetty.nested', diffTree.nested);
  await vscode.commands.executeCommand('setContext', 'vetty.nested', diffTree.nested);
  refreshTree();
}

async function toggleWhitespace(context) {
  if (!diffTree) return;
  diffTree.hideWhitespace = !diffTree.hideWhitespace;
  await context.workspaceState.update('vetty.hideWhitespace', diffTree.hideWhitespace);
  await vscode.commands.executeCommand('setContext', 'vetty.hideWhitespace', diffTree.hideWhitespace);
  refreshTree();
}

/** Reflect the active PR (if any) in the view title. */
function updatePrTitle(context) {
  if (!diffTreeView) return;
  const st = context.workspaceState.get(REVIEW_KEY);
  diffTreeView.title = st?.number ? `Review · PR #${st.number}` : 'Review';
}

/** Pick a teammate's open PR, check it out, and diff it against its (remote) base branch. */
async function reviewPr(context) {
  const cwd = getCwd();
  if (!cwd) return;
  if (!prEnabled()) {
    vscode.window.showInformationMessage('PR review is disabled. Enable "Vetty › Pull Requests: Enabled" in settings.');
    return;
  }
  if (!hasGh) {
    vscode.window.showErrorMessage('PR review needs the GitHub CLI. Install `gh` and run `gh auth login`.');
    return;
  }
  if ((await git(cwd, ['status', '--porcelain'])).trim()) {
    vscode.window.showErrorMessage('Commit or stash your working changes before reviewing a PR.');
    return;
  }
  // Feed the picker a promise so it opens instantly with a spinner instead of blocking on the network.
  const itemsPromise = gh(cwd, ['pr', 'list', '--json', 'number,title,headRefName,baseRefName', '--limit', '50'])
    .then((out) =>
      JSON.parse(out).map((p) => ({
        label: `#${p.number} ${p.title}`,
        description: `${p.headRefName} → ${p.baseRefName}`,
        pr: p,
      }))
    )
    .catch((e) => {
      vscode.window.showErrorMessage(`Could not list PRs: ${e.message}`);
      return [];
    });
  const pick = await vscode.window.showQuickPick(itemsPromise, { placeHolder: 'Loading open PRs…' });
  if (!pick) return;
  const pr = pick.pr;

  let original, prBranch, repo, headSha;
  try {
    original = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    await gh(cwd, ['pr', 'checkout', String(pr.number)]);
    prBranch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    repo = JSON.parse(await gh(cwd, ['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner;
    headSha = JSON.parse(await gh(cwd, ['pr', 'view', String(pr.number), '--json', 'headRefOid'])).headRefOid;
    await git(cwd, ['fetch', 'origin', pr.baseRefName]); // ensure the base ref is current
  } catch (e) {
    vscode.window.showErrorMessage(`PR checkout failed: ${e.message}`);
    return;
  }

  await context.workspaceState.update(REVIEW_KEY, { original, prBranch, number: pr.number, repo, headSha, baseRef: pr.baseRefName });
  await context.workspaceState.update(LAST_BRANCH_KEY, `origin/${pr.baseRefName}`);
  await vscode.commands.executeCommand('setContext', 'vetty.reviewing', true);
  updateViewedContext(context);
  updatePrTitle(context);
  await fetchPrComments(cwd, repo, pr.number); // pull existing review comments into the gutter
  for (const ed of vscode.window.visibleTextEditors) addPrThreads(ed.document);
  await diffTree.load();
  vscode.window.showInformationMessage(`Reviewing PR #${pr.number} vs origin/${pr.baseRefName}.`);
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
  await vscode.commands.executeCommand('setContext', 'vetty.reviewing', false);
  clearPrThreads();
  updatePrTitle(context);
  await diffTree.load();
  vscode.window.showInformationMessage(`Removed "${st.prBranch}", back on "${st.original}".`);
}

/** Post all local comments to the active PR as one GitHub review. */
async function submitReview(context) {
  const cwd = getCwd();
  const st = context.workspaceState.get(REVIEW_KEY);
  if (!cwd || !st?.number) {
    vscode.window.showInformationMessage('Start a PR review first (Review Pull Request).');
    return;
  }
  const stored = getComments(context); // keyed by current base = origin/<baseRef>
  const comments = [];
  for (const rel of Object.keys(stored)) {
    for (const n of stored[rel] || []) {
      const body = n.comments.join('\n\n').trim();
      if (!body) continue;
      const startLine = n.range[0] + 1;
      const endLine = n.range[3] === 0 && n.range[2] > n.range[0] ? n.range[2] : n.range[2] + 1;
      const c = { path: rel, line: endLine, side: 'RIGHT', body };
      if (endLine > startLine) {
        c.start_line = startLine;
        c.start_side = 'RIGHT';
      }
      comments.push(c);
    }
  }
  // Allow submitting an empty-comment review (pure approve / request-changes) too.
  const eventPick = await vscode.window.showQuickPick(
    [
      { label: '$(comment) Comment', detail: `Post ${comments.length} comment(s), no verdict`, event: 'COMMENT' },
      { label: '$(check) Approve', detail: 'Approve the PR' + (comments.length ? ` with ${comments.length} comment(s)` : ''), event: 'APPROVE' },
      { label: '$(request-changes) Request changes', detail: 'Block the PR' + (comments.length ? ` with ${comments.length} comment(s)` : ''), event: 'REQUEST_CHANGES' },
    ],
    { placeHolder: `Submit review to PR #${st.number}` }
  );
  if (!eventPick) return;

  let body = '';
  if (eventPick.event !== 'COMMENT' || !comments.length) {
    body = (await vscode.window.showInputBox({ prompt: 'Review summary (optional)', placeHolder: 'Overall comment…' })) ?? '';
  }
  const payload = { commit_id: st.headSha, event: eventPick.event, body, comments };
  const tmp = path.join(os.tmpdir(), `vetty-review-${st.number}.json`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload));
    await gh(cwd, ['api', '--method', 'POST', `repos/${st.repo}/pulls/${st.number}/reviews`, '--input', tmp]);
    const verb = { COMMENT: 'Commented on', APPROVE: 'Approved', REQUEST_CHANGES: 'Requested changes on' }[eventPick.event];
    vscode.window.showInformationMessage(`${verb} PR #${st.number}${comments.length ? ` (${comments.length} comment(s))` : ''}.`);
  } catch (e) {
    // Most common cause: a comment sits on a line not part of the PR diff (GitHub 422).
    vscode.window.showErrorMessage(`Submit failed: ${e.message}. Comments must be on lines changed in the PR.`);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

/** Fetch all remotes (so origin/* bases are current), then reload. */
async function fetchAndRefresh(context) {
  const cwd = getCwd();
  if (!cwd) return;
  await vscode.window.withProgress(
    { location: { viewId: 'vettyView' }, title: 'Fetching…' },
    async () => {
      try {
        await git(cwd, ['fetch', '--all', '--prune']);
      } catch (e) {
        vscode.window.showErrorMessage(`git fetch failed: ${e.message}`);
        return;
      }
      await ensureDefaultBase(context);
      await diffTree.load();
    }
  );
}

async function pickDiffMode(context) {
  const cur = diffMode(context);
  const pick = await vscode.window.showQuickPick(
    DIFF_MODES.map((m) => ({
      label: (m === cur ? '$(check) ' : '') + DIFF_MODE_LABEL[m],
      detail: {
        branch: 'Every file changed on the branch — like a PR\'s "Files changed"',
        review: 'Every branch file, each showing changes since you last viewed it — like GitHub\'s "viewed" files',
        commit: 'Only uncommitted changes vs HEAD — like Source Control',
      }[m],
      mode: m,
    })),
    { placeHolder: 'Diff mode — what each file is compared against' }
  );
  if (!pick) return;
  await context.workspaceState.update('vetty.diffMode', pick.mode);
  await vscode.commands.executeCommand('setContext', 'vetty.diffMode', pick.mode);
  await diffTree.load(); // the listed file set differs (branch changes vs uncommitted-vs-HEAD)
  vscode.window.setStatusBarMessage(`Diff mode: ${DIFF_MODE_LABEL[pick.mode]}`, 2500);
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
