// Staging from the Review tree: stage / unstage rows, stage everything viewed, revert a file to HEAD
// or to its last-viewed snapshot, and the stage-on-view toggle.
const vscode = require('vscode');
const path = require('path');
const { app, getCwd, git, gitAddChunked, gitBlobBytes, stageOnView, getViewed, isViewed, reviewedBlob } = require('./core');
const { selectedRels } = require('./commands');

/** Bridge review → SCM: git-add every file you've marked viewed, then commit in Source Control. */
async function stageViewed(context) {
  const cwd = getCwd();
  const base = app.diffTree?.base;
  if (!cwd || !base) return;
  const viewed = getViewed(context, base);
  const files = app.diffTree.visibleFiles(cwd).filter((f) => isViewed(cwd, viewed, f)); // only the filtered slice
  if (!files.length) {
    vscode.window.showInformationMessage('No viewed files to stage.');
    return;
  }
  try {
    await gitAddChunked(cwd, files);
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
    await gitAddChunked(cwd, rels);
  } catch (e) {
    vscode.window.showErrorMessage(`git add failed: ${e.message}`);
    return;
  }
  vscode.window.setStatusBarMessage(`Staged ${rels.length} file(s). Commit in Source Control.`, 2500);
}

async function unstageFiles(context, item, sel) {
  const cwd = getCwd();
  const rels = selectedRels(item, sel);
  if (!cwd || !rels.length) return;
  try {
    for (let i = 0; i < rels.length; i += 100) await git(cwd, ['restore', '--staged', '--', ...rels.slice(i, i + 100)]);
  } catch (e) {
    vscode.window.showErrorMessage(`git restore --staged failed: ${e.message}`);
    return;
  }
  vscode.window.setStatusBarMessage(`Unstaged ${rels.length} file(s).`, 2500);
}

/** Discard the selected files' changes — restore to HEAD (untracked files are deleted). */
async function revertFiles(context, item, sel) {
  const cwd = getCwd();
  const rels = selectedRels(item, sel);
  if (!cwd || !rels.length) return;
  const what = rels.length === 1 ? `"${rels[0]}"` : `${rels.length} files`;
  // Name the deletions only when the selection actually holds untracked files. Warning about
  // deletion every time trains the user to skim past it, so it stops carrying weight on the runs
  // where a file really does get deleted rather than reverted.
  const untracked = rels.filter((r) => app.diffTree?.status.get(r) === 'U').length;
  const delNote = untracked
    ? ` ${untracked === 1 ? '1 untracked file' : `${untracked} untracked files`} will be DELETED.`
    : '';
  const ok = await vscode.window.showWarningMessage(
    `Discard changes to ${what}?${delNote} This cannot be undone.`,
    { modal: true },
    'Discard'
  );
  if (ok !== 'Discard') return;
  for (const rel of rels) {
    try {
      if (app.diffTree?.status.get(rel) === 'U') {
        await vscode.workspace.fs.delete(vscode.Uri.file(path.join(cwd, rel))); // untracked → delete
      } else {
        await git(cwd, ['restore', '--source=HEAD', '--staged', '--worktree', '--', rel]);
      }
    } catch (e) {
      vscode.window.showErrorMessage(`Revert failed for ${rel}: ${e.message}`);
    }
  }
  await app.diffTree.load();
}

/** Restore file(s) to the content you last marked viewed (the review snapshot). The restored
 *  content hashes back to the mark, so the file flips back to Viewed automatically. */
async function revertToViewed(context, item, sel) {
  const cwd = getCwd();
  const base = app.diffTree?.base;
  const rels = selectedRels(item, sel);
  if (!cwd || !base || !rels.length) return;
  const viewed = getViewed(context, base);
  const withSnap = rels.filter((r) => reviewedBlob(viewed, r));
  if (!withSnap.length) {
    vscode.window.showInformationMessage('No last-viewed snapshot for the selection.');
    return;
  }
  const what = withSnap.length === 1 ? `"${withSnap[0]}"` : `${withSnap.length} files`;
  const ok = await vscode.window.showWarningMessage(
    `Restore ${what} to the last-viewed content? Edits made since your review will be lost.`,
    { modal: true },
    'Restore'
  );
  if (ok !== 'Restore') return;
  for (const rel of withSnap) {
    try {
      const bytes = await gitBlobBytes(cwd, reviewedBlob(viewed, rel));
      await vscode.workspace.fs.writeFile(vscode.Uri.file(path.join(cwd, rel)), bytes);
    } catch (e) {
      vscode.window.showErrorMessage(`Restore failed for ${rel}: ${e.message}`);
    }
  }
  // Sync the index: a staged copy of the pre-revert content would keep Source Control showing
  // phantom changes after the restore — re-add so the index matches the restored content.
  try {
    const out = await git(cwd, ['diff', '--cached', '--name-only', '--', ...withSnap]);
    const resync = out.split('\n').map((s) => s.trim()).filter(Boolean);
    if (resync.length) await gitAddChunked(cwd, resync);
  } catch { /* best-effort */ }
  await stageOnView(context, cwd, withSnap);
  await app.diffTree.load();
}

/** Flip the stage-on-view setting (marking viewed also stages the file). */
async function toggleStageOnView() {
  const cfg = vscode.workspace.getConfiguration('vetty');
  const next = !cfg.get('stageOnView', false);
  await cfg.update('stageOnView', next, vscode.ConfigurationTarget.Global);
  vscode.window.setStatusBarMessage(`Stage on View ${next ? 'enabled' : 'disabled'}`, 2500);
}

module.exports = { stageViewed, stageFiles, unstageFiles, revertFiles, revertToViewed, toggleStageOnView };
