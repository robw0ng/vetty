// Git and gh process helpers, the repo root / git dir, and the .git watcher with its own-write suppression.
const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { app, dbg, debugOn } = require('./app');

const execFileAsync = promisify(cp.execFile);

// Git paths are repo-root-relative, so everything must join against the toplevel — which can sit
// ABOVE the opened folder (workspace = a subdir of the repo). Resolved in activate and again when
// the user picks a different workspace folder (multi-root).
let repoRoot = null;
let gitDir = null; // absolute .git dir — a FILE-based .git (worktrees, submodules) points elsewhere
const FOLDER_KEY = 'vetty.folder'; // fsPath of the workspace folder Vetty works on (multi-root)

function workspaceFolderPath() {
  const folders = vscode.workspace.workspaceFolders || [];
  const saved = app.context?.workspaceState.get(FOLDER_KEY);
  return folders.find((f) => f.uri.fsPath === saved)?.uri.fsPath ?? folders[0]?.uri.fsPath ?? null;
}
function getCwd() {
  return repoRoot ?? workspaceFolderPath();
}
function gitDirPath() {
  return gitDir;
}
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
  require('./guided').watchClaudeReview(context, bump); // lazy: guided requires this module
}

/** Async git — non-blocking, so the extension host stays responsive. */
async function git(cwd, args) {
  const t0 = debugOn() ? Date.now() : 0;
  // --no-optional-locks → skip the stat-cache refresh write for the commands that honour it
  // (`status` does; `diff` does NOT — stampIndexMtime below is what covers the rest).
  // core.quotePath=false → non-ASCII paths come out raw (not octal-escaped), so path joins resolve.
  const { stdout } = await execFileAsync('git', ['--no-optional-locks', '-c', 'core.quotePath=false', ...args], { cwd, maxBuffer: 16 * 1024 * 1024 });
  // Reads rewrite the index's stat cache — that's noise. Writes (add/restore/…) change what the tree
  // shows (stage markers), so leave them un-stamped: the watcher's next event is real news and reloads.
  if (INDEX_WRITES.has(args[0])) selfIndexMtime = 0;
  else stampIndexMtime();
  if (debugOn()) dbg(`git ${args.slice(0, 4).join(' ')}${args.length > 4 ? ' …' : ''} — ${Date.now() - t0}ms`);
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

// ---- Ref reads without a spawn ---------------------------------------------------------------
// HEAD, loose refs and packed-refs are plain files. Reading them replaces `rev-parse --abbrev-ref
// HEAD` on every refresh and lets the merge-base answer be cached by the tips it depends on.
// Worktrees: HEAD sits in the worktree's own git dir, refs in the common dir (`commondir` file).
// Anything unusual (unborn branch, symbolic loose ref, unreadable) → null → the git spawn as before.
const SHA_RE = /^[0-9a-f]{40,64}$/;
function commonDir() {
  if (!gitDir) return null;
  try {
    return path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
  } catch {
    return gitDir; // not a linked worktree
  }
}
/** Sha of a full ref name (`refs/heads/x`, `refs/remotes/origin/x`): loose file first, then packed-refs. */
function refTip(ref) {
  const common = commonDir();
  if (!common) return null;
  try {
    const s = fs.readFileSync(path.join(common, ref), 'utf8').trim();
    return SHA_RE.test(s) ? s : null;
  } catch {
    // no loose file — packed below
  }
  try {
    // ponytail: packed-refs is re-read per call (a few hundred KB at most, ms) — cache by mtime if it shows
    for (const line of fs.readFileSync(path.join(common, 'packed-refs'), 'utf8').split('\n')) {
      if (line[0] === '#' || line[0] === '^') continue;
      const sp = line.indexOf(' ');
      if (sp > 0 && line.slice(sp + 1).trim() === ref) return SHA_RE.test(line.slice(0, sp)) ? line.slice(0, sp) : null;
    }
  } catch {
    // no packed-refs
  }
  return null;
}
/** .git/HEAD → { branch, sha, detached }: branch = short name when HEAD is a `refs/heads/` ref (else
 *  null), sha = the commit (null when unborn), detached = HEAD holds a bare sha. null when there is
 *  no repo to read. Only valid for the resolved repo (`cwd === getCwd()`). */
function headRef() {
  if (!gitDir) return null;
  try {
    const s = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (s.startsWith('ref: ')) {
      const ref = s.slice(5).trim();
      return { branch: ref.startsWith('refs/heads/') ? ref.slice(11) : null, sha: refTip(ref), detached: false };
    }
    return SHA_RE.test(s) ? { branch: null, sha: s, detached: true } : null;
  } catch {
    return null;
  }
}

// Resolve the ref to diff against: the merge-base of `base` and HEAD, NOT base's tip. This matches
// GitHub's "files changed" (only what this branch added since it forked) — diffing against the tip
// of a base that has since advanced would wrongly include every file the base moved ahead on.
// If base IS an ancestor (e.g. the current branch), merge-base ≈ HEAD, so working changes still show.
/** The merge-base to diff against. For a local base, HEAD's merge-base with it AND with
 *  `origin/<base>` are both taken and the one nearer HEAD wins: a stale local base (never pulled)
 *  or a stale origin (not fetched) would otherwise make upstream commits the branch already
 *  merged look like its own work. Equal → local; one missing → the other; diverged (neither
 *  contains the other, rare) → origin, logged. Cached by the pair, so the ancestor check only
 *  reruns when a merge-base moves. */
const mergeBaseCache = new Map(); // base → { key: 'mbLocal\nmbOrigin', ref }
let mergeBaseMemo = null; // { key: base + HEAD + base tip + origin tip, ref } — a hit costs no spawn at all
/** Forget the memoized merge-base (the Refresh button): `git replace` / grafts move it without moving a tip. */
function resetMergeBaseMemo() {
  mergeBaseMemo = null;
}
function shallowStamp() {
  // A shallow clone's merge-base moves on --deepen/--unshallow with every tip unchanged: key on that file.
  try {
    return String(fs.statSync(path.join(commonDir(), 'shallow')).mtimeMs);
  } catch {
    return '';
  }
}
async function mergeBaseOf(cwd, ref) {
  try {
    return (await git(cwd, ['merge-base', ref, 'HEAD'])).trim() || null;
  } catch {
    return null; // ref missing (no upstream) or unrelated history
  }
}
async function isAncestor(cwd, a, b) {
  try {
    await git(cwd, ['merge-base', '--is-ancestor', a, b]); // exit 1 (throws) = not an ancestor
    return true;
  } catch {
    return false;
  }
}
async function mergeBaseRef(cwd, base) {
  if (!base) return base;
  // The answer is a function of HEAD and the two tips: while those files read the same, reuse it.
  // Not memoized when a tip can't be read (unborn, tag/sha base) — git decides every time then.
  const head = cwd === getCwd() ? headRef()?.sha : null;
  const remote = base.startsWith('origin/');
  const tip = base === 'HEAD' ? head : refTip(remote ? `refs/remotes/${base}` : `refs/heads/${base}`);
  const originTip = base === 'HEAD' || remote ? '' : refTip(`refs/remotes/origin/${base}`) ?? '';
  const key = head && tip ? `${cwd}\n${base}\n${head}\n${tip}\n${originTip}\n${shallowStamp()}` : null;
  if (key && mergeBaseMemo?.key === key) return mergeBaseMemo.ref;
  const ref = await computeMergeBaseRef(cwd, base);
  if (key) mergeBaseMemo = { key, ref };
  return ref;
}
async function computeMergeBaseRef(cwd, base) {
  const local = await mergeBaseOf(cwd, base);
  if (base === 'HEAD' || base.startsWith('origin/')) return local || base;
  const origin = await mergeBaseOf(cwd, `origin/${base}`);
  if (!local || !origin || local === origin) return local || origin || base;
  const key = `${local}\n${origin}`;
  const hit = mergeBaseCache.get(base);
  if (hit && hit.key === key) return hit.ref;
  let ref;
  if (await isAncestor(cwd, local, origin)) ref = origin; // local base is behind: origin's is newer
  else if (await isAncestor(cwd, origin, local)) ref = local; // origin not fetched lately: local is newer
  else {
    ref = origin;
    dbg(`merge-bases of ${base} and origin/${base} diverged (${local.slice(0, 7)} vs ${origin.slice(0, 7)}) — using origin's`);
  }
  mergeBaseCache.set(base, { key, ref });
  return ref;
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

module.exports = {
  FOLDER_KEY, workspaceFolderPath, getCwd, gitDirPath, resolveRepoRoot, watchGitDir, isSelfIndexWrite,
  git, gitStdin, gitBlobBytes, gitAddChunked, mergeBaseRef, resetMergeBaseMemo, headRef, refTip,
  gh, ghAvailable, prEnabled, updatePrMode, detectGh,
};
