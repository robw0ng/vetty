# Spec: Base branch resolution (per-branch memory + ancestor inference)

Behavior spec for how Vetty decides what to diff against. The VS Code build implements this; match
the behavior in the Rider plugin, not the code.

## Goal

Each git branch remembers its own base. Switching branches restores that branch's base; a branch
with none yet gets its **closest ancestor** inferred automatically. Never clobber a base the user
deliberately picked, and never leave the user with nothing selected.

## Storage

- A per-branch map: `baseByBranch = { <branchName>: <baseRef> }` (workspace-scoped state).
- A mirror of the currently-resolved base (single value) for any synchronous reader. (`baseRef` may be
  a local branch name, a remote ref like `origin/main`, or the current branch itself.)

## Resolve (run on every tree load — load runs on activate, refresh, fetch, file save, and on
`.git/HEAD` change, i.e. branch switches)

```
cur = current branch (git rev-parse --abbrev-ref HEAD)
base = baseByBranch[cur]                       // remembered?
if base is a plain local name (not cur, not "origin/..."):   // validate once per session (cache it)
    if that branch no longer exists:           base = null   // deleted
    else if aheadBehind(base).behind == 0 && .ahead > PARENT_MAX_AHEAD:
                                               base = null   // SELF-HEAL: stale/bug-saved far ancestor
if base is null:
    base = inferClosestAncestor(cur)           // see below
if base: baseByBranch[cur] = base ; mirror = base
```

The self-heal matters: a bug or a long-lived branch could persist a base that's an old merged branch
thousands of commits back. Without it, resolve keeps using that (the branch still exists) forever.
Cache the per-`(branch,base)` validation so the extra `rev-list` isn't paid on every load.

Because this runs on `.git/HEAD` changes, switching branches re-resolves automatically.

## inferClosestAncestor(cur) — all candidates are LOCAL branches

0. **If `cur` is itself a trunk** (`main`/`master`/`develop`/`dev`/`trunk`) → return `cur` (working
   changes) and stop. A trunk has no parent, and every merged feature branch looks like an ancestor of
   it — so never infer one.
1. **Closest ancestor:** for every other local branch B, compute ahead/behind vs HEAD
   (`git rev-list --left-right --count B...HEAD` → `behind  ahead`). B is an ancestor when
   `behind == 0 && ahead > 0`. Pick the ancestor with the **smallest `ahead`** (the direct parent) —
   **but only if `ahead <= PARENT_MAX_AHEAD` (≈500).** An ancestor thousands of commits back is an old
   merged branch the current branch contains, not a base; ignore it.
2. Else a **conventional** local base if present: `main`, `master`, `develop`, `dev`, `trunk`.
3. Else the **most-recent other local branch** (by committerdate).
4. Else the **current branch itself** (diffing against it = uncommitted working changes only).

Never auto-selects a remote (`origin/*`); that happens only via explicit pick or PR review.

## Picker labels

Same `PARENT_MAX_AHEAD` cap applies to the **"parent" label**: only tag the closest ancestor as
"parent" when it's within the cap; otherwise it's just "ancestor · N ahead". (Avoids labeling a
1789-commits-ahead merged branch as the parent.)

## Writes

- **Manual base pick** → `baseByBranch[cur] = chosen` (remembered for this branch).
- **PR checkout** → after checking out the PR branch, `baseByBranch[prBranch] = origin/<prBaseRef>`
  so resolve keeps the PR's base instead of re-inferring an ancestor.

## Notes

- Diffing always uses the **merge-base** of the resolved base and HEAD (see DIFF_MODE_SPEC), so even a
  stable base like `main` stays correct across feature branches.
- Cost: resolve adds ~2 cheap git calls per load (rev-parse + branch list). The ancestor inference
  (rev-list per branch) only runs once per branch, then the result is remembered.
