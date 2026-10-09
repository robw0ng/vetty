// Core plumbing: shared refs, git/gh process helpers, persisted review state (viewed/ignored/groups),
// base-branch memory + inference, and the diff-content providers. Every other module requires this
// one; core itself only lazy-requires siblings inside functions (no top-level cycles).
const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { promisify } = require('util');
const {
  parseAheadBehind, parseTodoHunks, eolNormalize, parseClaudeReview, removeClaudeComments,
  parseBranchTips, parseFirstParents, branchTree, parseWorktrees,
} = require('../lib');

const execFileAsync = promisify(cp.execFile);

const LAST_BRANCH_KEY = 'vetty.lastBranch';
const MAX_OPEN_WITHOUT_CONFIRM = 30;
const REVIEW_KEY = 'vetty.review'; // { original, prBranch, number, repo, headSha } while reviewing a PR

// Mutable singletons wired in activate(). Always dereference through `app` (never destructure) —
// the values are assigned after require time.
const app = {
  context: null, // vscode.ExtensionContext
  diffTree: null,
  diffTreeView: null,
  todoTree: null,
  todoTreeView: null,
  bumpReload: () => {}, // debounced full reload; set in activate
};

function refreshTree() {
  app.diffTree?.refresh();
  app.diffTree?.updateProgress();
  require('./search').postSearchCounts(); // lazy: search requires core at top level
  app.todoTree?.refresh(); // re-slice TODOs to the active filter
  app.commentsTree?.refresh();
}

// Git paths are repo-root-relative, so everything must join against the toplevel — which can sit
// ABOVE the opened folder (workspace = a subdir of the repo). Resolved in activate and again when
// the user picks a different workspace folder (multi-root).
let repoRoot = null;
const FOLDER_KEY = 'vetty.folder'; // fsPath of the workspace folder Vetty works on (multi-root)
function workspaceFolderPath() {
  const folders = vscode.workspace.workspaceFolders || [];
  const saved = app.context?.workspaceState.get(FOLDER_KEY);
  return folders.find((f) => f.uri.fsPath === saved)?.uri.fsPath ?? folders[0]?.uri.fsPath ?? null;
}
function getCwd() {
  return repoRoot ?? workspaceFolderPath();
}
let gitDir = null; // absolute .git dir — a FILE-based .git (worktrees, submodules) points elsewhere
async function resolveRepoRoot() {
  repoRoot = null;
  gitDir = null;
  const ws = workspaceFolderPath();
  if (!ws) return;
  try {
    repoRoot = path.normalize((await git(ws, ['rev-parse', '--show-toplevel'])).trim()) || null;
    gitDir = path.normalize((await git(ws, ['rev-parse', '--absolute-git-dir'])).trim()) || null;
  } catch {
    // not a git repo — getCwd() falls back to the folder itself
  }
}

// `git diff` refreshes the index's stat cache and WRITES .git/index — including the six reads
// load() runs. (--no-optional-locks suppresses that for `status`, but NOT for `diff`; verified.)
// The watcher below would fire on vetty's own reads and schedule a reload, which runs the reads
// again: a permanent ~400ms refresh loop. So stamp the index's mtime after every git call and
// ignore a watcher event that still matches it — that write was ours. If an external write races
// in, the stamp won't match and the reload happens as normal; the cost of losing is one extra
// reload, never a missed change.
let selfIndexMtime = 0;
const INDEX_WRITES = new Set(['add', 'restore', 'reset', 'rm', 'mv', 'commit', 'checkout', 'switch', 'stash', 'apply', 'merge', 'rebase', 'cherry-pick']);
function indexPath() {
  return gitDir ? path.join(gitDir, 'index') : null;
}
function stampIndexMtime() {
  try {
    const p = indexPath();
    selfIndexMtime = p ? fs.statSync(p).mtimeMs : 0;
  } catch {
    selfIndexMtime = 0; // no index yet (fresh repo) — nothing to suppress
  }
}
function isSelfIndexWrite(uri) {
  const p = indexPath();
  if (!p || !selfIndexMtime) return false;
  // Matched by name, NOT by comparing the two absolute paths: the watcher's path form need not
  // equal what `git rev-parse` returned (8.3 short names like ROBERT~1, drive-letter casing, UNC),
  // and a mismatch would silently disable the suppression — the loop back, with no symptom to
  // point at it. The watcher glob already scopes events to this repo's .git.
  const changed = (uri?.fsPath ?? String(uri ?? '')).replace(/\\/g, '/').toLowerCase();
  if (!changed.endsWith('/.git/index')) return false; // HEAD/ORIG_HEAD are never ours to suppress
  try {
    return fs.statSync(p).mtimeMs === selfIndexMtime;
  } catch {
    return false;
  }
}

// The .git watcher is per-repo, so it's rebuilt when the active folder changes.
let gitWatcher = null;
function watchGitDir(context, bump) {
  gitWatcher?.dispose();
  gitWatcher = null;
  const cwd = getCwd();
  if (!cwd) return;
  gitWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(cwd, '.git/{HEAD,ORIG_HEAD,index}'));
  const onGitFile = (uri) => {
    if (isSelfIndexWrite(uri)) return dbg(`skip self index write: ${uri?.fsPath ?? uri}`);
    bump(uri);
  };
  gitWatcher.onDidChange(onGitFile);
  gitWatcher.onDidCreate(onGitFile);
  gitWatcher.onDidDelete(onGitFile);
  context.subscriptions.push(gitWatcher);
  // Claude's review file lives in the git dir (worktree-aware), outside the working-tree watcher.
  claudeWatcher?.dispose();
  claudeWatcher = null;
  if (!gitDir) return;
  claudeWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(gitDir, 'vetty/claude-review.json'));
  claudeWatcher.onDidChange(bump);
  claudeWatcher.onDidCreate(bump);
  claudeWatcher.onDidDelete(bump);
  context.subscriptions.push(claudeWatcher);
}
let claudeWatcher = null;

// Claude review file: any Claude session (vetty-review skill) writes an intuitive review order and
// short context notes here; both editors read it. One file per worktree, scoped to one branch.
function claudeReviewPath() {
  return gitDir ? path.join(gitDir, 'vetty', 'claude-review.json') : null;
}
let claudeCache = { key: null, value: null };
/** Parsed review for the current branch, or null. Same object until the file or branch changes, so
 *  callers can compare by identity to skip rebuilds. */
function claudeReview() {
  const p = claudeReviewPath();
  let key = null;
  try {
    const st = p && fs.statSync(p);
    if (st) key = `${st.mtimeMs}:${st.size}:${activeBranch}`;
  } catch {
    // no file yet
  }
  if (key !== claudeCache.key) {
    let value = null;
    try {
      value = key ? parseClaudeReview(fs.readFileSync(p, 'utf8'), activeBranch) : null;
    } catch {
      // unreadable mid-write — the watcher fires again when the write completes
    }
    claudeCache = { key, value };
  }
  return claudeCache.value;
}
/** Stamp of the review file on disk (mtime:size), branch-independent — '' when absent. Lets the tree
 *  notice a (re)annotation even when it's for another branch. */
function claudeReviewStamp() {
  try {
    const st = fs.statSync(claudeReviewPath());
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '';
  }
}
/** Branch named inside the review file, whatever branch we're on (for the "annotated for X" message). */
function claudeReviewFileBranch() {
  try {
    return String(JSON.parse(fs.readFileSync(claudeReviewPath(), 'utf8')).branch || '');
  } catch {
    return '';
  }
}
/** Delete Claude notes (parsed entries) from the file — shared, so they go for both editors. */
function deleteClaudeComments(list) {
  const p = claudeReviewPath();
  if (!p || !list.length) return;
  fs.writeFileSync(p, removeClaudeComments(fs.readFileSync(p, 'utf8'), list));
}
/** Vetty's exact review set, for Claude sessions (vetty-review skill). Written only when it changes. */
let lastScope = null;
function writeScope(scope) {
  if (!gitDir) return;
  const text = JSON.stringify({ note: 'Written by Vetty: the files it lists for review. Annotate only these.', ...scope }, null, 2) + '\n';
  if (text === lastScope) return;
  try {
    fs.mkdirSync(path.join(gitDir, 'vetty'), { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'vetty', 'scope.json'), text);
    lastScope = text;
  } catch (e) {
    dbg(`scope write failed: ${e.message}`);
  }
}
function activeBranchName() {
  return activeBranch;
}
/** Editor threads for Claude's block/detail notes start expanded (true) or collapsed (default). */
function guidedNotesExpanded(context) {
  return context.workspaceState.get('vetty.guidedNotesExpanded') === true;
}
function guidedReviewOn(context) {
  return context.workspaceState.get('vetty.guidedReview') === true;
}

// Debug log (churn hunting): opt-in via the vetty.debug setting → "Vetty Debug" output channel.
// Logs every git spawn + duration, watcher-triggered refreshes with the file that caused them,
// and per-load summaries.
let debugOn = false;
let debugChannel = null;
function updateDebugFlag() {
  debugOn = vscode.workspace.getConfiguration('vetty').get('debug', false);
}
function dbg(msg) {
  if (!debugOn) return;
  if (!debugChannel) debugChannel = vscode.window.createOutputChannel('Vetty Debug');
  debugChannel.appendLine(`${new Date().toISOString().slice(11, 23)} ${msg}`);
}
function showDebugLog() {
  if (!debugChannel) debugChannel = vscode.window.createOutputChannel('Vetty Debug');
  debugChannel.show(true);
}

/** Async git — non-blocking, so the extension host stays responsive. */
async function git(cwd, args) {
  const t0 = debugOn ? Date.now() : 0;
  // --no-optional-locks → skip the stat-cache refresh write for the commands that honour it
  // (`status` does; `diff` does NOT — stampIndexMtime below is what covers the rest).
  // core.quotePath=false → non-ASCII paths come out raw (not octal-escaped), so path joins resolve.
  const { stdout } = await execFileAsync('git', ['--no-optional-locks', '-c', 'core.quotePath=false', ...args], { cwd, maxBuffer: 16 * 1024 * 1024 });
  // Reads rewrite the index's stat cache — that's noise. Writes (add/restore/…) change what the tree
  // shows (stage markers), so leave them un-stamped: the watcher's next event is real news and reloads.
  if (INDEX_WRITES.has(args[0])) selfIndexMtime = 0;
  else stampIndexMtime(); // this call may have rewritten .git/index; don't let the watcher call it news
  if (debugOn) dbg(`git ${args.slice(0, 4).join(' ')}${args.length > 4 ? ' …' : ''} — ${Date.now() - t0}ms`);
  return stdout;
}

/** git with data on stdin (for --stdin-paths etc.). */
function gitStdin(cwd, args, input) {
  return new Promise((resolve, reject) => {
    const p = cp.execFile(
      'git',
      ['--no-optional-locks', '-c', 'core.quotePath=false', ...args],
      { cwd, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        stampIndexMtime();
        return err ? reject(err) : resolve(stdout);
      }
    );
    p.stdin.end(input);
  });
}

/** Raw bytes of a git blob (binary-safe — string stdout would corrupt binaries). */
function gitBlobBytes(cwd, sha) {
  return new Promise((resolve, reject) => {
    cp.execFile(
      'git',
      ['cat-file', 'blob', sha],
      { cwd, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
  });
}

/** `git add` in chunks — thousands of paths in one argv can blow Windows' command-line length limit. */
async function gitAddChunked(cwd, files) {
  for (let i = 0; i < files.length; i += 100) await git(cwd, ['add', '--', ...files.slice(i, i + 100)]);
}

/** Opt-in (vetty.stageOnView): marking a file viewed also stages its current content — reviewed ⇒
 *  staged. Files with open comments are skipped: a comment means "changes requested", so the file
 *  is reviewed but not approved (staged = viewed ∧ no open comments). Best-effort; never blocks
 *  the mark. */
async function stageOnView(context, cwd, rels) {
  if (!vscode.workspace.getConfiguration('vetty').get('stageOnView', false)) return;
  const comments = require('./comments').getComments(context); // lazy — comments requires core at top level
  const approved = rels.filter((r) => !(comments[r] || []).length);
  const skipped = rels.length - approved.length;
  if (skipped)
    vscode.window.setStatusBarMessage(
      `Vetty: ${skipped === 1 ? '1 file' : `${skipped} files`} viewed but NOT staged — open comments (💬)`,
      6000
    );
  if (!approved.length) return;
  try {
    await gitAddChunked(cwd, approved); // also stages deletions for tombstoned files
  } catch (e) {
    dbg(`stageOnView failed: ${e.message}`);
  }
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
function ghAvailable() {
  return hasGh;
}
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
    return git(cwd, ['show', `${q.ref}:${rel}`]).catch(async () => {
      // Renamed file: the new path doesn't exist at the base ref — show its old name instead,
      // so the diff shows the actual edit, not the whole file as added.
      try {
        for (const line of (await git(cwd, ['diff', '--diff-filter=R', '--name-status', q.ref])).split('\n')) {
          const parts = line.split('\t');
          if (parts.length === 3 && parts[2].trim() === rel) return git(cwd, ['show', `${q.ref}:${parts[1].trim()}`]);
        }
      } catch {}
      return ''; // genuinely missing in base (added file) → empty left side
    });
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

const { TODO_RE } = require('../lib'); // comment-leader / `LABEL:` only — see lib.js

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
      const p = path.join(cwd, u);
      if (fs.statSync(p).size > 1024 * 1024) continue; // huge file — not review material, skip the read
      const text = fs.readFileSync(p, 'utf8');
      if (text.indexOf('\0') !== -1) continue; // binary
      text.split('\n').forEach((l, i) => {
        if (TODO_RE.test(l)) todos.push({ rel: u, line: i + 1, text: l.trim() });
      });
    } catch {
      // unreadable — skip
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

/** Content hash of the working file, or '' if unreadable — used to auto-unview a file once it changes.
 *  Cached by (mtime, size): isViewed runs per file per render, so without this every refresh re-reads
 *  and re-hashes the whole changed set from disk. */
const hashCache = new Map(); // rel → { key: 'mtimeMs:size', h }
function fileHash(cwd, rel) {
  try {
    const p = path.join(cwd, rel);
    const st = fs.statSync(p);
    const key = `${st.mtimeMs}:${st.size}`;
    const c = hashCache.get(rel);
    if (c && c.key === key) return c.h;
    // Hash EOL-normalized (CRLF/CR → LF): with autocrlf, a branch swap-and-back rewrites files with
    // flipped line endings — byte-identical content otherwise — which silently unviewed everything.
    // (Rider is immune because it hashes the LF-normalized in-memory document.)
    const buf = fs.readFileSync(p);
    const h = crypto.createHash('sha1').update(eolNormalize(buf)).digest('hex');
    const raw = crypto.createHash('sha1').update(buf).digest('hex'); // pre-normalization format, for mark migration
    hashCache.set(rel, { key, h, raw });
    return h;
  } catch {
    return '';
  }
}
/** Raw (old-format) hash of the file — used once to migrate marks made before EOL normalization. */
function fileHashRaw(cwd, rel) {
  fileHash(cwd, rel); // populates the cache with both
  return hashCache.get(rel)?.raw ?? '';
}

// Viewed marks are per CURRENT BRANCH, stored as { relPath: { h: contentHash, b: gitBlobSha } }. A
// file counts as viewed only while its content still matches `h` (editing it re-flags it unviewed).
// `b` is the snapshot at mark time, used to diff "changes since last review". Legacy entries are
// bare hashes. Branch-keyed, NOT base-keyed: base-keyed marks were shared across sibling branches,
// so marking on one clobbered the other's — and the since-review overlay then diffed against a
// snapshot taken on the sibling (10271-content showing up while reviewing 10270).
let activeBranch = null; // current git branch; set by resolveBase before any tree render
// Scope = repo + branch ('\n' separator — impossible in both git refs and paths). Repo included so
// two repos in a multi-root workspace sharing a branch name don't share marks. Base param kept as a
// pre-first-load fallback.
function stateScope(base) {
  return `${getCwd() ?? ''}\n${activeBranch || base}`;
}
function viewedKey(base) {
  return `vetty.viewed.${stateScope(base)}`;
}
// Memoize parsed workspaceState values: the getters run per file inside render loops, and the
// per-call copy (spread / new Set) was the hot spot. Callers share the cached object; every
// mutation path calls the matching setter, which keeps cache and storage in sync.
const stateCache = new Map(); // workspaceState key → parsed value
function getViewed(context, base) {
  const k = viewedKey(base);
  if (!stateCache.has(k)) {
    const raw = context.workspaceState.get(k);
    stateCache.set(k, raw && !Array.isArray(raw) ? { ...raw } : {});
  }
  return stateCache.get(k);
}
function setViewed(context, base, map) {
  stateCache.set(viewedKey(base), map);
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
  if (!h) return false;
  if (h === 'D') return !fs.existsSync(path.join(cwd, rel)); // deletion tombstone: viewed while still gone
  const cur = fileHash(cwd, rel);
  if (h === cur) return true;
  // Migration: marks made before EOL-normalized hashing stored the raw-bytes hash. If that still
  // matches, the content is unchanged — self-heal the entry to the new format and keep it viewed.
  if (h === fileHashRaw(cwd, rel)) {
    const v = map[rel];
    if (v && typeof v === 'object') v.h = cur;
    else map[rel] = { h: cur, b: null };
    return true; // persisted on the next setViewed; stateCache keeps it correct within the session
  }
  return false;
}

/** Snapshot the working file into git's object store and return { h, b } for the viewed map.
 *  A DELETED file gets the tombstone hash 'D' (not a valid sha1, can't collide): it counts as
 *  viewed while the file stays gone and re-flags unviewed if the file comes back. */
async function viewedEntry(cwd, rel) {
  if (!fs.existsSync(path.join(cwd, rel))) return { h: 'D', b: null };
  const h = fileHash(cwd, rel);
  let b = null;
  try {
    b = (await git(cwd, ['hash-object', '-w', '--', path.join(cwd, rel)])).trim() || null;
  } catch {
    // blob snapshot best-effort; viewed-ness still works via hash
  }
  return { h, b };
}

/** Snapshot MANY files in ONE git process (bulk mark-viewed) — one process per file via Promise.all
 *  was a process storm on big groups. Falls back per-file if the batch fails (one unreadable path
 *  aborts --stdin-paths entirely). Returns { rel: { h, b } }. */
async function viewedEntries(cwd, rels) {
  const map = {};
  // Deleted files get tombstones and would abort the --stdin-paths batch — split them out first.
  const present = rels.filter((r) => {
    if (fs.existsSync(path.join(cwd, r))) return true;
    map[r] = { h: 'D', b: null };
    return false;
  });
  let blobs = null;
  try {
    blobs = present.length
      ? (await gitStdin(cwd, ['hash-object', '-w', '--stdin-paths'], present.map((r) => path.join(cwd, r)).join('\n') + '\n'))
          .trim()
          .split('\n')
      : [];
    if (blobs.length !== present.length) blobs = null;
  } catch {
    blobs = null;
  }
  if (blobs) {
    present.forEach((rel, i) => (map[rel] = { h: fileHash(cwd, rel), b: blobs[i].trim() || null }));
  } else {
    for (const rel of present) map[rel] = await viewedEntry(cwd, rel);
  }
  return map;
}

// vetty.ignorePatterns: settings-level globs (a layer on top of .gitignore, no repo file) — matches
// land in the Untracked group automatically. `**` crosses slashes, `*`/`?` don't; a pattern with a
// slash anchors to the repo-relative path, without one it matches any path segment.
let ignoreRegexes = null; // recompiled when the setting changes (config listener calls resetIgnorePatterns)
function resetIgnorePatterns() {
  ignoreRegexes = null;
}
function ignoredByPattern(rel) {
  if (!ignoreRegexes) {
    const pats = vscode.workspace.getConfiguration('vetty').get('ignorePatterns', []) || [];
    ignoreRegexes = pats
      .filter((p) => typeof p === 'string')
      .map(require('../lib').globToRegex)
      .filter(Boolean);
  }
  return ignoreRegexes.some((re) => re.test(rel));
}

// Ignored marks are a plain per-branch list of paths — a deliberate exclusion, so (unlike viewed) it
// is not tied to content hash. Ignored files get their own tree group, out of Unviewed/Viewed.
// The Set's `has` also consults vetty.ignorePatterns, so every consumer sees pattern matches as
// ignored; iteration/spread still yields only the explicit per-branch entries (what setIgnored saves).
class IgnoredSet extends Set {
  has(rel) {
    return super.has(rel) || ignoredByPattern(rel);
  }
}
function ignoredKey(base) {
  return `vetty.ignored.${stateScope(base)}`;
}
function getIgnored(context, base) {
  const k = ignoredKey(base);
  if (!stateCache.has(k)) {
    const raw = context.workspaceState.get(k);
    stateCache.set(k, new IgnoredSet(Array.isArray(raw) ? raw : []));
  }
  return stateCache.get(k);
}
function setIgnored(context, base, set) {
  stateCache.set(ignoredKey(base), set);
  return context.workspaceState.update(ignoredKey(base), [...set]);
}

// Groups: a per-branch { relPath: groupName } map. Lets you bucket changed files (by intent) and stage
// a bucket at a time — a lightweight, working-copy-only changelist. Shown as a [name] tag on the row.
function groupsKey(base) {
  return `vetty.groups.${stateScope(base)}`;
}
function getGroups(context, base) {
  const k = groupsKey(base);
  if (!stateCache.has(k)) {
    const raw = context.workspaceState.get(k);
    stateCache.set(k, raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {});
  }
  return stateCache.get(k);
}
function setGroups(context, base, map) {
  stateCache.set(groupsKey(base), map);
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
  } else if (uri.scheme === BASE_SCHEME || uri.scheme === BLOB_SCHEME) {
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
const TRUNK_NAMES = ['main', 'master', 'develop', 'dev', 'trunk'];
// ponytail: a real parent is close; an "ancestor" thousands of commits back is just an old merged
// branch the trunk contains, not a base. Cap how far ahead we'll still call something a parent.
const PARENT_MAX_AHEAD = 500;

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

/** When another branch's tip EQUALS this one's (fresh stacked branch, no commits yet), commit
 *  topology is symmetric — parent and child look identical. The reflog breaks the tie: its oldest
 *  entry is the branch's creation moment, and the branch created EARLIER is the parent. */
async function branchCreatedAt(cwd, branch) {
  try {
    // %gd + --date=unix = the reflog ENTRY time (%ct would be the commit time — identical for
    // same-tip branches, useless as a tie-break). Oldest entry = branch creation.
    const lines = (await git(cwd, ['reflog', 'show', '--date=unix', '--format=%gd', branch])).trim().split('\n').filter(Boolean);
    const m = lines.length ? lines[lines.length - 1].match(/@\{(\d+)\}/) : null;
    return m ? parseInt(m[1], 10) : Infinity;
  } catch {
    return Infinity; // no reflog → can't claim parenthood
  }
}

// Git stores no parent, so infer it: a branch whose tip is an ANCESTOR of HEAD (behind === 0, ahead > 0)
// is one this branch was built on; the DIRECT parent is the ancestor closest to HEAD (fewest commits
// ahead). A branch at the SAME tip that was created earlier is the parent of a fresh stacked branch
// (diff = working changes only — not the parent's commits). Falls back to a conventional base branch,
// then the most recent other branch.
// Now the terminal picker rule (lib.branchTree): first-parent walk from the tip to the first commit holding
// another branch's tip, reflog birth for same-tip ties, trunk fallback only when the branch reaches
// that trunk's history. Two git calls for every branch (no 50-branch cap), and the picker's tree and
// the inferred base can't disagree — the old ahead/behind scan rooted stacked branches on develop.
async function defaultBase(cwd) {
  const cur = await currentBranch(cwd);
  const names = await localBranches(cwd);
  if (!names.length) return null;
  // On the trunk itself there's no parent — every merged feature branch looks like an ancestor.
  // Default to the current branch = uncommitted working changes.
  if (cur && TRUNK_NAMES.includes(cur)) return cur;
  const tree = await branchTreeData(cwd);
  const parent = tree.rows.find((r) => r.name === cur)?.parent;
  if (parent) return parent;
  for (const c of TRUNK_NAMES) {
    if (c !== cur && names.includes(c)) return c;
  }
  // No parent / no other branch (e.g. on the base branch itself) → diff against the current branch,
  // which shows just the uncommitted working changes. Never leave the user with nothing to pick.
  return names.filter((n) => n !== cur)[0] || cur || null;
}

/** Every local branch as a tree + its graph column (bottom-up: trunk at the foot, stacks growing
 *  upward) + which branch is checked out in which other worktree. Two git calls plus one worktree
 *  list; reflog births only for same-tip ties. Feeds the picker and defaultBase. */
async function branchTreeData(cwd) {
  const [tipsOut, logOut, wtOut] = await Promise.all([
    git(cwd, ['for-each-ref', '--format=%(objectname) %(refname:short)', '--sort=-committerdate', 'refs/heads']),
    // --branches, not --all: remotes/tags would spend the walk budget; past the horizon a stacked
    // branch loses its parent and gets re-rooted as a peer of main.
    git(cwd, ['log', '--branches', '--first-parent', '--format=%H %P', '-n', '4000']).catch(() => ''),
    git(cwd, ['worktree', 'list', '--porcelain']).catch(() => ''),
  ]);
  const rows = await branchTree({
    tips: parseBranchTips(tipsOut),
    firstParents: parseFirstParents(logOut),
    trunks: TRUNK_NAMES,
    birthOf: (b) => branchCreatedAt(cwd, b),
    maxAhead: PARENT_MAX_AHEAD,
  });
  return { rows, worktrees: parseWorktrees(wtOut, cwd) };
}

// Base is remembered per current branch, so switching branches restores that branch's base (and a
// branch with none yet gets its closest ancestor inferred). LAST_BRANCH_KEY mirrors the resolved
// base so the many synchronous lastBranch() readers keep working.
const BASE_BY_BRANCH = 'vetty.baseByBranch';
function setBaseFor(context, branch, base) {
  if (branch) {
    const map = { ...(context.workspaceState.get(BASE_BY_BRANCH) || {}) };
    map[branch] = base;
    context.workspaceState.update(BASE_BY_BRANCH, map);
  }
  return context.workspaceState.update(LAST_BRANCH_KEY, base);
}

/** checkout -b continuation: marks are branch-keyed, so a new child branch starts empty even though
 *  its content is identical to what was just reviewed. On switching to `cur`: find the branch we
 *  came from in the HEAD reflog (restart-safe, unlike in-memory state), and if `cur` descends from
 *  its tip (merge-base == tip — exactly what checkout -b produces) and has no marks of its own yet,
 *  copy the parent's review state over. Hash-gating keeps it honest: only files whose content still
 *  matches show viewed. Never fires INTO a trunk (feature→master after a merge would pollute it),
 *  and never overwrites existing marks. */
async function inheritBranchState(context, cwd, cur) {
  try {
    if (TRUNK_NAMES.includes(cur)) return;
    const scope = (b) => `${getCwd() ?? ''}\n${b}`;
    const KEYS = ['viewed', 'ignored', 'groups', 'comments'];
    for (const k of KEYS) {
      const v = context.workspaceState.get(`vetty.${k}.${scope(cur)}`);
      if (v && Object.keys(v).length) return; // cur already has state — never overwrite
    }
    // Newest "checkout: moving from A to B" in the reflog tells us the parent candidate.
    const reflog = await git(cwd, ['reflog', 'HEAD', '-n', '30', '--format=%gs']);
    const m = reflog.split('\n').map((l) => /^checkout: moving from (\S+) to (\S+)/.exec(l)).find(Boolean);
    if (!m || m[2] !== cur || m[1] === cur) return;
    const prev = m[1];
    const prevViewed = context.workspaceState.get(`vetty.viewed.${scope(prev)}`);
    if (!prevViewed || !Object.keys(prevViewed).length) return;
    const prevTip = (await git(cwd, ['rev-parse', '--verify', prev])).trim();
    const mb = (await git(cwd, ['merge-base', prev, cur])).trim();
    if (!prevTip || prevTip !== mb) return; // cur is not a child of prev's current tip
    for (const k of KEYS) {
      const v = context.workspaceState.get(`vetty.${k}.${scope(prev)}`);
      // Deep-copy: storing the same object under both keys would alias A's and B's marks.
      if (v) await context.workspaceState.update(`vetty.${k}.${scope(cur)}`, JSON.parse(JSON.stringify(v)));
    }
    stateCache.clear(); // memoized state for the new scope must re-read
    dbg(`inherited review state ${prev} → ${cur}`);
  } catch (e) {
    dbg(`inherit skipped: ${e.message}`);
  }
}

const validatedBase = new Set(); // `${branch}\0${base}` already vetted this session (skip git re-checks)

/** Resolve the base for the current branch: remembered → else closest ancestor. Mirrors to LAST_BRANCH_KEY. */
async function resolveBase(context, cwd) {
  const cur = await currentBranch(cwd);
  if (cur && cur !== activeBranch) {
    activeBranch = cur; // viewed/ignored/groups/comments are keyed by this
    await inheritBranchState(context, cwd, cur); // checkout -b continuation: child inherits marks
    // Comments are branch-scoped: drop the old branch's live threads and hydrate this branch's,
    // so a persist after the switch can't write branch-A threads under branch-B's key.
    require('./comments').onBranchChanged(context); // lazy — comments requires core at top level
  }
  const map = context.workspaceState.get(BASE_BY_BRANCH) || {};
  let base = cur ? map[cur] : null;
  // Validate a remembered LOCAL base once per session (cheap on later loads via the cache).
  if (base && base !== cur && !base.startsWith('origin/') && !validatedBase.has(`${cur}\0${base}`)) {
    if (!(await localBranches(cwd)).includes(base)) {
      base = null; // branch was deleted
    } else {
      // Self-heal: a base that's an ancestor absurdly far ahead is a stale / bug-saved pick
      // (e.g. an old merged branch the trunk contains) → drop it and re-infer.
      const ab = await aheadBehind(cwd, base);
      if (ab && ab.behind === 0 && ab.ahead > PARENT_MAX_AHEAD) base = null;
    }
    if (base) validatedBase.add(`${cur}\0${base}`);
  }
  if (!base) base = await defaultBase(cwd); // infer the closest ancestor
  if (base) await setBaseFor(context, cur, base);
  return base;
}

function lastBranch(context) {
  const b = context.workspaceState.get(LAST_BRANCH_KEY);
  return typeof b === 'string' && b ? b : null;
}

// GC: per-branch state (viewed/ignored/groups + the base-by-branch map) otherwise accumulates
// forever as branches are deleted. Once per session, drop entries whose branch no longer exists
// locally. This also gradually clears legacy base-keyed entries (origin/* etc.).
let prunedStale = false;
async function pruneStaleState(context, cwd) {
  if (prunedStale) return;
  prunedStale = true;
  const keep = new Set(await localBranches(cwd));
  for (const key of context.workspaceState.keys()) {
    const m = key.match(/^vetty\.(viewed|ignored|groups|comments|mergeBase)\.(.+)$/);
    if (!m) continue;
    const scope = m[2];
    const sep = scope.lastIndexOf('\n');
    // Legacy (pre-repo-scope) keys are unreadable under the new format → always drop.
    // Scoped keys: prune only THIS repo's dead branches; other repos GC in their own sessions.
    const dead = sep < 0 || (scope.slice(0, sep) === cwd && !keep.has(scope.slice(sep + 1)));
    if (dead) {
      stateCache.delete(key);
      await context.workspaceState.update(key, undefined);
    }
  }
  await context.workspaceState.update('vetty.comments', undefined); // legacy global comments key
  const map = context.workspaceState.get(BASE_BY_BRANCH) || {};
  const pruned = Object.fromEntries(Object.entries(map).filter(([br]) => keep.has(br)));
  if (Object.keys(pruned).length !== Object.keys(map).length) {
    await context.workspaceState.update(BASE_BY_BRANCH, pruned);
  }
}

/** Stage-on-view's symmetric half: with the mode on, unviewing also unstages. Best-effort. */
async function unstageOnUnview(cwd, rels) {
  if (!vscode.workspace.getConfiguration('vetty').get('stageOnView', false)) return;
  try {
    for (let i = 0; i < rels.length; i += 100) await git(cwd, ['restore', '--staged', '--', ...rels.slice(i, i + 100)]);
  } catch {
    // nothing staged / not in HEAD — fine
  }
}

/** The merge-base moved (base was rebased/merged into the branch) → fully unview marks whose file
 *  content changed: their since-review snapshots predate the rebase, so the overlay would present
 *  the BASE's incoming changes as reviewable work. Untouched files keep their marks. */
async function purgeOnMergeBaseChange(context, cwd, base, mergeBase) {
  if (!mergeBase) return;
  const k = `vetty.mergeBase.${stateScope(base)}`;
  const prev = context.workspaceState.get(k);
  if (prev === mergeBase) return;
  if (prev) {
    const viewed = getViewed(context, base);
    let changed = false;
    for (const rel of Object.keys(viewed)) {
      if (!isViewed(cwd, viewed, rel)) {
        delete viewed[rel]; // mark + snapshot both go — the file behaves fresh-unviewed
        changed = true;
      }
    }
    if (changed) await setViewed(context, base, viewed);
  }
  await context.workspaceState.update(k, mergeBase);
}

/** Drives the editor-title icon: eye when unviewed, eye-closed when viewed. */
function updateViewedContext(context) {
  const cwd = getCwd();
  const base = lastBranch(context);
  const rel = cwd ? activeRelPath(cwd) : null;
  const viewed = !!(cwd && base && rel && isViewed(cwd, getViewed(context, base), rel));
  vscode.commands.executeCommand('setContext', 'vetty.activeViewed', viewed);
}

/** Middle-truncate a long ref for display (keeps the meaningful head + tail). Full value goes in a tooltip. */
function shortRef(s, max = 30) {
  if (!s || s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  return s.slice(0, head) + '…' + s.slice(s.length - (max - 1 - head));
}

// Diff left-side mode: 'branch' (whole branch vs merge-base), 'review' (since last viewed), 'commit' (since last commit / HEAD).
// Two independent axes (each its own toolbar toggle):
//   range  — which files/base: 'branch' (everything vs merge-base) or 'commit' (uncommitted vs HEAD)
//   sinceReview — overlay: an unviewed file diffs against its last-reviewed snapshot instead of the base
const DIFF_RANGE_SHORT = { branch: 'whole branch', commit: 'uncommitted' };
function diffRange(context) {
  return context.workspaceState.get('vetty.diffRange') === 'commit' ? 'commit' : 'branch'; // default branch
}
function sinceReviewOn(context) {
  return context.workspaceState.get('vetty.sinceReview') !== false; // default on
}

/** True when `rel` has a usable since-last-review snapshot (overlay on + blob present + now unviewed). */
function hasSinceReviewDiff(context, cwd, base, rel) {
  if (!base || !sinceReviewOn(context)) return false;
  const viewed = getViewed(context, base);
  return !!reviewedBlob(viewed, rel) && !isViewed(cwd, viewed, rel);
}

module.exports = {
  app, refreshTree, dbg, updateDebugFlag, showDebugLog,
  LAST_BRANCH_KEY, MAX_OPEN_WITHOUT_CONFIRM, REVIEW_KEY, FOLDER_KEY,
  BASE_SCHEME, BLOB_SCHEME, baseUriFor, blobUriFor, baseContentProvider, blobContentProvider,
  workspaceFolderPath, getCwd, resolveRepoRoot, watchGitDir, isSelfIndexWrite,
  git, gitStdin, gitAddChunked, gitBlobBytes, stageOnView, unstageOnUnview, mergeBaseRef,
  gh, ghAvailable, prEnabled, updatePrMode, detectGh,
  TODO_RE, findTodos, untrackedFiles,
  hashCache, fileHash,
  stateScope,
  getViewed, setViewed, viewedHash, reviewedBlob, isViewed, viewedEntry, viewedEntries,
  getIgnored, setIgnored, ignoredByPattern, resetIgnorePatterns, getGroups, setGroups, groupNames,
  activeRelPath, aheadBehind, MAX_REL_BRANCHES, TRUNK_NAMES, PARENT_MAX_AHEAD,
  currentBranch, localBranches, defaultBase, branchTreeData, branchCreatedAt, setBaseFor, resolveBase, lastBranch, pruneStaleState,
  purgeOnMergeBaseChange,
  updateViewedContext, shortRef,
  DIFF_RANGE_SHORT, diffRange, sinceReviewOn, hasSinceReviewDiff,
  claudeReview, claudeReviewPath, claudeReviewStamp, claudeReviewFileBranch, deleteClaudeComments, guidedReviewOn, guidedNotesExpanded, writeScope, activeBranchName,
};
