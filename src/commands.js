// Command handlers: folder/branch pickers, bulk open flows, viewed/ignored mutations, and the
// tree-row actions. Thin glue over core (state) and review-nav (open behaviors).
const vscode = require('vscode');
const path = require('path');
const core = require('./core');
const {
  app, refreshTree, getCwd, git, stageOnView, unstageOnUnview, mergeBaseRef, untrackedFiles,
  getViewed, setViewed, isViewed, viewedEntry, viewedEntries, getIgnored, setIgnored,
  activeRelPath, updateViewedContext, currentBranch, setBaseFor, lastBranch,
  MAX_OPEN_WITHOUT_CONFIRM, FOLDER_KEY, workspaceFolderPath, resolveRepoRoot, watchGitDir, detectGh, hashCache, baseUriFor,
} = core;
const { openOneDiff, atFirstComment } = require('./review-nav');
const { pickBranchTree, pickBranchList } = require('./branchpick');


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
  hashCache.clear(); // keyed by bare rel — another folder's same-named file must not hit it (marks themselves are keyed by repo path + branch)
  watchGitDir(context, app.bumpReload);
  await detectGh(getCwd());
  await app.diffTree.load();
}

/** Branch picker: the terminal-picker-style tree webview, with the flat QuickPick as the fallback if
 *  the tree can't be built (odd repos: unborn HEAD, no reflog). Both live in src/branchpick.js. */
async function pickBranch(context, cwd) {
  let base;
  try {
    base = await pickBranchTree(context, cwd);
  } catch (e) {
    core.dbg(`tree picker failed, falling back to the list: ${e.message}`);
    base = await pickBranchList(context, cwd);
  }
  if (!base) return null;
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
    vscode.window.showInformationMessage('Pick a base branch first via "Vetty: Change Base Branch".');
    return;
  }
  const rel = activeRelPath(cwd);
  if (!rel) {
    vscode.window.showInformationMessage('No file in the active editor.');
    return;
  }
  const viewed = getViewed(context, base);
  const next = makeViewed === undefined ? !isViewed(cwd, viewed, rel) : makeViewed;
  if (next) { viewed[rel] = await viewedEntry(cwd, rel); await stageOnView(context, cwd, [rel]); }
  else { delete viewed[rel]; await unstageOnUnview(cwd, [rel]); }
  await setViewed(context, base, viewed);
  updateViewedContext(context);
  refreshTree();
  vscode.window.setStatusBarMessage(`${next ? 'Marked viewed' : 'Unmarked'} (vs ${base}): ${rel}`, 2500);
  // No auto-advance anywhere: marking viewed never yanks you to another file; j/k or click to proceed.
  if (base === app.diffTree?.base) app.diffTree.revealFile(rel);
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
      vscode.window.showTextDocument(vscode.Uri.file(path.join(cwd, rel)), atFirstComment(app.context, rel, { preview, preserveFocus: !preview }))
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
  if (makeViewed) { Object.assign(viewed, await viewedEntries(cwd, rels)); await stageOnView(context, cwd, rels); }
  else { for (const rel of rels) delete viewed[rel]; await unstageOnUnview(cwd, rels); }
  await setViewed(context, base, viewed);
  updateViewedContext(context);
  refreshTree();
  // No auto-advance: the row stays selected in its new group (like staging); j/k or click to proceed.
  if (rels.length === 1) app.diffTree.revealFile(rels[0]);
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

async function treeMarkAllViewed(context, item) {
  const cwd = getCwd();
  const base = app.diffTree?.base;
  if (!cwd || !base || !item?.files) return;
  const viewed = getViewed(context, base);
  Object.assign(viewed, await viewedEntries(cwd, item.files));
  await stageOnView(context, cwd, item.files);
  await setViewed(context, base, viewed);
  updateViewedContext(context);
  refreshTree();
}

async function treeMarkAllUnviewed(context, item) {
  const cwd = getCwd();
  const base = app.diffTree?.base;
  if (!base || !item?.files) return;
  const viewed = getViewed(context, base);
  for (const rel of item.files) delete viewed[rel];
  if (cwd) await unstageOnUnview(cwd, item.files);
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
  if (!makeIgnored) {
    const stuck = rels.filter((r) => core.ignoredByPattern(r));
    if (stuck.length)
      vscode.window.showInformationMessage(
        `${stuck.length === 1 ? `"${stuck[0]}" matches` : `${stuck.length} files match`} vetty.ignorePatterns — edit the setting to track.`
      );
  }
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
  treeOpenFile, treeOpenDiff, treeSetViewed, treeSetIgnored, fetchAndRefresh,
  treeMarkAllViewed, treeMarkAllUnviewed, treePickBranch, treeOpenUnviewed,
};
