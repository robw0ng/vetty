// Guided Review plumbing: Claude's review file (<git-dir>/vetty/claude-review.json), its watcher,
// the scope.json Vetty publishes for Claude, and the two guided-review toggles.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { parseClaudeReview, removeClaudeComments } = require('../lib');
const { dbg } = require('./app');
const { gitDirPath } = require('./git');
const { activeBranchName } = require('./review-state');

// Any Claude session (vetty-review skill) writes an intuitive review order and short context notes
// here; both editors read it. One file per worktree, scoped to one branch.
function claudeReviewPath() {
  const gitDir = gitDirPath();
  return gitDir ? path.join(gitDir, 'vetty', 'claude-review.json') : null;
}

let claudeCache = { key: null, value: null };
/** Parsed review for the current branch, or null. Same object until the file or branch changes, so
 *  callers can compare by identity to skip rebuilds. */
function claudeReview() {
  const p = claudeReviewPath();
  const branch = activeBranchName();
  let key = null;
  try {
    const st = p && fs.statSync(p);
    if (st) key = `${st.mtimeMs}:${st.size}:${branch}`;
  } catch {
    // no file yet
  }
  if (key !== claudeCache.key) {
    let value = null;
    try {
      value = key ? parseClaudeReview(fs.readFileSync(p, 'utf8'), branch) : null;
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

// The review file lives in the git dir (worktree-aware), outside the working-tree watcher. Rebuilt
// with the .git watcher when the active folder changes.
let claudeWatcher = null;
function watchClaudeReview(context, bump) {
  claudeWatcher?.dispose();
  claudeWatcher = null;
  const gitDir = gitDirPath();
  if (!gitDir) return;
  claudeWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(gitDir, 'vetty/claude-review.json'));
  claudeWatcher.onDidChange(bump);
  claudeWatcher.onDidCreate(bump);
  claudeWatcher.onDidDelete(bump);
  context.subscriptions.push(claudeWatcher);
}

/** Vetty's exact review set, for Claude sessions (vetty-review skill). Written only when it changes. */
let lastScope = null;
function writeScope(scope) {
  const gitDir = gitDirPath();
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

function guidedReviewOn(context) {
  return context.workspaceState.get('vetty.guidedReview') === true;
}
/** Editor threads for Claude's block/detail notes start expanded (true) or collapsed (default). */
function guidedNotesExpanded(context) {
  return context.workspaceState.get('vetty.guidedNotesExpanded') === true;
}

module.exports = {
  claudeReviewPath, claudeReview, claudeReviewStamp, claudeReviewFileBranch, deleteClaudeComments,
  watchClaudeReview, writeScope, guidedReviewOn, guidedNotesExpanded,
};
