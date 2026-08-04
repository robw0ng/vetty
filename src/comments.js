// Review comments: PR-style inline threads persisted in workspaceState, read-only threads pulled
// from a GitHub PR, and the whole PR review flow (checkout / pull comments / submit / finish).
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lineRef } = require('../lib');
const {
  app, refreshTree, getCwd, git, gh, ghAvailable, prEnabled, REVIEW_KEY, setBaseFor, updateViewedContext,
  stateScope, getViewed, setViewed, isViewed, unstageOnUnview,
} = require('./core');

// --- Local review comments: PR-style inline comment threads, persisted in workspaceState ---
// Scoped per repo+branch like viewed marks: global comments leaked across sibling branches, and
// re-anchoring/persisting from the wrong branch's content corrupted their stored positions.
function commentsKey() {
  return `vetty.comments.${stateScope('')}`;
}
let commentController = null;
const commentThreads = []; // live threads we manage
const builtDocs = new Set(); // uri.toString() already hydrated this session

// Read-only comment threads pulled FROM the PR being reviewed (so you see teammates' existing review).
let prCommentMap = new Map(); // rel → [{ id, line, body, author, resolved, diffHunk, outdated }]
const prThreads = []; // live read-only PR threads (disposed when the review ends)
const prShownKeys = new Set(); // comment ids already rendered — additive pulls skip these

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
  for (const t of commentThreads) {
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
    commentThreads.push(thread);
  }
}

// GraphQL: review threads carry isResolved (REST doesn't), so we can drop resolved feedback.
const PR_THREADS_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){ pullRequest(number:$number){
    reviewThreads(first:100){ nodes{ isResolved
      comments(first:1){ nodes{ id path line originalLine body diffHunk outdated author{ login } } } } } } } }`;

/** Fetch the active PR's review threads (open + resolved, tagged) so the caller can pick which to show. */
async function fetchPrComments(cwd, repo, number) {
  prCommentMap = new Map();
  const [owner, name] = repo.split('/');
  try {
    const out = await gh(cwd, [
      'api', 'graphql',
      '-f', `query=${PR_THREADS_QUERY}`,
      '-f', `owner=${owner}`, '-f', `repo=${name}`, '-F', `number=${number}`,
    ]);
    // ponytail: first 100 threads — fine for almost every PR; add cursor paging if it ever caps out.
    const threads = JSON.parse(out)?.data?.repository?.pullRequest?.reviewThreads?.nodes || [];
    for (const t of threads) {
      const c = t.comments?.nodes?.[0];
      const ln = c?.line ?? c?.originalLine; // originalLine for outdated comments
      if (!c?.path || !ln) continue;
      if (!prCommentMap.has(c.path)) prCommentMap.set(c.path, []);
      prCommentMap.get(c.path).push({
        id: c.id, line: ln, body: c.body || '', author: c.author?.login || 'reviewer',
        resolved: !!t.isResolved, diffHunk: c.diffHunk || '', outdated: !!c.outdated,
      });
    }
  } catch {
    // no comments / API hiccup — leave empty
  }
}

/** Create read-only threads for PR comments whose state is in `states` (Set of 'open'/'resolved').
 *  Built up front (not per-open) so they all show in the Comments panel immediately. */
function buildPrThreads(cwd, states) {
  if (!commentController || !cwd) return;
  for (const [rel, comments] of prCommentMap) {
    const uri = vscode.Uri.file(path.join(cwd, rel));
    for (const c of comments) {
      const state = c.resolved ? 'resolved' : 'open';
      if (!states.has(state)) continue;
      if (prShownKeys.has(c.id)) continue; // already shown — additive pulls don't duplicate
      prShownKeys.add(c.id);
      // For outdated comments the line moved, so show the original code context (the comment's diff hunk).
      let md = c.body;
      if (c.outdated && c.diffHunk) {
        const snippet = c.diffHunk
          .split('\n')
          .filter((l) => !l.startsWith('@@')) // drop the noisy hunk header
          .slice(-8) // keep the relevant tail near the commented line
          .join('\n');
        md += `\n\n**Original code** (this comment is outdated):\n\`\`\`diff\n${snippet}\n\`\`\``;
      }
      const range = new vscode.Range(c.line - 1, 0, c.line - 1, 0);
      const comment = { body: new vscode.MarkdownString(md), mode: vscode.CommentMode.Preview, author: { name: c.author } };
      const thread = commentController.createCommentThread(uri, range, [comment]);
      thread.isPr = true; // never persisted, no edit/delete
      thread.canReply = false;
      thread.contextValue = 'prComment';
      thread.label = (c.resolved ? '✓ Resolved' : 'Open') + (c.outdated ? ' · outdated' : '') + ' · PR';
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      prThreads.push(thread);
    }
  }
}

function clearPrThreads() {
  for (const t of prThreads) t.dispose();
  prThreads.length = 0;
  prShownKeys.clear();
  prCommentMap = new Map();
}

async function createComment(context, reply) {
  const thread = reply.thread;
  const cwd = getCwd();
  thread.dbRel = thread.dbRel || (cwd && relOf(cwd, thread.uri));
  thread.comments = [...thread.comments, makeComment(reply.text)];
  thread.contextValue = 'hasComment';
  thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  if (!commentThreads.includes(thread)) commentThreads.push(thread);
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
  for (const t of prThreads) {
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
  const cwd = getCwd();
  const rel = thread.dbRel || (cwd && relOf(cwd, thread.uri));
  const i = commentThreads.indexOf(thread);
  if (i >= 0) commentThreads.splice(i, 1);
  thread.dispose();
  await persistComments(context);
  await unviewOnCommentResolve(context, [rel]);
}

/** Reassign a thread's comments array so VS Code re-renders it after a mode/body change. */
function rerenderCommentOf(comment) {
  const thread = commentThreads.find((t) => t.comments.includes(comment));
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
    commentThreads.find((t) => t.comments.includes(comment)) ||
    commentThreads.find((t) => t.comments.some((c) => bodyText(c) === bodyText(comment)));
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
  if (!commentThreads.length && !prThreads.length && !Object.keys(getComments(context)).length) {
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
  for (const t of commentThreads) t.dispose();
  commentThreads.length = 0;
  await context.workspaceState.update(commentsKey(), {});
  clearPrThreads(); // pulled PR comments cleared too
  await unviewOnCommentResolve(context, rels);
  refreshTree(); // update the comment-count badge
  vscode.window.showInformationMessage('Cleared all comments.');
}

/** Branch switched: comments are branch-scoped, so drop the old branch's live threads and hydrate
 *  the new branch's for the already-open editors. Called by core.resolveBase on change. */
function onBranchChanged(context) {
  if (!commentController) return; // activate() not finished yet — initial hydrate covers it
  for (const t of commentThreads) t.dispose();
  commentThreads.length = 0;
  builtDocs.clear();
  for (const ed of vscode.window.visibleTextEditors) hydrateComments(context, ed.document);
  app.commentsTree?.refresh();
}

// --- Comments view: sidebar list of this branch's comments (mirrors the Rider Comments section) ---

class CommentsTree {
  constructor(context) {
    this.context = context;
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
  }
  refresh() {
    this._emitter.fire();
    if (app.commentsTreeView) {
      const map = getComments(this.context);
      const n = Object.values(map).reduce((a, notes) => a + notes.length, 0);
      app.commentsTreeView.description = n ? String(n) : '';
    }
  }
  getTreeItem(el) {
    return el;
  }
  getChildren(el) {
    if (el) return [];
    const map = getComments(this.context);
    const items = [];
    for (const rel of Object.keys(map)) {
      (map[rel] || []).forEach((n, i) => {
        const text = n.comments.join(' / ').replace(/\s+/g, ' ').trim();
        const loc = lineRef(n.range[0], n.range[2], n.range[3]);
        const it = new vscode.TreeItem(text || '(empty)');
        it.description = `${path.basename(rel)}:${loc}`;
        it.tooltip = `${rel}:${loc}\n\n${n.comments.join('\n\n')}`;
        it.iconPath = new vscode.ThemeIcon('comment');
        it.note = { rel, i }; // index into the stored per-file array, for edit/delete
        it.contextValue = 'vettyComment';
        it.command = { command: 'vetty.commentGoTo', title: 'Go to', arguments: [rel, n.range[0], n.anchor] };
        items.push(it);
      });
    }
    if (!items.length) {
      const it = new vscode.TreeItem('No comments');
      it.iconPath = new vscode.ThemeIcon('check');
      return [it];
    }
    return items;
  }
}

/** Jump to a comment's line in the working file (re-anchored by content, like opening the thread). */
async function commentGoTo(rel, line, anchor) {
  const cwd = getCwd();
  if (!cwd) return;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(cwd, rel)));
  const l = Math.min(relocateLine(doc, line, anchor), Math.max(doc.lineCount - 1, 0));
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(l, 0, l, 0) });
}

/** Right-click "Go to" on a comment row (row click does the same; this covers the menu). */
async function commentOpen(context, item) {
  const note = item?.note;
  if (!note) return;
  const n = getComments(context)[note.rel]?.[note.i];
  if (n) await commentGoTo(note.rel, n.range[0], n.anchor);
}

/** Notes ({rel, i}) from a comments-view action: multi-selection if present, else the clicked row. */
function selectedNotes(item, sel) {
  const items = Array.isArray(sel) && sel.length ? sel : item ? [item] : [];
  return items.map((x) => x?.note).filter(Boolean);
}

/** Rewrite storage after a tree-side mutation, then rebuild live threads to match. */
async function saveAndRebuild(context, map) {
  await context.workspaceState.update(commentsKey(), map);
  for (const t of commentThreads) t.dispose(); // rehydrate from storage so live threads can't resurrect old state
  commentThreads.length = 0;
  builtDocs.clear();
  for (const ed of vscode.window.visibleTextEditors) hydrateComments(context, ed.document);
  app.commentsTree?.refresh();
  refreshTree();
}

async function commentDelete(context, item, sel) {
  const notes = selectedNotes(item, sel);
  if (!notes.length) return;
  const map = getComments(context);
  const drop = new Set(notes.map((n) => `${n.rel}\n${n.i}`));
  const next = {};
  for (const rel of Object.keys(map)) {
    const kept = (map[rel] || []).filter((_, i) => !drop.has(`${rel}\n${i}`));
    if (kept.length) next[rel] = kept;
  }
  await saveAndRebuild(context, next);
  await unviewOnCommentResolve(context, notes.map((n) => n.rel));
}

async function commentEdit(context, item) {
  const note = item?.note;
  if (!note) return;
  const map = getComments(context);
  const n = map[note.rel]?.[note.i];
  if (!n) return;
  const value = await vscode.window.showInputBox({ prompt: `Comment on ${note.rel}`, value: n.comments.join('\n\n') });
  if (value === undefined) return; // Escape cancels
  const next = { ...map, [note.rel]: map[note.rel].map((x, i) => (i === note.i ? { ...x, comments: [value] } : x)) };
  await saveAndRebuild(context, next);
}

async function commentCopy(context, item, sel) {
  const notes = selectedNotes(item, sel);
  if (!notes.length) return;
  const map = getComments(context);
  const lines = notes
    .map((note) => {
      const n = map[note.rel]?.[note.i];
      if (!n) return null;
      const text = n.comments.join(' / ').replace(/\s+/g, ' ').trim();
      return `- ${note.rel}:${lineRef(n.range[0], n.range[2], n.range[3])} — ${text}`; // same format as Export
    })
    .filter(Boolean);
  await vscode.env.clipboard.writeText(lines.join('\n'));
  vscode.window.setStatusBarMessage(`Copied ${lines.length} comment(s)`, 2000);
}

/** Register the comment controller + comment commands, and hydrate stored comments as editors open. */
function initComments(context) {
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
    vscode.commands.registerCommand('vetty.copyComment', (comment) => copyComment(comment)),
    vscode.commands.registerCommand('vetty.editComment', (comment) => editComment(comment)),
    vscode.commands.registerCommand('vetty.saveComment', (comment) => saveComment(context, comment)),
    vscode.commands.registerCommand('vetty.cancelEditComment', (comment) => cancelEditComment(comment)),
    vscode.workspace.onDidOpenTextDocument((doc) => hydrateComments(context, doc)),
    vscode.window.onDidChangeActiveTextEditor((ed) => ed && hydrateComments(context, ed.document))
  );
  for (const ed of vscode.window.visibleTextEditors) hydrateComments(context, ed.document);
}

// --- PR review flow (experimental, gated on the pullRequests.enabled setting + gh) ---

/** Reflect the active PR (if any) in the view title. */
function updatePrTitle(context) {
  if (!app.diffTreeView) return;
  const st = context.workspaceState.get(REVIEW_KEY);
  app.diffTreeView.title = st?.number ? `Review · PR #${st.number}` : 'Review';
}

/** Flip the PR-mode setting (the config listener handles cleanup if a review is active). */
async function togglePrMode() {
  const cfg = vscode.workspace.getConfiguration('vetty');
  const next = !cfg.get('pullRequests.enabled', true);
  await cfg.update('pullRequests.enabled', next, vscode.ConfigurationTarget.Global);
  vscode.window.setStatusBarMessage(`PR mode ${next ? 'enabled' : 'disabled'}`, 2500);
}

/** Pick a teammate's open PR, check it out, and diff it against its (remote) base branch. */
async function reviewPr(context) {
  const cwd = getCwd();
  if (!cwd) return;
  if (!prEnabled()) {
    vscode.window.showInformationMessage('PR review is disabled. Enable "Vetty › Pull Requests: Enabled" in settings.');
    return;
  }
  if (!ghAvailable()) {
    vscode.window.showErrorMessage('PR review needs the GitHub CLI. Install `gh` and run `gh auth login`.');
    return;
  }
  if ((await git(cwd, ['status', '--porcelain'])).trim()) {
    vscode.window.showErrorMessage('Commit or stash your working changes before reviewing a PR.');
    return;
  }
  // Feed the picker a promise so it opens instantly with a spinner instead of blocking on the network.
  const itemsPromise = gh(cwd, ['pr', 'list', '--json', 'number,title,headRefName,baseRefName', '--limit', '50'])
    .then((out) =>
      JSON.parse(out).map((p) => ({
        label: `#${p.number} ${p.title}`,
        description: `${p.headRefName} → ${p.baseRefName}`,
        pr: p,
      }))
    )
    .catch((e) => {
      vscode.window.showErrorMessage(`Could not list PRs: ${e.message}`);
      return [];
    });
  const pick = await vscode.window.showQuickPick(itemsPromise, { placeHolder: 'Loading open PRs…' });
  if (!pick) return;
  const pr = pick.pr;

  let original, prBranch, repo, headSha;
  try {
    original = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    await gh(cwd, ['pr', 'checkout', String(pr.number)]);
    prBranch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    repo = JSON.parse(await gh(cwd, ['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner;
    headSha = JSON.parse(await gh(cwd, ['pr', 'view', String(pr.number), '--json', 'headRefOid'])).headRefOid;
    await git(cwd, ['fetch', 'origin', pr.baseRefName]); // ensure the base ref is current
  } catch (e) {
    vscode.window.showErrorMessage(`PR checkout failed: ${e.message}`);
    return;
  }

  await context.workspaceState.update(REVIEW_KEY, { original, prBranch, number: pr.number, repo, headSha, baseRef: pr.baseRefName });
  await setBaseFor(context, prBranch, `origin/${pr.baseRefName}`); // remember per PR branch so resolveBase keeps it
  await vscode.commands.executeCommand('setContext', 'vetty.reviewing', true);
  updateViewedContext(context);
  updatePrTitle(context);
  await fetchPrComments(cwd, repo, pr.number); // pull existing review comments
  buildPrThreads(cwd, new Set(['open'])); // show open feedback by default on checkout
  await app.diffTree.load();
  vscode.window.showInformationMessage(`Reviewing PR #${pr.number} vs origin/${pr.baseRefName}.`);
}

/** Return to the pre-review branch and delete the checked-out PR branch locally. */
async function finishReview(context) {
  const cwd = getCwd();
  const st = context.workspaceState.get(REVIEW_KEY);
  if (!cwd || !st?.prBranch) {
    vscode.window.showInformationMessage('No active PR review.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    [
      { label: '$(sign-out) Exit review', detail: `Return to "${st.original}", keep the branch "${st.prBranch}"`, del: false },
      { label: '$(trash) Exit & delete branch', detail: `Return to "${st.original}", delete local "${st.prBranch}"`, del: true },
    ],
    { placeHolder: `Finish reviewing PR #${st.number}` }
  );
  if (!pick) return;
  try {
    await git(cwd, ['checkout', st.original]);
    if (pick.del) await git(cwd, ['branch', '-D', st.prBranch]);
  } catch (e) {
    vscode.window.showErrorMessage(`Cleanup failed (uncommitted changes?): ${e.message}`);
    return;
  }
  await context.workspaceState.update(REVIEW_KEY, undefined);
  await vscode.commands.executeCommand('setContext', 'vetty.reviewing', false);
  clearPrThreads();
  updatePrTitle(context);
  await app.diffTree.load();
  vscode.window.showInformationMessage(
    pick.del ? `Removed "${st.prBranch}", back on "${st.original}".` : `Exited review, back on "${st.original}".`
  );
}

/** Pull the current branch's PR review comments inline (no checkout needed). Clear via Clear Comments. */
async function pullPrComments() {
  const cwd = getCwd();
  if (!cwd) return;
  if (!ghAvailable()) {
    vscode.window.showErrorMessage('Needs the GitHub CLI. Install `gh` and run `gh auth login`.');
    return;
  }
  const picks = await vscode.window.showQuickPick(
    [
      { label: 'Open', state: 'open', picked: true },
      { label: 'Resolved', state: 'resolved' },
    ],
    { canPickMany: true, placeHolder: 'Pull which PR comments?' }
  );
  if (!picks || !picks.length) return;
  const states = new Set(picks.map((p) => p.state));

  let number, repo;
  try {
    number = JSON.parse(await gh(cwd, ['pr', 'view', '--json', 'number'])).number;
    repo = JSON.parse(await gh(cwd, ['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner;
  } catch {
    vscode.window.showInformationMessage('No open PR for the current branch.');
    return;
  }
  const before = prThreads.length;
  await fetchPrComments(cwd, repo, number); // refresh source data (keeps already-shown threads)
  buildPrThreads(cwd, states); // additive: only adds states not already shown (dedup by id)
  const added = prThreads.length - before;
  refreshTree(); // update the comment-count badge
  vscode.window.showInformationMessage(`Pulled ${added} ${[...states].join(' + ')} comment(s) from PR #${number}.`);
}

/** Post all local comments to the active PR as one GitHub review. */
async function submitReview(context) {
  const cwd = getCwd();
  const st = context.workspaceState.get(REVIEW_KEY);
  if (!cwd || !st?.number) {
    vscode.window.showInformationMessage('Start a PR review first (Review Pull Request).');
    return;
  }
  const stored = getComments(context); // keyed by current base = origin/<baseRef>
  const comments = [];
  for (const rel of Object.keys(stored)) {
    for (const n of stored[rel] || []) {
      const body = n.comments.join('\n\n').trim();
      if (!body) continue;
      const startLine = n.range[0] + 1;
      const endLine = n.range[3] === 0 && n.range[2] > n.range[0] ? n.range[2] : n.range[2] + 1;
      const c = { path: rel, line: endLine, side: 'RIGHT', body };
      if (endLine > startLine) {
        c.start_line = startLine;
        c.start_side = 'RIGHT';
      }
      comments.push(c);
    }
  }
  // Allow submitting an empty-comment review (pure approve / request-changes) too.
  const eventPick = await vscode.window.showQuickPick(
    [
      { label: '$(comment) Comment', detail: `Post ${comments.length} comment(s), no verdict`, event: 'COMMENT' },
      { label: '$(check) Approve', detail: 'Approve the PR' + (comments.length ? ` with ${comments.length} comment(s)` : ''), event: 'APPROVE' },
      { label: '$(request-changes) Request changes', detail: 'Block the PR' + (comments.length ? ` with ${comments.length} comment(s)` : ''), event: 'REQUEST_CHANGES' },
    ],
    { placeHolder: `Submit review to PR #${st.number}` }
  );
  if (!eventPick) return;

  let body = '';
  if (eventPick.event !== 'COMMENT' || !comments.length) {
    body = (await vscode.window.showInputBox({ prompt: 'Review summary (optional)', placeHolder: 'Overall comment…' })) ?? '';
  }
  const payload = { commit_id: st.headSha, event: eventPick.event, body, comments };
  const tmp = path.join(os.tmpdir(), `vetty-review-${st.number}.json`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload));
    await gh(cwd, ['api', '--method', 'POST', `repos/${st.repo}/pulls/${st.number}/reviews`, '--input', tmp]);
    const verb = { COMMENT: 'Commented on', APPROVE: 'Approved', REQUEST_CHANGES: 'Requested changes on' }[eventPick.event];
    vscode.window.showInformationMessage(`${verb} PR #${st.number}${comments.length ? ` (${comments.length} comment(s))` : ''}.`);
  } catch (e) {
    // Most common cause: a comment sits on a line not part of the PR diff (GitHub 422).
    vscode.window.showErrorMessage(`Submit failed: ${e.message}. Comments must be on lines changed in the PR.`);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

module.exports = {
  initComments, onBranchChanged, updatePrTitle, togglePrMode, getComments,
  reviewPr, finishReview, pullPrComments, submitReview,
  CommentsTree, commentGoTo, commentOpen, commentDelete, commentEdit, commentCopy,
};
