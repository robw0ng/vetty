// Groups: a per-branch { relPath: groupName } map — bucket changed files by intent and stage, open
// or mark a bucket at a time (a lightweight, working-copy-only changelist).
const vscode = require('vscode');
const {
  app, refreshTree, getCwd, gitAddChunked, stageOnView, getViewed, setViewed, isViewed, viewedEntries,
  getGroups, setGroups, groupNames, updateViewedContext, MAX_OPEN_WITHOUT_CONFIRM,
} = require('./core');
const { selectedRels, openFiles } = require('./commands');
const { openReviewFile } = require('./review-nav');

/** Assign the selected file(s) to a group (pick an existing one or name a new one). */
async function addToGroup(context, item, sel) {
  const base = app.diffTree?.base;
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
  const base = app.diffTree?.base;
  const rels = selectedRels(item, sel);
  if (!base || !rels.length) return;
  const groups = getGroups(context, base);
  for (const r of rels) delete groups[r];
  await setGroups(context, base, groups);
  refreshTree();
}

/** Group names to act on: the checked groups in the dropdown, else prompt for one. null = cancel/none. */
async function targetGroupNames(context, placeHolder) {
  const base = app.diffTree?.base;
  const names = groupNames(getGroups(context, base));
  if (!names.length) {
    vscode.window.showInformationMessage('No groups yet — right-click files → Add to Group.');
    return null;
  }
  if (app.diffTree.groupFilter && app.diffTree.groupFilter.length) return app.diffTree.groupFilter; // act on checked groups
  const one = await vscode.window.showQuickPick(names, { placeHolder });
  return one ? [one] : null;
}
const filesInGroups = (map, names) => Object.keys(map).filter((r) => names.includes(map[r]));
const groupsTitle = (names) => (names.length === 1 ? `"${names[0]}"` : `${names.length} groups`);

/** Stage every file in the target group(s) (then commit it in Source Control). */
async function stageGroup(context) {
  const cwd = getCwd();
  const base = app.diffTree?.base;
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
    await gitAddChunked(cwd, files);
  } catch (e) {
    vscode.window.showErrorMessage(`git add failed: ${e.message}`);
    return;
  }
  vscode.window.setStatusBarMessage(`Staged ${groupsTitle(names)} (${files.length} file(s)). Commit in Source Control.`, 3000);
}

/** Mark every file in the target group(s) viewed. */
async function markGroupViewed(context) {
  const cwd = getCwd();
  const base = app.diffTree?.base;
  if (!cwd || !base) return;
  const names = await targetGroupNames(context, 'Mark which group viewed?');
  if (!names) return;
  const viewed = getViewed(context, base);
  const groupFiles = filesInGroups(getGroups(context, base), names);
  Object.assign(viewed, await viewedEntries(cwd, groupFiles));
  await stageOnView(context, cwd, groupFiles);
  await setViewed(context, base, viewed);
  updateViewedContext(context);
  refreshTree();
}

/** Open every file in the target group(s) (honors the active diff mode). */
async function openGroup(context) {
  const cwd = getCwd();
  const base = app.diffTree?.base;
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
  const base = app.diffTree?.base;
  if (!base) return;
  const names = await targetGroupNames(context, 'Ungroup which group?');
  if (!names) return;
  const groups = getGroups(context, base);
  for (const r of Object.keys(groups)) if (names.includes(groups[r])) delete groups[r];
  if (app.diffTree.groupFilter) app.diffTree.groupFilter = app.diffTree.groupFilter.filter((n) => !names.includes(n));
  await setGroups(context, base, groups);
  refreshTree();
}

async function clearGroups(context) {
  const base = app.diffTree?.base;
  if (!base) return;
  await setGroups(context, base, {});
  app.diffTree.groupFilter = null;
  refreshTree();
}

/** Open every file in a tree group (Unviewed / Viewed / Ignored) via the shared open flow. */
async function treeOpenGroup(item) {
  const cwd = getCwd();
  const base = app.diffTree?.base;
  if (!cwd || !base || !item?.files?.length) return;
  await openFiles(cwd, base, item.files);
}

module.exports = { addToGroup, removeFromGroup, stageGroup, markGroupViewed, openGroup, ungroup, clearGroups, treeOpenGroup };
