# Spec: Diff controls — two independent toggles

Behavior spec (UI-toolkit-agnostic) for the Vetty review panel. The VS Code build implements this;
the Rider plugin should match the behavior, not the code.

## Why two toggles (not one mode)

There are two **independent** concerns. The old single 3-way "diff mode" cycle conflated them and
was confusing. Split into two separate toolbar toggles:

1. **Range** — which files are listed and what the default diff base is.
2. **Since last review** — an overlay that changes what an *unviewed* file is diffed against.

They compose freely (4 combinations, all valid). Persist both per workspace.

## Toggle 1 — Range

Two states; one toolbar button that flips between them (icon + tooltip reflect current state):

- **Whole branch** (default): list every file that differs from the **merge-base** of the current
  branch and its base branch (`git merge-base <base> HEAD`). This matches GitHub's "Files changed".
- **Since last commit**: list only **uncommitted** changes — working tree vs `HEAD`. Like the
  built-in Source Control view.

Effects when toggled:
- Recompute the file list using the new ref (`merge-base` vs `HEAD`).
- The default diff base for opening a file follows the range (see resolution below).
- Group pruning (removing group assignments for files no longer changed) must be **skipped in
  "since last commit"** mode, because the listed set is only the uncommitted subset — pruning then
  would wrongly forget files that are part of the branch but currently committed.

## Toggle 2 — Since last review (overlay)

On/off; one toolbar button. **Default: on.**

When **on**, an unviewed file that has a stored "last reviewed" snapshot is diffed against that
snapshot (showing only what changed since you last marked it viewed) instead of against the range
base. When **off**, every file diffs against the range base.

"Has a snapshot" = the file was previously marked viewed (a content snapshot was saved at that
moment), and it is currently unviewed (its content changed since). See the viewed-state spec for how
snapshots are stored (VS Code stores a git blob hash; Rider can store a blob/temp copy keyed by path).

## Diff base resolution (when opening a file)

In priority order:

1. **Since-review snapshot** — if Toggle 2 is on AND the file has a usable snapshot AND it's
   currently unviewed → diff `snapshot ↔ working file`. Title: `<path> (last viewed)`.
2. Else if **Range = since last commit** → diff `HEAD:<path> ↔ working file`. Title:
   `<path> (uncommitted)`. (New/untracked files have an empty left side.)
3. Else (**Range = whole branch**) → diff `<merge-base>:<path> ↔ working file`. Title:
   `<path> (<base> ↔ working)`.

## Status / title text

Show the active state compactly near the view title, naming both axes, e.g.:
`range: whole branch · compare: last viewed` or `range: uncommitted · compare: base`.
(UI labels the overlay "Compare: last viewed / base"; the state key stays `sinceReview` — see below.)

## Defaults

- Range = **whole branch**
- Since last review = **on**

## State keys (VS Code build, for reference)

- `vetty.diffRange` = `'branch' | 'commit'`
- `vetty.sinceReview` = boolean

Rider: store the equivalent in plugin/workspace state; expose both as separate toolbar toggle actions.
