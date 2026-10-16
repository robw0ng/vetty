// Local review comments: PR-style inline threads persisted in workspaceState, the comment controller
// they live in, and the editor-side create/edit/delete/copy actions. Owns the live local threads.
const vscode = require('vscode');
const path = require('path');
const { lineRef } = require('../lib');
const {
  app, refreshTree, getCwd, git, stateScope, getViewed, setViewed, isViewed, unstageOnUnview, updateViewedContext,
} = require('./core');

// Scoped per repo+branch like viewed marks: global comments leaked across sibling branches, and
// re-anchoring/persisting from the wrong branch's content corrupted their stored positions.
function commentsKey() {
  return `vetty.comments.${stateScope('')}`;
}
let commentController = null;
const threads = []; // live local threads
const builtDocs = new Set(); // uri.toString() already hydrated this session

function controller() {
  return commentController;
}
function localThreads() {
  return threads;
}
function getComments(context) {
  return context.workspaceState.get(commentsKey()) || {};
}

/** Comments = request changes (stage-on-view mode): commenting on a viewed file unstages it.
 *  Deleting/resolving comments never auto-stages — staging comes back only via an explicit
 *  (re-)view, and stageOnView itself skips files that still have open comments. */
async function unstageForComment(context, rel) {
  if (!rel || !vscode.workspace.getConfiguration('vetty').get('stageOnView', false)) return;
  const cwd = getCwd();
  const base = app.diffTree?.base;
  if (!cwd || !base) return;
  if (!isViewed(cwd, getViewed(context, base), rel)) return;
  try {
    await git(cwd, ['restore', '--staged', '--', rel]);
  } catch { /* best-effort */ }
  refreshTree();
}

/** Stage-on-view mode: resolving a file's LAST comment re-opens the verdict — the file returns to
 *  Unviewed, so the next explicit view is the approval that stages it. */
async function unviewOnCommentResolve(context, rels) {
  if (!vscode.workspace.getConfiguration('vetty').get('stageOnView', false)) return;
  const cwd = getCwd();
  const base = app.diffTree?.base;
  if (!cwd || !base) return;
  const map = getComments(context);
  const viewed = getViewed(context, base);
  const drop = [...new Set(rels)].filter((r) => r && !(map[r] || []).length && viewed[r] !== undefined);
  if (!drop.length) return;
  for (const rel of drop) delete viewed[rel];
  await setViewed(context, base, viewed);
  await unstageOnUnview(cwd, drop); // usually already unstaged — keeps unview ⇒ unstage symmetric
  updateViewedContext(context);
  refreshTree();
}

function relOf(cwd, uri) {
  if (uri.scheme !== 'file') return null;
  const rel = path.relative(cwd, uri.fsPath);
  if (!rel || rel.startsWith('..')) return null;
  return rel.split(path.sep).join('/');
}
function makeComment(text) {
  // contextValue 'editable' gates the Edit/Delete buttons (PR-pulled comments omit it → read-only).
  return { body: new vscode.MarkdownString(text), mode: vscode.CommentMode.Preview, author: { name: 'Comment' }, contextValue: 'editable' };
}
function bodyText(c) {
  return typeof c.body === 'string' ? c.body : c.body.value;
}

/** Reserialize all live threads back to workspaceState. `anchor` = the start line's text, so the
 *  comment can re-find its line if the file is later rewritten (e.g. by an AI edit). */
async function persistComments(context) {
  const cwd = getCwd();
  const map = {};
  for (const t of threads) {
    if (t.isPr) continue; // never persist pulled-from-PR threads as local comments
    const rel = t.dbRel || (cwd && relOf(cwd, t.uri));
    if (!rel || !t.comments.length) continue;
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === t.uri.toString());
    // Refresh the anchor only while the doc is open; keep the last known one otherwise, so a
    // persist while the file's tab is closed doesn't wipe the relocation anchor.
    if (open && t.range.start.line < open.lineCount) t.anchor = open.lineAt(t.range.start.line).text.trim();
    const anchor = t.anchor || '';
    (map[rel] ||= []).push({
      range: [t.range.start.line, t.range.start.character, t.range.end.line, t.range.end.character],
      anchor,
      comments: t.comments.map(bodyText),
    });
  }
  await context.workspaceState.update(commentsKey(), map);
  app.commentsTree?.refresh();
  refreshTree(); // 💬 badges on file rows track comment counts
}

/** Find which line `anchor` is on now — the stored line if unchanged, else the nearest line that matches. */
function relocateLine(doc, storedLine, anchor) {
  if (!anchor) return storedLine; // no/empty anchor → can't relocate reliably
  if (storedLine < doc.lineCount && doc.lineAt(storedLine).text.trim() === anchor) return storedLine;
  for (let d = 1; d < doc.lineCount; d++) {
    const dn = storedLine + d;
    const up = storedLine - d;
    if (dn < doc.lineCount && doc.lineAt(dn).text.trim() === anchor) return dn;
    if (up >= 0 && doc.lineAt(up).text.trim() === anchor) return up;
  }
  return storedLine; // anchor gone (line deleted/changed) → keep original position
}

/** Recreate stored threads for a document the first time it opens this session. */
function hydrateComments(context, doc) {
  const cwd = getCwd();
  if (!commentController || !cwd || doc.uri.scheme !== 'file') return;
  const key = doc.uri.toString();
  if (builtDocs.has(key)) return;
  builtDocs.add(key);
  const rel = relOf(cwd, doc.uri);
  if (!rel) return;
  for (const n of getComments(context)[rel] || []) {
    const start = relocateLine(doc, n.range[0], n.anchor); // re-find the line if the file changed
    const delta = start - n.range[0];
    const range = new vscode.Range(start, n.range[1], n.range[2] + delta, n.range[3]);
    const thread = commentController.createCommentThread(doc.uri, range, n.comments.map(makeComment));
    thread.dbRel = rel;
    thread.anchor = n.anchor; // seed so a later persist with the doc closed keeps it
    thread.contextValue = 'hasComment'; // gates the Delete Comment button (not shown on empty drafts)
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    threads.push(thread);
  }
}

/** Drop every live local thread and rehydrate the open editors from storage. */
function rehydrateAll(context) {
  for (const t of threads) t.dispose();
  threads.length = 0;
  builtDocs.clear();
  for (const ed of vscode.window.visibleTextEditors) hydrateComments(context, ed.document);
  app.commentsTree?.refresh();
}

/** Rewrite storage after a tree-side mutation, then rebuild live threads to match. */
async function saveAndRebuild(context, map) {
  await context.workspaceState.update(commentsKey(), map);
  rehydrateAll(context); // rehydrate from storage so live threads can't resurrect old state
  refreshTree();
}

/** Branch switched: comments are branch-scoped, so drop the old branch's live threads and hydrate
 *  the new branch's for the already-open editors. Called by resolveBase on change. */
function onBranchChanged(context) {
  if (!commentController) return; // activate() not finished yet — initial hydrate covers it
  rehydrateAll(context);
}

async function createComment(context, reply) {
  const thread = reply.thread;
  const cwd = getCwd();
  thread.dbRel = thread.dbRel || (cwd && relOf(cwd, thread.uri));
  thread.comments = [...thread.comments, makeComment(reply.text)];
  thread.contextValue = 'hasComment';
  thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  if (!threads.includes(thread)) threads.push(thread);
  await persistComments(context);
  await unstageForComment(context, thread.dbRel);
}

/** Copy all comments (local + pulled PR) as a paste-ready task list (file:line — comment). */
async function exportComments(context) {
  const cwd = getCwd();
  const comments = getComments(context);
  const lines = [];
  for (const rel of Object.keys(comments)) {
    for (const n of comments[rel] || []) {
      const text = n.comments.join(' / ').replace(/\s+/g, ' ').trim();
      lines.push(`- ${rel}:${lineRef(n.range[0], n.range[2], n.range[3])} — ${text}`);
    }
  }
  for (const t of require('./pr').prThreads()) {
    const rel = cwd && relOf(cwd, t.uri);
    if (!rel) continue;
    const text = t.comments.map(bodyText).join(' / ').replace(/\s+/g, ' ').trim();
    lines.push(`- ${rel}:${t.range.start.line + 1} — ${text}`);
  }
  if (!lines.length) {
    vscode.window.showInformationMessage('No comments to export.');
    return;
  }
  await vscode.env.clipboard.writeText(`Address these review comments:\n\n${lines.join('\n')}\n`);
  vscode.window.showInformationMessage(`Copied ${lines.length} comment(s) to the clipboard.`);
}

async function deleteComment(context, thread) {
  if (thread?.isPr) return require('./pr').dismissPrThreads(context, [thread]);
  if (thread?.isAi) return require('./guided-notes').deleteAiNotes([thread.ai]);
  const cwd = getCwd();
  const rel = thread.dbRel || (cwd && relOf(cwd, thread.uri));
  const i = threads.indexOf(thread);
  if (i >= 0) threads.splice(i, 1);
  thread.dispose();
  await persistComments(context);
  await unviewOnCommentResolve(context, [rel]);
}

/** Reassign a thread's comments array so VS Code re-renders it after a mode/body change. */
function rerenderCommentOf(comment) {
  const thread = threads.find((t) => t.comments.includes(comment));
  if (thread) thread.comments = [...thread.comments];
}
function editComment(comment) {
  if (!comment) return;
  comment.savedBody = comment.body; // for cancel
  comment.mode = vscode.CommentMode.Editing;
  rerenderCommentOf(comment);
}
async function saveComment(context, comment) {
  if (!comment) return;
  comment.mode = vscode.CommentMode.Preview; // body is already the edited value
  delete comment.savedBody;
  rerenderCommentOf(comment);
  await persistComments(context);
}
function cancelEditComment(comment) {
  if (!comment) return;
  if (comment.savedBody !== undefined) comment.body = comment.savedBody;
  delete comment.savedBody;
  comment.mode = vscode.CommentMode.Preview;
  rerenderCommentOf(comment);
}

async function copyComment(comment) {
  if (!comment?.body) return;
  const text = bodyText(comment).replace(/\s+/g, ' ').trim();
  const cwd = getCwd();
  const thread =
    threads.find((t) => t.comments.includes(comment)) ||
    threads.find((t) => t.comments.some((c) => bodyText(c) === bodyText(comment)));
  let line = `- ${text}`;
  if (thread && cwd) {
    const rel = thread.dbRel || relOf(cwd, thread.uri);
    const r = thread.range;
    if (rel) line = `- ${rel}:${lineRef(r.start.line, r.end.line, r.end.character)} — ${text}`; // same format as Export
  }
  await vscode.env.clipboard.writeText(line);
  vscode.window.setStatusBarMessage('Comment copied', 2000);
}

async function clearAllComments(context) {
  const pr = require('./pr');
  if (!threads.length && !pr.prThreads().length && !Object.keys(getComments(context)).length) {
    vscode.window.showInformationMessage('No comments to clear.');
    return;
  }
  const ok = await vscode.window.showWarningMessage(
    'Clear ALL comments (your local notes + pulled PR comments)? This cannot be undone.',
    { modal: true },
    'Clear all'
  );
  if (ok !== 'Clear all') return;
  const rels = Object.keys(getComments(context)); // resolved files drop back to Unviewed below
  for (const t of threads) t.dispose();
  threads.length = 0;
  await context.workspaceState.update(commentsKey(), {});
  pr.clearPrThreads(); // pulled PR comments cleared too
  await unviewOnCommentResolve(context, rels);
  refreshTree(); // update the comment-count badge
  vscode.window.showInformationMessage('Cleared all comments.');
}

/** Register the comment controller + comment commands, and hydrate stored comments as editors open. */
function initComments(context) {
  const guidedNotes = require('./guided-notes');
  commentController = vscode.comments.createCommentController('vetty.comments', 'Vetty Comments');
  commentController.commentingRangeProvider = {
    provideCommentingRanges(doc) {
      return doc.uri.scheme === 'file' ? [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)] : [];
    },
  };
  context.subscriptions.push(
    commentController,
    vscode.commands.registerCommand('vetty.createComment', (reply) => createComment(context, reply)),
    vscode.commands.registerCommand('vetty.deleteComment', (thread) => deleteComment(context, thread)),
    vscode.commands.registerCommand('vetty.exportComments', () => exportComments(context)),
    vscode.commands.registerCommand('vetty.clearComments', () => clearAllComments(context)),
    vscode.commands.registerCommand('vetty.clearGuidedReview', () => guidedNotes.clearGuidedReview()),
    vscode.commands.registerCommand('vetty.copyComment', (comment) => copyComment(comment)),
    vscode.commands.registerCommand('vetty.editComment', (comment) => editComment(comment)),
    vscode.commands.registerCommand('vetty.saveComment', (comment) => saveComment(context, comment)),
    vscode.commands.registerCommand('vetty.cancelEditComment', (comment) => cancelEditComment(comment)),
    vscode.workspace.onDidOpenTextDocument((doc) => hydrateComments(context, doc)),
    vscode.window.onDidChangeActiveTextEditor((ed) => ed && hydrateComments(context, ed.document))
  );
  for (const ed of vscode.window.visibleTextEditors) hydrateComments(context, ed.document);
  guidedNotes.syncAiThreads();
}

module.exports = {
  controller, localThreads, getComments, bodyText, relocateLine,
  unviewOnCommentResolve, saveAndRebuild, onBranchChanged, initComments,
};
