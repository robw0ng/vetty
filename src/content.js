// What a diff shows: the two left-side content providers (base ref / last-viewed blob), the diff
// range + since-review modes, the active editor's repo path, and the TODO / untracked-file scans.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { TODO_RE, parseTodoHunks } = require('../lib');
const { getCwd, git } = require('./git');
const { getViewed, isViewed, reviewedBlob } = require('./review-state');
const { lastBranch } = require('./base');

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

/** Repo-relative, forward-slash path of the active editor's file (handles diff sides), or null. */
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

module.exports = {
  BASE_SCHEME, BLOB_SCHEME, baseUriFor, blobUriFor, baseContentProvider, blobContentProvider,
  activeRelPath, updateViewedContext, shortRef,
  DIFF_RANGE_SHORT, diffRange, sinceReviewOn, hasSinceReviewDiff,
  untrackedFiles, findTodos,
};
