// Entry point: wires the shared refs and registers everything. The behavior lives in src/:
//   core.js     — git/gh plumbing, persisted review state, base-branch memory + inference
//   tree.js     — DiffTree/TodoTree views, decorations, open/navigate/toggle behaviors
//   search.js   — the Search webview + scoped in-panel text search
//   comments.js — inline review comments + the GitHub PR review flow
//   commands.js — command handlers (pickers, bulk opens, staging, groups, viewed/ignored)
const vscode = require('vscode');
const core = require('./src/core');
const { app } = core;
const tree = require('./src/tree');
const search = require('./src/search');
const comments = require('./src/comments');
const cmds = require('./src/commands');

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  app.context = context;
  core.updateDebugFlag();
  app.diffTree = new tree.DiffTree(context);
  app.todoTree = new tree.TodoTree(context);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(core.BASE_SCHEME, core.baseContentProvider),
    vscode.workspace.registerTextDocumentContentProvider(core.BLOB_SCHEME, core.blobContentProvider),
    vscode.window.registerFileDecorationProvider(tree.fileDecorations),
    vscode.window.registerWebviewViewProvider('vettySearch', new search.SearchView()),
    (app.diffTreeView = vscode.window.createTreeView('vettyView', { treeDataProvider: app.diffTree, canSelectMany: true })),
    (app.todoTreeView = vscode.window.createTreeView('vettyTodos', { treeDataProvider: app.todoTree, canSelectMany: true })),
    (app.commentsTreeView = vscode.window.createTreeView('vettyComments', {
      treeDataProvider: (app.commentsTree = new comments.CommentsTree(context)),
      canSelectMany: true,
    })),
    vscode.commands.registerCommand('vetty.commentGoTo', (rel, line, anchor) => comments.commentGoTo(rel, line, anchor)),
    vscode.commands.registerCommand('vetty.commentOpen', (item) => comments.commentOpen(context, item)),
    vscode.commands.registerCommand('vetty.commentEdit', (item) => comments.commentEdit(context, item)),
    vscode.commands.registerCommand('vetty.commentCopy', (item, sel) => comments.commentCopy(context, item, sel)),
    vscode.commands.registerCommand('vetty.copySection', (item) => comments.copySection(context, item)),
    vscode.commands.registerCommand('vetty.commentDelete', (item, sel) => comments.commentDelete(context, item, sel)),
    vscode.commands.registerCommand('vetty.openTodo', (rel, line) => tree.openTodo(rel, line)),
    vscode.commands.registerCommand('vetty.copyTodos', () => tree.copyTodos()),
    vscode.commands.registerCommand('vetty.todoOpenItem', (item) => tree.todoOpenItem(item)),
    vscode.commands.registerCommand('vetty.todoCopyItems', (item, sel) => tree.todoCopyItems(item, sel)),
    vscode.commands.registerCommand('vetty.exportTodos', () => tree.exportTodos()),
    vscode.commands.registerCommand('vetty.openMatch', (rel, line, col, len) => tree.openMatch(rel, line, col, len)),
    vscode.commands.registerCommand('vetty.openAll', () => cmds.openAll(context)),
    vscode.commands.registerCommand('vetty.openUnviewed', () => cmds.openByViewed(context, false)),
    vscode.commands.registerCommand('vetty.openViewed', () => cmds.openByViewed(context, true)),
    vscode.commands.registerCommand('vetty.toggleViewed', () => cmds.applyViewed(context)),
    vscode.commands.registerCommand('vetty.markViewed', () => cmds.applyViewed(context, true)),
    vscode.commands.registerCommand('vetty.unmarkViewed', () => cmds.applyViewed(context, false)),
    vscode.commands.registerCommand('vetty.clearViewed', () => cmds.clearViewed(context)),
    // Tree (Activity Bar) commands.
    vscode.commands.registerCommand('vetty.treePickBranch', () => cmds.treePickBranch(context)),
    vscode.commands.registerCommand('vetty.treeRefresh', () => app.diffTree.load()),
    vscode.commands.registerCommand('vetty.treeOpenUnviewed', () => cmds.treeOpenUnviewed(context)),
    vscode.commands.registerCommand('vetty.treeOpenFile', (item, sel) => cmds.treeOpenFile(item, sel)),
    vscode.commands.registerCommand('vetty.treeOpenDiff', (item, sel) => cmds.treeOpenDiff(item, sel)),
    vscode.commands.registerCommand('vetty.treeView', (item, sel) => cmds.treeSetViewed(context, item, sel, true)),
    vscode.commands.registerCommand('vetty.treeUnview', (item, sel) => cmds.treeSetViewed(context, item, sel, false)),
    // Same handlers, stage-on-view titles ("View & Stage") — menus swap on config.vetty.stageOnView.
    vscode.commands.registerCommand('vetty.treeViewStage', (item, sel) => cmds.treeSetViewed(context, item, sel, true)),
    vscode.commands.registerCommand('vetty.treeUnviewStage', (item, sel) => cmds.treeSetViewed(context, item, sel, false)),
    vscode.commands.registerCommand('vetty.treeIgnore', (item, sel) => cmds.treeSetIgnored(context, item, sel, true)),
    vscode.commands.registerCommand('vetty.treeUnignore', (item, sel) => cmds.treeSetIgnored(context, item, sel, false)),
    vscode.commands.registerCommand('vetty.viewAsTree', () => tree.toggleNesting(context)),
    vscode.commands.registerCommand('vetty.viewAsList', () => tree.toggleNesting(context)),
    vscode.commands.registerCommand('vetty.diffSinceCommit', () => tree.toggleRange(context)),
    vscode.commands.registerCommand('vetty.diffWholeBranch', () => tree.toggleRange(context)),
    vscode.commands.registerCommand('vetty.sinceReviewOn', () => tree.toggleSinceReview(context)),
    vscode.commands.registerCommand('vetty.sinceReviewOff', () => tree.toggleSinceReview(context)),
    vscode.commands.registerCommand('vetty.guidedReviewOn', () => tree.toggleGuidedReview(context)),
    vscode.commands.registerCommand('vetty.guidedNotesExpand', () => tree.toggleGuidedNotes(context)),
    vscode.commands.registerCommand('vetty.guidedNotesCollapse', () => tree.toggleGuidedNotes(context)),
    vscode.commands.registerCommand('vetty.guidedReviewOff', () => tree.toggleGuidedReview(context)),
    vscode.commands.registerCommand('vetty.copyPaths', () => cmds.copyPaths()),
    vscode.commands.registerCommand('vetty.showMore', (key) => tree.showMore(key)),
    vscode.commands.registerCommand('vetty.fetch', () => cmds.fetchAndRefresh(context)),
    vscode.commands.registerCommand('vetty.pickFolder', () => cmds.pickFolder(context)),
    vscode.commands.registerCommand('vetty.reviewPr', () => comments.reviewPr(context)),
    vscode.commands.registerCommand('vetty.finishReview', () => comments.finishReview(context)),
    vscode.commands.registerCommand('vetty.submitReview', () => comments.submitReview(context)),
    vscode.commands.registerCommand('vetty.pullPrComments', () => comments.pullPrComments()),
    vscode.commands.registerCommand('vetty.nextUnviewed', () => tree.navigateUnviewed(context, 1)),
    vscode.commands.registerCommand('vetty.prevUnviewed', () => tree.navigateUnviewed(context, -1)),
    vscode.commands.registerCommand('vetty.viewCurrent', () => cmds.applyViewed(context)),
    vscode.commands.registerCommand('vetty.togglePrMode', () => comments.togglePrMode()),
    vscode.commands.registerCommand('vetty.stageViewed', () => cmds.stageViewed(context)),
    vscode.commands.registerCommand('vetty.stageFile', (item, sel) => cmds.stageFiles(context, item, sel)),
    vscode.commands.registerCommand('vetty.unstageFile', (item, sel) => cmds.unstageFiles(context, item, sel)),
    vscode.commands.registerCommand('vetty.addToGroup', (item, sel) => cmds.addToGroup(context, item, sel)),
    vscode.commands.registerCommand('vetty.removeFromGroup', (item, sel) => cmds.removeFromGroup(context, item, sel)),
    vscode.commands.registerCommand('vetty.stageGroup', () => cmds.stageGroup(context)),
    vscode.commands.registerCommand('vetty.markGroupViewed', () => cmds.markGroupViewed(context)),
    vscode.commands.registerCommand('vetty.openGroup', () => cmds.openGroup(context)),
    vscode.commands.registerCommand('vetty.ungroup', () => cmds.ungroup(context)),
    vscode.commands.registerCommand('vetty.clearGroups', () => cmds.clearGroups(context)),
    vscode.commands.registerCommand('vetty.collapseAll', () => tree.collapseFolders()),
    vscode.commands.registerCommand('vetty.expandAll', () => tree.expandAll()),
    vscode.commands.registerCommand('vetty.hideWhitespace', () => tree.toggleWhitespace(context)),
    vscode.commands.registerCommand('vetty.showWhitespace', () => tree.toggleWhitespace(context)),
    vscode.commands.registerCommand('vetty.revertFile', (item, sel) => cmds.revertFiles(context, item, sel)),
    vscode.commands.registerCommand('vetty.revertToViewed', (item, sel) => cmds.revertToViewed(context, item, sel)),
    vscode.commands.registerCommand('vetty.toggleStageOnView', () => cmds.toggleStageOnView()),
    vscode.commands.registerCommand('vetty.showDebugLog', () => core.showDebugLog()),
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration('vetty.debug')) core.updateDebugFlag();
      if (e.affectsConfiguration('vetty.ignorePatterns')) {
        core.resetIgnorePatterns();
        app.diffTree.load(); // regroup with the new patterns
      }
      if (!e.affectsConfiguration('vetty.pullRequests.enabled')) return;
      await core.updatePrMode();
      // Disabling mid-review → clean up the checkout so the user isn't stranded on the PR branch.
      if (!core.prEnabled() && context.workspaceState.get(core.REVIEW_KEY)) await comments.finishReview(context);
    }),
    vscode.commands.registerCommand('vetty.treeOpenGroup', (item) => cmds.treeOpenGroup(item)),
    vscode.commands.registerCommand('vetty.treeMarkAllViewed', (item) => cmds.treeMarkAllViewed(context, item)),
    vscode.commands.registerCommand('vetty.treeMarkAllUnviewed', (item) => cmds.treeMarkAllUnviewed(context, item)),
    vscode.window.onDidChangeActiveTextEditor(() => core.updateViewedContext(context)),
    vscode.workspace.onDidSaveTextDocument(() => {
      core.updateViewedContext(context);
      core.refreshTree();
      app.todoTree.load();
    })
  );
  // Review comments: register the comment controller, hydrate stored comments as editors open.
  comments.initComments(context);

  vscode.commands.executeCommand('setContext', 'vetty.nested', app.diffTree.nested);
  vscode.commands.executeCommand('setContext', 'vetty.diffRange', core.diffRange(context));
  vscode.commands.executeCommand('setContext', 'vetty.sinceReview', core.sinceReviewOn(context));
  vscode.commands.executeCommand('setContext', 'vetty.guidedReview', core.guidedReviewOn(context));
  vscode.commands.executeCommand('setContext', 'vetty.guidedNotesExpanded', core.guidedNotesExpanded(context));
  vscode.commands.executeCommand('setContext', 'vetty.hideWhitespace', app.diffTree.hideWhitespace);
  vscode.commands.executeCommand('setContext', 'vetty.reviewing', !!context.workspaceState.get(core.REVIEW_KEY));
  comments.updatePrTitle(context);

  (async () => {
    // Resolve the repo toplevel first — it can sit ABOVE the opened folder (workspace = subdir of
    // the repo), and every git path join depends on it.
    await core.resolveRepoRoot();
    // Auto-refresh: react to git state (checkout/pull/commit) AND any working-tree edit, including
    // files written outside the editor (e.g. an AI tool editing files directly, no save event).
    const cwd = core.getCwd();
    if (cwd) {
      let timer = null;
      app.bumpReload = (uri) => {
        if (uri) core.dbg(`watch → reload: ${uri.fsPath ?? uri}`); // churn attribution
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => app.diffTree.load(), 400); // load() re-resolves the base (handles branch switches)
      };
      core.watchGitDir(context, app.bumpReload);
      // Working files, all roots. VS Code applies files.watcherExclude (node_modules, etc.) automatically.
      const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*');
      // ...but its default excludes cover .git/objects only, NOT refs, logs, or index. Every git
      // command writes some of those, so without this filter a reload schedules another reload.
      // The .git files that genuinely matter are watchGitDir's job (HEAD, ORIG_HEAD, index).
      const bumpWorkingFile = (uri) => {
        const p = (uri?.fsPath ?? String(uri)).replace(/\\/g, '/');
        // Both the contents AND the directory itself. Every git write goes through .git/index.lock,
        // and creating/removing that file mutates the .git DIRECTORY — which VS Code reports as a
        // change to `.../.git`, a path containing no '/.git/' segment. Miss that and the reload
        // loop survives with its index events already suppressed: a different door, same room.
        if (p.includes('/.git/') || p.endsWith('/.git')) return;
        app.bumpReload(uri);
      };
      fileWatcher.onDidChange(bumpWorkingFile);
      fileWatcher.onDidCreate(bumpWorkingFile);
      fileWatcher.onDidDelete(bumpWorkingFile);
      context.subscriptions.push(fileWatcher);
      await core.detectGh(cwd);
      await core.pruneStaleState(context, cwd); // GC stale per-base state (deleted branches)
    }
    await app.diffTree.load(); // resolves the base for the current branch
    core.updateViewedContext(context);
  })();
}

function deactivate() {}

module.exports = { activate, deactivate };
