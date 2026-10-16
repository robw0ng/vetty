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

module.exports = {
  FOLDER_KEY, workspaceFolderPath, getCwd, gitDirPath, resolveRepoRoot, watchGitDir, isSelfIndexWrite,
  git, gitStdin, gitBlobBytes, gitAddChunked, mergeBaseRef,
  gh, ghAvailable, prEnabled, updatePrMode, detectGh,
};
