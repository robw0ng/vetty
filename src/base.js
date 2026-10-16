// Base-branch memory + inference: which branch to diff against, remembered per current branch, else
// the closest ancestor from the branch tree. Also the per-session GC of state for deleted branches.
const { parseAheadBehind, parseBranchTips, parseFirstParents, branchTree, parseWorktrees } = require('../lib');
const { dbg } = require('./app');
const { getCwd, git } = require('./git');
const { stateCache, setActiveBranch, activeBranchName, stateScope, getViewed, setViewed, isViewed } = require('./review-state');

const LAST_BRANCH_KEY = 'vetty.lastBranch';
const MAX_REL_BRANCHES = 50; // cap ahead/behind computation to the most-recent branches (perf)
const TRUNK_NAMES = ['main', 'master', 'develop', 'dev', 'trunk'];
// ponytail: a real parent is close; an "ancestor" thousands of commits back is just an old merged
// branch the trunk contains, not a base. Cap how far ahead we'll still call something a parent.
const PARENT_MAX_AHEAD = 500;

async function currentBranch(cwd) {
  try {
    return (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  } catch {
    return '';
  }
}

async function localBranches(cwd) {
  try {
    return (await git(cwd, ['branch', '--format=%(refname:short)', '--sort=-committerdate']))
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Commits in HEAD-not-branch (ahead) and branch-not-HEAD (behind). null if it can't be computed. */
async function aheadBehind(cwd, branch) {
  try {
    return parseAheadBehind(await git(cwd, ['rev-list', '--left-right', '--count', `${branch}...HEAD`]));
  } catch {
    return null; // unrelated histories / bad ref
  }
}

/** When another branch's tip EQUALS this one's (fresh stacked branch, no commits yet), commit
 *  topology is symmetric — parent and child look identical. The reflog breaks the tie: its oldest
 *  entry is the branch's creation moment, and the branch created EARLIER is the parent. */
async function branchCreatedAt(cwd, branch) {
  try {
    // %gd + --date=unix = the reflog ENTRY time (%ct would be the commit time — identical for
    // same-tip branches, useless as a tie-break). Oldest entry = branch creation.
    const lines = (await git(cwd, ['reflog', 'show', '--date=unix', '--format=%gd', branch])).trim().split('\n').filter(Boolean);
    const m = lines.length ? lines[lines.length - 1].match(/@\{(\d+)\}/) : null;
    return m ? parseInt(m[1], 10) : Infinity;
  } catch {
    return Infinity; // no reflog → can't claim parenthood
  }
}

// The terminal picker rule (lib/branch-tree): first-parent walk from the tip to the first commit
// holding another branch's tip, reflog birth for same-tip ties, trunk fallback only when the branch
// reaches that trunk's history. The picker's tree and the inferred base can't disagree — the old
// ahead/behind scan rooted stacked branches on develop.
async function defaultBase(cwd) {
  const cur = await currentBranch(cwd);
  const names = await localBranches(cwd);
  if (!names.length) return null;
  // On the trunk itself there's no parent — every merged feature branch looks like an ancestor.
  // Default to the current branch = uncommitted working changes.
  if (cur && TRUNK_NAMES.includes(cur)) return cur;
  const tree = await branchTreeData(cwd);
  const parent = tree.rows.find((r) => r.name === cur)?.parent;
  if (parent) return parent;
  for (const c of TRUNK_NAMES) {
    if (c !== cur && names.includes(c)) return c;
  }
  // No parent / no other branch (e.g. on the base branch itself) → diff against the current branch,
  // which shows just the uncommitted working changes. Never leave the user with nothing to pick.
  return names.filter((n) => n !== cur)[0] || cur || null;
}

/** Every local branch as a tree + its graph column (bottom-up: trunk at the foot, stacks growing
 *  upward) + which branch is checked out in which other worktree. Two git calls plus one worktree
 *  list; reflog births only for same-tip ties. Feeds the picker and defaultBase. */
async function branchTreeData(cwd) {
  const [tipsOut, logOut, wtOut] = await Promise.all([
    git(cwd, ['for-each-ref', '--format=%(objectname) %(refname:short)', '--sort=-committerdate', 'refs/heads']),
    // --branches, not --all: remotes/tags would spend the walk budget; past the horizon a stacked
    // branch loses its parent and gets re-rooted as a peer of main.
    git(cwd, ['log', '--branches', '--first-parent', '--format=%H %P', '-n', '4000']).catch(() => ''),
    git(cwd, ['worktree', 'list', '--porcelain']).catch(() => ''),
  ]);
  const rows = await branchTree({
    tips: parseBranchTips(tipsOut),
    firstParents: parseFirstParents(logOut),
    trunks: TRUNK_NAMES,
    birthOf: (b) => branchCreatedAt(cwd, b),
    maxAhead: PARENT_MAX_AHEAD,
  });
  return { rows, worktrees: parseWorktrees(wtOut, cwd) };
}

// Base is remembered per current branch, so switching branches restores that branch's base (and a
// branch with none yet gets its closest ancestor inferred). LAST_BRANCH_KEY mirrors the resolved
// base so the many synchronous lastBranch() readers keep working.
const BASE_BY_BRANCH = 'vetty.baseByBranch';
function setBaseFor(context, branch, base) {
  if (branch) {
    const map = { ...(context.workspaceState.get(BASE_BY_BRANCH) || {}) };
    map[branch] = base;
    context.workspaceState.update(BASE_BY_BRANCH, map);
  }
  return context.workspaceState.update(LAST_BRANCH_KEY, base);
}

function lastBranch(context) {
  const b = context.workspaceState.get(LAST_BRANCH_KEY);
  return typeof b === 'string' && b ? b : null;
}

/** checkout -b continuation: marks are branch-keyed, so a new child branch starts empty even though
 *  its content is identical to what was just reviewed. On switching to `cur`: find the branch we
 *  came from in the HEAD reflog (restart-safe, unlike in-memory state), and if `cur` descends from
 *  its tip (merge-base == tip — exactly what checkout -b produces) and has no marks of its own yet,
 *  copy the parent's review state over. Hash-gating keeps it honest: only files whose content still
 *  matches show viewed. Never fires INTO a trunk (feature→master after a merge would pollute it),
 *  and never overwrites existing marks. */
async function inheritBranchState(context, cwd, cur) {
  try {
    if (TRUNK_NAMES.includes(cur)) return;
    const scope = (b) => `${getCwd() ?? ''}\n${b}`;
    const KEYS = ['viewed', 'ignored', 'groups', 'comments'];
    for (const k of KEYS) {
      const v = context.workspaceState.get(`vetty.${k}.${scope(cur)}`);
      if (v && Object.keys(v).length) return; // cur already has state — never overwrite
    }
    // Newest "checkout: moving from A to B" in the reflog tells us the parent candidate.
    const reflog = await git(cwd, ['reflog', 'HEAD', '-n', '30', '--format=%gs']);
    const m = reflog.split('\n').map((l) => /^checkout: moving from (\S+) to (\S+)/.exec(l)).find(Boolean);
    if (!m || m[2] !== cur || m[1] === cur) return;
    const prev = m[1];
    const prevViewed = context.workspaceState.get(`vetty.viewed.${scope(prev)}`);
    if (!prevViewed || !Object.keys(prevViewed).length) return;
    const prevTip = (await git(cwd, ['rev-parse', '--verify', prev])).trim();
    const mb = (await git(cwd, ['merge-base', prev, cur])).trim();
    if (!prevTip || prevTip !== mb) return; // cur is not a child of prev's current tip
    for (const k of KEYS) {
      const v = context.workspaceState.get(`vetty.${k}.${scope(prev)}`);
      // Deep-copy: storing the same object under both keys would alias A's and B's marks.
      if (v) await context.workspaceState.update(`vetty.${k}.${scope(cur)}`, JSON.parse(JSON.stringify(v)));
    }
    stateCache.clear(); // memoized state for the new scope must re-read
    dbg(`inherited review state ${prev} → ${cur}`);
  } catch (e) {
    dbg(`inherit skipped: ${e.message}`);
  }
}

const validatedBase = new Set(); // `${branch}\0${base}` already vetted this session (skip git re-checks)

/** Resolve the base for the current branch: remembered → else closest ancestor. Mirrors to LAST_BRANCH_KEY. */
async function resolveBase(context, cwd) {
  const cur = await currentBranch(cwd);
  if (cur && cur !== activeBranchName()) {
    setActiveBranch(cur); // viewed/ignored/groups/comments are keyed by this
    await inheritBranchState(context, cwd, cur); // checkout -b continuation: child inherits marks
    // Comments are branch-scoped: drop the old branch's live threads and hydrate this branch's,
    // so a persist after the switch can't write branch-A threads under branch-B's key.
    require('./comments').onBranchChanged(context); // lazy — comments requires core at top level
  }
  const map = context.workspaceState.get(BASE_BY_BRANCH) || {};
  let base = cur ? map[cur] : null;
  // Validate a remembered LOCAL base once per session (cheap on later loads via the cache).
  if (base && base !== cur && !base.startsWith('origin/') && !validatedBase.has(`${cur}\0${base}`)) {
    if (!(await localBranches(cwd)).includes(base)) {
      base = null; // branch was deleted
    } else {
      // Self-heal: a base that's an ancestor absurdly far ahead is a stale / bug-saved pick
      // (e.g. an old merged branch the trunk contains) → drop it and re-infer.
      const ab = await aheadBehind(cwd, base);
      if (ab && ab.behind === 0 && ab.ahead > PARENT_MAX_AHEAD) base = null;
    }
    if (base) validatedBase.add(`${cur}\0${base}`);
  }
  if (!base) base = await defaultBase(cwd); // infer the closest ancestor
  if (base) await setBaseFor(context, cur, base);
  return base;
}

// GC: per-branch state (viewed/ignored/groups + the base-by-branch map) otherwise accumulates
// forever as branches are deleted. Once per session, drop entries whose branch no longer exists
// locally. This also gradually clears legacy base-keyed entries (origin/* etc.).
let prunedStale = false;
async function pruneStaleState(context, cwd) {
  if (prunedStale) return;
  prunedStale = true;
  const keep = new Set(await localBranches(cwd));
  for (const key of context.workspaceState.keys()) {
    const m = key.match(/^vetty\.(viewed|ignored|groups|comments|mergeBase)\.(.+)$/);
    if (!m) continue;
    const scope = m[2];
    const sep = scope.lastIndexOf('\n');
    // Legacy (pre-repo-scope) keys are unreadable under the new format → always drop.
    // Scoped keys: prune only THIS repo's dead branches; other repos GC in their own sessions.
    const dead = sep < 0 || (scope.slice(0, sep) === cwd && !keep.has(scope.slice(sep + 1)));
    if (dead) {
      stateCache.delete(key);
      await context.workspaceState.update(key, undefined);
    }
  }
  await context.workspaceState.update('vetty.comments', undefined); // legacy global comments key
  const map = context.workspaceState.get(BASE_BY_BRANCH) || {};
  const pruned = Object.fromEntries(Object.entries(map).filter(([br]) => keep.has(br)));
  if (Object.keys(pruned).length !== Object.keys(map).length) {
    await context.workspaceState.update(BASE_BY_BRANCH, pruned);
  }
}

/** The merge-base moved (base was rebased/merged into the branch) → fully unview marks whose file
 *  content changed: their since-review snapshots predate the rebase, so the overlay would present
 *  the BASE's incoming changes as reviewable work. Untouched files keep their marks. */
async function purgeOnMergeBaseChange(context, cwd, base, mergeBase) {
  if (!mergeBase) return;
  const k = `vetty.mergeBase.${stateScope(base)}`;
  const prev = context.workspaceState.get(k);
  if (prev === mergeBase) return;
  if (prev) {
    const viewed = getViewed(context, base);
    let changed = false;
    for (const rel of Object.keys(viewed)) {
      if (!isViewed(cwd, viewed, rel)) {
        delete viewed[rel]; // mark + snapshot both go — the file behaves fresh-unviewed
        changed = true;
      }
    }
    if (changed) await setViewed(context, base, viewed);
  }
  await context.workspaceState.update(k, mergeBase);
}

module.exports = {
  LAST_BRANCH_KEY, MAX_REL_BRANCHES, TRUNK_NAMES, PARENT_MAX_AHEAD,
  currentBranch, localBranches, aheadBehind, branchCreatedAt, defaultBase, branchTreeData,
  setBaseFor, lastBranch, inheritBranchState, resolveBase, pruneStaleState, purgeOnMergeBaseChange,
};
