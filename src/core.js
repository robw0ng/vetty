// Core plumbing: shared refs, git/gh process helpers, persisted review state (viewed/ignored/groups),
// base-branch memory + inference, and the diff-content providers. Every other module requires this
// one; core itself only lazy-requires siblings inside functions (no top-level cycles).
const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { promisify } = require('util');
const { parseAheadBehind, parseTodoHunks } = require('../lib');

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
async function resolveRepoRoot() {
  repoRoot = null;
  const ws = workspaceFolderPath();
  if (!ws) return;
  try {
    repoRoot = path.normalize((await git(ws, ['rev-parse', '--show-toplevel'])).trim()) || null;
  } catch {
    // not a git repo — getCwd() falls back to the folder itself
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
  gitWatcher.onDidChange(bump);
  gitWatcher.onDidCreate(bump);
  gitWatcher.onDidDelete(bump);
  context.subscriptions.push(gitWatcher);
}

/** Async git — non-blocking, so the extension host stays responsive. */
async function git(cwd, args) {
  // core.quotePath=false → non-ASCII paths come out raw (not octal-escaped), so path joins resolve.
  const { stdout } = await execFileAsync('git', ['-c', 'core.quotePath=false', ...args], { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** git with data on stdin (for --stdin-paths etc.). */
function gitStdin(cwd, args, input) {
  return new Promise((resolve, reject) => {
    const p = cp.execFile(
      'git',
      ['-c', 'core.quotePath=false', ...args],
      { cwd, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
    p.stdin.end(input);
  });
}

/** `git add` in chunks — thousands of paths in one argv can blow Windows' command-line length limit. */
async function gitAddChunked(cwd, files) {
  for (let i = 0; i < files.length; i += 100) await git(cwd, ['add', '--', ...files.slice(i, i + 100)]);
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
    const h = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    hashCache.set(rel, { key, h });
    return h;
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

/** Snapshot MANY files in ONE git process (bulk mark-viewed) — one process per file via Promise.all
 *  was a process storm on big groups. Falls back per-file if the batch fails (one unreadable path
 *  aborts --stdin-paths entirely). Returns { rel: { h, b } }. */
async function viewedEntries(cwd, rels) {
  const map = {};
  let blobs = null;
  try {
    blobs = (await gitStdin(cwd, ['hash-object', '-w', '--stdin-paths'], rels.map((r) => path.join(cwd, r)).join('\n') + '\n'))
      .trim()
      .split('\n');
    if (blobs.length !== rels.length) blobs = null;
  } catch {
    blobs = null;
  }
  if (blobs) {
    rels.forEach((rel, i) => (map[rel] = { h: fileHash(cwd, rel), b: blobs[i].trim() || null }));
  } else {
    for (const rel of rels) map[rel] = await viewedEntry(cwd, rel);
  }
  return map;
}

// Ignored marks are a plain per-base list of paths — a deliberate exclusion, so (unlike viewed) it
// is not tied to content hash. Ignored files get their own tree group, out of Unviewed/Viewed.
function ignoredKey(base) {
  return `vetty.ignored.${base}`;
}
function getIgnored(context, base) {
  const k = ignoredKey(base);
  if (!stateCache.has(k)) {
    const raw = context.workspaceState.get(k);
    stateCache.set(k, new Set(Array.isArray(raw) ? raw : []));
  }
  return stateCache.get(k);
}
function setIgnored(context, base, set) {
  stateCache.set(ignoredKey(base), set);
  return context.workspaceState.update(ignoredKey(base), [...set]);
}

// Groups: a per-base { relPath: groupName } map. Lets you bucket changed files (by intent) and stage
// a bucket at a time — a lightweight, working-copy-only changelist. Shown as a [name] tag on the row.
function groupsKey(base) {
  return `vetty.groups.${base}`;
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

// Git stores no parent, so infer it: a branch whose tip is an ANCESTOR of HEAD (behind === 0, ahead > 0)
// is one this branch was built on; the DIRECT parent is the ancestor closest to HEAD (fewest commits
// ahead). Falls back to a conventional base branch, then the most recent other branch.
async function defaultBase(cwd) {
  const cur = await currentBranch(cwd);
  const names = await localBranches(cwd);
  if (!names.length) return null;
  // On the trunk itself there's no parent — every merged feature branch looks like an ancestor.
  // Default to the current branch = uncommitted working changes.
  if (cur && TRUNK_NAMES.includes(cur)) return cur;
  const others = names.filter((n) => n !== cur).slice(0, MAX_REL_BRANCHES);

  let parent = null;
  let parentAhead = Infinity;
  await Promise.all(
    others.map(async (b) => {
      const ab = await aheadBehind(cwd, b);
      if (ab && ab.behind === 0 && ab.ahead > 0 && ab.ahead < parentAhead && ab.ahead <= PARENT_MAX_AHEAD) {
        parentAhead = ab.ahead;
        parent = b;
      }
    })
  );
  if (parent) return parent;
  for (const c of TRUNK_NAMES) {
    if (c !== cur && names.includes(c)) return c;
  }
  // No parent / no other branch (e.g. on the base branch itself) → diff against the current branch,
  // which shows just the uncommitted working changes. Never leave the user with nothing to pick.
  return names.filter((n) => n !== cur)[0] || cur || null;
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

const validatedBase = new Set(); // `${branch}\0${base}` already vetted this session (skip git re-checks)

/** Resolve the base for the current branch: remembered → else closest ancestor. Mirrors to LAST_BRANCH_KEY. */
async function resolveBase(context, cwd) {
  const cur = await currentBranch(cwd);
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

// GC: per-base state (viewed/ignored/groups + the base-by-branch map) otherwise accumulates
// forever as branches are deleted. Once per session, drop entries for bases that no longer exist
// locally (origin/* entries are kept — small, and validating remotes isn't worth a fetch).
let prunedStale = false;
async function pruneStaleState(context, cwd) {
  if (prunedStale) return;
  prunedStale = true;
  const keep = new Set(await localBranches(cwd));
  const live = (b) => keep.has(b) || b.startsWith('origin/');
  for (const key of context.workspaceState.keys()) {
    const m = key.match(/^vetty\.(viewed|ignored|groups)\.(.+)$/);
    if (m && !live(m[2])) {
      stateCache.delete(key);
      await context.workspaceState.update(key, undefined);
    }
  }
  const map = context.workspaceState.get(BASE_BY_BRANCH) || {};
  const pruned = Object.fromEntries(Object.entries(map).filter(([br]) => keep.has(br)));
  if (Object.keys(pruned).length !== Object.keys(map).length) {
    await context.workspaceState.update(BASE_BY_BRANCH, pruned);
  }
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
  app, refreshTree,
  LAST_BRANCH_KEY, MAX_OPEN_WITHOUT_CONFIRM, REVIEW_KEY, FOLDER_KEY,
  BASE_SCHEME, BLOB_SCHEME, baseUriFor, blobUriFor, baseContentProvider, blobContentProvider,
  workspaceFolderPath, getCwd, resolveRepoRoot, watchGitDir,
  git, gitStdin, gitAddChunked, mergeBaseRef,
  gh, ghAvailable, prEnabled, updatePrMode, detectGh,
  TODO_RE, findTodos, untrackedFiles,
  hashCache, fileHash,
  getViewed, setViewed, viewedHash, reviewedBlob, isViewed, viewedEntry, viewedEntries,
  getIgnored, setIgnored, getGroups, setGroups, groupNames,
  activeRelPath, aheadBehind, MAX_REL_BRANCHES, TRUNK_NAMES, PARENT_MAX_AHEAD,
  currentBranch, localBranches, defaultBase, setBaseFor, resolveBase, lastBranch, pruneStaleState,
  updateViewedContext, shortRef,
  DIFF_RANGE_SHORT, diffRange, sinceReviewOn, hasSinceReviewDiff,
};
