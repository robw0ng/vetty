// Command handlers: pickers, bulk open flows, viewed/ignored/group mutations, staging, and the
// tree-row actions. Thin glue over core (state) and tree (open behaviors).
const vscode = require('vscode');
const path = require('path');
const core = require('./core');
const {
  app, refreshTree, getCwd, git, gitAddChunked, mergeBaseRef, untrackedFiles,
  getViewed, setViewed, isViewed, viewedEntry, viewedEntries, getIgnored, setIgnored,
  getGroups, setGroups, groupNames, activeRelPath, updateViewedContext,
  currentBranch, localBranches, aheadBehind, setBaseFor, lastBranch,
  MAX_REL_BRANCHES, PARENT_MAX_AHEAD, MAX_OPEN_WITHOUT_CONFIRM, FOLDER_KEY,
  workspaceFolderPath, resolveRepoRoot, watchGitDir, detectGh, hashCache, baseUriFor,
} = core;
const { openOneDiff, openReviewFile, openNextUnviewed } = require('./tree');

/** Multi-root: pick which workspace folder Vetty reviews. Remembered per workspace. */
async function pickFolder(context) {
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length < 2) {
    vscode.window.showInformationMessage('Only one workspace folder open.');
    return;
  }
  const cur = workspaceFolderPath();
  const pick = await vscode.window.showQuickPick(
    folders.map((f) => ({
      label: f.name,
      description: f.uri.fsPath === cur ? 'current' : '',
      detail: f.uri.fsPath,
      fsPath: f.uri.fsPath,
    })),
    { placeHolder: 'Vetty reviews which folder?' }
  );
  if (!pick) return;
  await context.workspaceState.update(FOLDER_KEY, pick.fsPath);
  await resolveRepoRoot();
  // ponytail: viewed/ignored/groups keys are per-base-NAME, not per-repo — two repos sharing a
  // branch name share marks. Key by repo root if that ever bites.
  hashCache.clear();
  watchGitDir(context, app.bumpReload);
  await detectGh(getCwd());
  await app.diffTree.load();
}

/** Branch picker — local branches, labeled by their relationship to the current branch (parent /
 *  ancestor / descendant / diverged), with the inferred direct parent surfaced first. */
async function pickBranch(context, cwd) {
  const last = lastBranch(context);
  const itemsPromise = (async () => {
    const cur = await currentBranch(cwd);
    const others = (await localBranches(cwd)).filter((n) => n !== cur);
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

    // Direct parent = the closest ancestor, but only if it's reasonably near (else it's just an old
    // merged branch the current branch contains — not a base).
    const parent = items.filter((i) => i.rank === 1).sort((a, b) => a.ahead - b.ahead)[0];
    if (parent && parent.ahead <= PARENT_MAX_AHEAD) {
      parent.description = `parent · ${parent.ahead} ahead`;
      parent.rank = 0;
    }
    // Sort by bucket; within ancestors/parent, nearest first (fewest commits ahead) = stack order.
    items.sort((a, b) => a.rank - b.rank || a.ahead - b.ahead);
    // Always offer the current branch (= uncommitted working changes) so single-branch repos / being
    // on the base branch still have something to pick.
    if (cur) items.push({ label: cur, description: 'current · working changes', branch: cur, rank: 99, ahead: Infinity });
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
  await setBaseFor(context, await currentBranch(cwd), base); // remember per current branch
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
  const checked = labels.filter((l) => l !== ALL_UNVIEWED);
  // "All unviewed" + individually checked files = the union (don't drop the extras).
  const files = labels.includes(ALL_UNVIEWED) ? [...new Set([...unviewed, ...checked])] : checked;
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

/** Repo-relative paths from a tree action: the multi-selection if present, else the clicked row. */
function selectedRels(item, sel) {
  const items = Array.isArray(sel) && sel.length ? sel : item ? [item] : [];
  return items.map((i) => (typeof i === 'string' ? i : i?.rel)).filter(Boolean);
}

/** Ctrl+C in the Review tree: copy selected file paths (folders/groups expand to their files). */
async function copyPaths() {
  const rels = [];
  for (const it of app.diffTreeView?.selection || []) {
    if (it.rel) rels.push(it.rel);
    else if (Array.isArray(it.files)) rels.push(...it.files);
  }
  if (!rels.length) return;
  await vscode.env.clipboard.writeText([...new Set(rels)].join('\n'));
  vscode.window.setStatusBarMessage(`Copied ${new Set(rels).size} path(s)`, 2000);
}

// Explorer-style: single click previews (reused tab), double-click (same row, fast) pins it.
let lastRowClick = { rel: null, t: 0 };
function clickPreview(rel) {
  const now = Date.now();
  const dbl = rel === lastRowClick.rel && now - lastRowClick.t < 500;
  lastRowClick = { rel, t: now };
  return !dbl; // single → preview; double → pinned (non-preview)
}

async function treeOpenFile(item, sel) {
  const cwd = getCwd();
  const rels = selectedRels(item, sel);
  if (!cwd || !rels.length) return;
  const preview = rels.length === 1 ? clickPreview(rels[0]) : false; // multiple → keep them all open
  await Promise.all(
    rels.map((rel) =>
      vscode.window.showTextDocument(vscode.Uri.file(path.join(cwd, rel)), { preview, preserveFocus: !preview })
    )
  );
}

async function treeOpenDiff(item, sel) {
  const cwd = getCwd();
  const base = app.diffTree?.base;
  const rels = selectedRels(item, sel);
  if (!cwd || !base || !rels.length) return;
  const single = rels.length === 1;
  const opts = { preview: single ? clickPreview(rels[0]) : false, preserveFocus: !single };
  await Promise.all(rels.map((rel) => openOneDiff(app.context, cwd, base, rel, opts)));
}

async function treeSetViewed(context, item, sel, makeViewed) {
  const cwd = getCwd();
  const base = app.diffTree?.base;
  const rels = selectedRels(item, sel);
  if (!cwd || !base || !rels.length) return;
  const viewed = getViewed(context, base);
  if (makeViewed) Object.assign(viewed, await viewedEntries(cwd, rels));
  else for (const rel of rels) delete viewed[rel];
  await setViewed(context, base, viewed);
  updateViewedContext(context);
  refreshTree();
  // Auto-advance: marking a single file viewed opens the next unviewed one.
  if (makeViewed && rels.length === 1) await openNextUnviewed(context, base, cwd, rels[0]);
}

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
  Object.assign(viewed, await viewedEntries(cwd, filesInGroups(getGroups(context, base), names)));
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
      await app.diffTree.load();
    }
  );
}

/** Open every file in a tree group (Unviewed / Viewed / Untracked) via the shared open flow. */
async function treeOpenGroup(item) {
  const cwd = getCwd();
  const base = app.diffTree?.base;
  if (!cwd || !base || !item?.files?.length) return;
  await openFiles(cwd, base, item.files);
}

async function treeMarkAllViewed(context, item) {
  const cwd = getCwd();
  const base = app.diffTree?.base;
  if (!cwd || !base || !item?.files) return;
  const viewed = getViewed(context, base);
  Object.assign(viewed, await viewedEntries(cwd, item.files));
  await setViewed(context, base, viewed);
  updateViewedContext(context);
  refreshTree();
}

async function treeMarkAllUnviewed(context, item) {
  const base = app.diffTree?.base;
  if (!base || !item?.files) return;
  const viewed = getViewed(context, base);
  for (const rel of item.files) delete viewed[rel];
  await setViewed(context, base, viewed);
  updateViewedContext(context);
  refreshTree();
}

async function treeSetIgnored(context, item, sel, makeIgnored) {
  const base = app.diffTree?.base;
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
  if (base) await app.diffTree.load();
}

async function treeOpenUnviewed(context) {
  const cwd = getCwd();
  const base = app.diffTree?.base;
  if (!cwd || !base) {
    vscode.window.showInformationMessage('Pick a branch first (the branch button above).');
    return;
  }
  const viewed = getViewed(context, base);
  const files = app.diffTree.files.filter((f) => !isViewed(cwd, viewed, f));
  await openFiles(cwd, base, files);
}

module.exports = {
  pickFolder, pickBranch, changedFiles, openFiles, openAll, openByViewed,
  applyViewed, clearViewed, selectedRels, copyPaths,
  treeOpenFile, treeOpenDiff, treeSetViewed, treeSetIgnored,
  stageViewed, stageFiles, addToGroup, removeFromGroup,
  stageGroup, markGroupViewed, openGroup, ungroup, clearGroups,
  fetchAndRefresh, treeOpenGroup, treeMarkAllViewed, treeMarkAllUnviewed,
  treePickBranch, treeOpenUnviewed,
};
