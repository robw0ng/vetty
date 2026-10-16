// GitHub PR review flow (experimental, gated on the pullRequests.enabled setting + gh): check out a
// PR, pull its review threads as read-only comments, submit a review, finish. Owns the PR threads.
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, refreshTree, getCwd, git, gh, ghAvailable, prEnabled, REVIEW_KEY, setBaseFor, updateViewedContext } = require('./core');
const comments = require('./comments');

let prCommentMap = new Map(); // rel → [{ id, line, body, author, resolved, diffHunk, outdated }]
const threads = []; // live read-only PR threads (disposed when the review ends)
const shownIds = new Set(); // comment ids already rendered — additive pulls skip these
// PR comments deleted locally: GitHub keeps them, vetty just stops showing them (survives re-pulls
// and restarts). Keyed by GraphQL node id, which is globally unique — no repo/branch scope needed.
const PR_DISMISSED_KEY = 'vetty.prDismissed';

function prThreads() {
  return threads;
}
function prDismissed() {
  return new Set(app.context?.workspaceState.get(PR_DISMISSED_KEY) || []);
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
    const nodes = JSON.parse(out)?.data?.repository?.pullRequest?.reviewThreads?.nodes || [];
    for (const t of nodes) {
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
  const controller = comments.controller();
  if (!controller || !cwd) return;
  const dismissed = prDismissed();
  for (const [rel, list] of prCommentMap) {
    const uri = vscode.Uri.file(path.join(cwd, rel));
    for (const c of list) {
      const state = c.resolved ? 'resolved' : 'open';
      if (!states.has(state)) continue;
      if (shownIds.has(c.id)) continue; // already shown — additive pulls don't duplicate
      if (dismissed.has(c.id)) continue; // deleted locally
      shownIds.add(c.id);
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
      const thread = controller.createCommentThread(uri, range, [comment]);
      thread.isPr = true; // never persisted, no edit; delete = dismiss locally
      thread.prId = c.id;
      thread.prRel = rel;
      thread.prBody = c.body;
      thread.prAuthor = c.author;
      thread.canReply = false;
      thread.contextValue = 'prComment';
      thread.label = (c.resolved ? '✓ Resolved' : 'Open') + (c.outdated ? ' · outdated' : '') + ' · PR';
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      threads.push(thread);
    }
  }
  app.commentsTree?.refresh();
}

/** Delete PR comments locally: hide the threads now and on every later pull. GitHub is untouched. */
async function dismissPrThreads(context, list) {
  const ids = prDismissed();
  for (const t of list) {
    ids.add(t.prId);
    const i = threads.indexOf(t);
    if (i >= 0) threads.splice(i, 1);
    t.dispose();
  }
  await context.workspaceState.update(PR_DISMISSED_KEY, [...ids]);
  app.commentsTree?.refresh();
}

function clearPrThreads() {
  for (const t of threads) t.dispose();
  threads.length = 0;
  shownIds.clear();
  prCommentMap = new Map();
  app.commentsTree?.refresh();
}

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
  const before = threads.length;
  await fetchPrComments(cwd, repo, number); // refresh source data (keeps already-shown threads)
  buildPrThreads(cwd, states); // additive: only adds states not already shown (dedup by id)
  const added = threads.length - before;
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
  const stored = comments.getComments(context); // keyed by current base = origin/<baseRef>
  const list = [];
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
      list.push(c);
    }
  }
  // Allow submitting an empty-comment review (pure approve / request-changes) too.
  const eventPick = await vscode.window.showQuickPick(
    [
      { label: '$(comment) Comment', detail: `Post ${list.length} comment(s), no verdict`, event: 'COMMENT' },
      { label: '$(check) Approve', detail: 'Approve the PR' + (list.length ? ` with ${list.length} comment(s)` : ''), event: 'APPROVE' },
      { label: '$(request-changes) Request changes', detail: 'Block the PR' + (list.length ? ` with ${list.length} comment(s)` : ''), event: 'REQUEST_CHANGES' },
    ],
    { placeHolder: `Submit review to PR #${st.number}` }
  );
  if (!eventPick) return;

  let body = '';
  if (eventPick.event !== 'COMMENT' || !list.length) {
    body = (await vscode.window.showInputBox({ prompt: 'Review summary (optional)', placeHolder: 'Overall comment…' })) ?? '';
  }
  const payload = { commit_id: st.headSha, event: eventPick.event, body, comments: list };
  const tmp = path.join(os.tmpdir(), `vetty-review-${st.number}.json`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload));
    await gh(cwd, ['api', '--method', 'POST', `repos/${st.repo}/pulls/${st.number}/reviews`, '--input', tmp]);
    const verb = { COMMENT: 'Commented on', APPROVE: 'Approved', REQUEST_CHANGES: 'Requested changes on' }[eventPick.event];
    vscode.window.showInformationMessage(`${verb} PR #${st.number}${list.length ? ` (${list.length} comment(s))` : ''}.`);
  } catch (e) {
    // Most common cause: a comment sits on a line not part of the PR diff (GitHub 422).
    vscode.window.showErrorMessage(`Submit failed: ${e.message}. Comments must be on lines changed in the PR.`);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

module.exports = {
  prThreads, prDismissed, fetchPrComments, buildPrThreads, dismissPrThreads, clearPrThreads,
  updatePrTitle, togglePrMode, reviewPr, finishReview, pullPrComments, submitReview,
};
