// Moving through the review: opening a file the right way (diff / file / since-review), j/k
// navigation, expand/collapse, paging, and the view-mode toggles on the Review toolbar.
const vscode = require('vscode');
const path = require('path');
const core = require('./core');
const {
  app, getCwd, refreshTree, getViewed, isViewed, baseUriFor, blobUriFor, reviewedBlob,
  DIFF_RANGE_SHORT, diffRange, sinceReviewOn, hasSinceReviewDiff,
} = core;
const { PAGE_SIZE } = require('./tree');

/** Open a file and select (highlight) the matched text at a search hit. */
async function openMatch(rel, line, col, len) {
  const cwd = getCwd();
  if (!cwd) return;
  const uri = vscode.Uri.file(path.join(cwd, rel));
  const sel = new vscode.Range(line - 1, col, line - 1, col + len);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { selection: sel });
}

/** Open options that land on the file's first comment (else unchanged: editors reveal the first change). */
function atFirstComment(context, rel, opts = {}) {
  if (opts.selection || app.diffTree?.deleted?.has(rel)) return opts; // deleted: no right side to scroll
  const line = require('./comments').firstCommentLine(context, rel);
  return line === null ? opts : { ...opts, selection: new vscode.Range(line, 0, line, 0) };
}

/** Open one file's diff: since-review overlay wins when active; otherwise the range's base.
 *  Deleted files diff against an EMPTY right side (there's no working file to show). */
function openOneDiff(context, cwd, base, rel, opts) {
  const fileUri = vscode.Uri.file(path.join(cwd, rel));
  const gone = app.diffTree?.deleted?.has(rel);
  opts = atFirstComment(context, rel, opts); // selection set → the diff editor skips its jump to the first change
  const rightUri = gone ? baseUriFor(fileUri, '') : fileUri; // ref '' → the provider returns ''
  const rightLabel = gone ? 'deleted' : 'working';
  if (hasSinceReviewDiff(context, cwd, base, rel)) {
    const blob = reviewedBlob(getViewed(context, base), rel);
    return vscode.commands.executeCommand('vscode.diff', blobUriFor(fileUri, blob), rightUri, `${rel} (last viewed ↔ ${rightLabel})`, opts);
  }
  // Uncommitted-only rows (branch range) have no merge-base diff by definition — show vs HEAD.
  if (diffRange(context) === 'commit' || app.diffTree?.wtOnly?.has(rel)) {
    // Working tree vs HEAD = uncommitted changes only. New/untracked files → empty left side.
    return vscode.commands.executeCommand('vscode.diff', baseUriFor(fileUri, 'HEAD'), rightUri, `${rel} (uncommitted${gone ? ' ↔ deleted' : ''})`, opts);
  }
  const ref = (app.diffTree && app.diffTree.baseRef) || base; // whole branch: diff against the merge-base
  return vscode.commands.executeCommand('vscode.diff', baseUriFor(fileUri, ref), rightUri, `${rel} (${base} ↔ ${rightLabel})`, opts);
}

/** Open a changed file the right way: whole file for new files, else its diff. */
async function openReviewFile(context, cwd, base, rel, opts = { preview: true }) {
  if (app.diffTree.added.has(rel) && !hasSinceReviewDiff(context, cwd, base, rel)) {
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(cwd, rel)), atFirstComment(context, rel, opts));
  } else {
    await openOneDiff(context, cwd, base, rel, opts);
  }
}

/** j/k navigation: open the next/prev unviewed file relative to the active one. */
async function navigateUnviewed(context, dir) {
  const cwd = getCwd();
  const base = app.diffTree?.base;
  if (!cwd || !base) return;
  const viewed = getViewed(context, base);
  const unviewed = app.diffTree.visibleFiles(cwd).filter((f) => !isViewed(cwd, viewed, f)); // within the filtered slice
  if (!unviewed.length) {
    vscode.window.setStatusBarMessage('No unviewed files', 2000);
    return;
  }
  const cur = core.activeRelPath(cwd);
  const idx = cur ? unviewed.indexOf(cur) : -1;
  const next =
    idx >= 0 ? unviewed[(idx + dir + unviewed.length) % unviewed.length] : unviewed[dir > 0 ? 0 : unviewed.length - 1];
  await openReviewFile(context, cwd, base, next);
  app.diffTree.revealFile(next); // highlight it in the list
}

/** Expand all groups + their folders (VS Code expands up to 3 levels per reveal). */
async function expandAll() {
  if (!app.diffTree || !app.diffTreeView) return;
  const roots = app.diffTree.getChildren();
  for (const g of Array.isArray(roots) ? roots : []) {
    if (!g || !g.files) continue; // skip the welcome/placeholder item
    try {
      await app.diffTreeView.reveal(g, { select: false, focus: false, expand: 3 });
    } catch {
      // reveal can reject if the view isn't ready — ignore
    }
  }
}

/** Collapse the nested folders but leave the Unviewed/Viewed/Ignored groups expanded. */
async function collapseFolders() {
  if (!app.diffTree || !app.diffTreeView) return;
  await vscode.commands.executeCommand('workbench.actions.treeView.vettyView.collapseAll'); // collapses everything
  const roots = app.diffTree.getChildren();
  for (const g of Array.isArray(roots) ? roots : []) {
    if (!g || !g.files) continue;
    try {
      await app.diffTreeView.reveal(g, { select: false, focus: false, expand: 1 }); // re-open just the group (folders stay collapsed)
    } catch {
      // ignore
    }
  }
}

function showMore(groupKey) {
  if (!app.diffTree) return;
  app.diffTree.pageLimits[groupKey] = (app.diffTree.pageLimits[groupKey] || PAGE_SIZE) + PAGE_SIZE;
  app.diffTree.refresh();
}

async function toggleNesting(context) {
  if (!app.diffTree) return;
  app.diffTree.nested = !app.diffTree.nested;
  await context.workspaceState.update('vetty.nested', app.diffTree.nested);
  await vscode.commands.executeCommand('setContext', 'vetty.nested', app.diffTree.nested);
  refreshTree();
}

async function toggleWhitespace(context) {
  if (!app.diffTree) return;
  app.diffTree.hideWhitespace = !app.diffTree.hideWhitespace;
  await context.workspaceState.update('vetty.hideWhitespace', app.diffTree.hideWhitespace);
  await vscode.commands.executeCommand('setContext', 'vetty.hideWhitespace', app.diffTree.hideWhitespace);
  await app.diffTree.load(); // realChanged is only computed while the toggle is on → needs a reload, not a re-render
}

/** Range toggle: whole-branch (vs merge-base) ⇄ since-last-commit (vs HEAD). Changes the file set. */
async function toggleRange(context) {
  const next = diffRange(context) === 'commit' ? 'branch' : 'commit';
  await context.workspaceState.update('vetty.diffRange', next);
  await vscode.commands.executeCommand('setContext', 'vetty.diffRange', next);
  await app.diffTree.load(); // the listed file set differs (branch changes vs uncommitted-vs-HEAD)
  vscode.window.setStatusBarMessage(`Range: ${DIFF_RANGE_SHORT[next]}`, 2000);
}

/** Guided Review: on = Claude's review order + Claude's notes; off = path order, no Claude notes. */
async function toggleGuidedReview(context) {
  const next = !core.guidedReviewOn(context);
  await context.workspaceState.update('vetty.guidedReview', next);
  await vscode.commands.executeCommand('setContext', 'vetty.guidedReview', next);
  require('./comments').syncAiThreads(); // show / hide the notes
  refreshTree();
  const r = core.claudeReview();
  if (next && !r?.order.size && !r?.comments.length) {
    const other = core.claudeReviewFileBranch();
    vscode.window.showInformationMessage(
      other && other !== core.activeBranchName()
        ? `The guided review on disk is for "${other}" — you're on "${core.activeBranchName()}". Ask Claude to "annotate this branch for Vetty".`
        : 'No guided review for this branch yet. Ask Claude to "annotate this branch for Vetty".'
    );
  } else vscode.window.setStatusBarMessage(`Guided review ${next ? 'on' : 'off'}`, 2000);
}

/** Guided notes expanded ⇄ collapsed in the editor (big-picture notes are always expanded). */
async function toggleGuidedNotes(context) {
  const next = !core.guidedNotesExpanded(context);
  await context.workspaceState.update('vetty.guidedNotesExpanded', next);
  await vscode.commands.executeCommand('setContext', 'vetty.guidedNotesExpanded', next);
  require('./comments').applyGuidedNotesState();
}

/** Since-review overlay toggle: unviewed files diff against your last-reviewed snapshot. */
async function toggleSinceReview(context) {
  const next = !sinceReviewOn(context);
  await context.workspaceState.update('vetty.sinceReview', next);
  await vscode.commands.executeCommand('setContext', 'vetty.sinceReview', next);
  await app.diffTree.load();
  vscode.window.setStatusBarMessage(`Compare: ${next ? 'last viewed' : 'base'}`, 2000);
}

module.exports = {
  openMatch, atFirstComment, openOneDiff, openReviewFile, navigateUnviewed,
  expandAll, collapseFolders, showMore,
  toggleNesting, toggleWhitespace, toggleRange, toggleSinceReview, toggleGuidedReview, toggleGuidedNotes,
};
