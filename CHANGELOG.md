# Changelog

## 0.0.64

- **VS Code: stale search filter.** If the Search webview got re-created (view moved/hidden), the
  box came back empty while the tree stayed filtered to the old search. The webview now re-syncs
  scope, name filter, and search state to the tree on every (re)load.

## 0.0.63

- **Same-tip parent resolution.** A freshly stacked branch (no commits of its own yet) shares its
  tip with its parent, which made the parent invisible to ancestor inference — Vetty picked the
  grandparent and showed the parent's commits as if they were yours. Same-tip branches are now
  parent candidates, tie-broken by reflog creation time (the branch created earlier is the parent).
  The picker labels them `parent · same commit`; a fresh child sorts with descendants. Falls back to
  the old behavior when no reflog is available. Both editors.

## 0.0.61

- **Branch-scoped comments.** Comments were global per file, so they leaked across sibling branches —
  and re-anchoring against the wrong branch's content could permanently corrupt their stored
  positions. Now keyed per branch (VS Code: live threads swap on checkout; Rider: comments stamped
  with their branch, gutters repaint on checkout). Clear Comments clears only the current branch.
  Comments made before this release reset once. Both editors.
- **Repo-scoped state keys (VS Code).** Viewed/ignored/groups/comments keys now include the repo
  root, so two repos in a multi-root workspace sharing a branch name no longer share review state.
  Existing marks reset once (key format change).

## 0.0.59

- **Branch-keyed review state.** Viewed/ignored/groups are now keyed by the current branch instead of
  the base branch. Base-keyed marks were shared across sibling branches: marking a file on one branch
  clobbered the other's mark, and the since-review overlay could diff against a snapshot taken on the
  sibling (reviewing branch B showed branch A's content inverted). Marks made before this release
  reset once. GC prunes by branch existence. Both editors.
- **EOL-normalized viewed hashing.** With `core.autocrlf`, a branch swap-and-back rewrites files with
  flipped line endings — previously that hash change silently unviewed everything. Hashes are now
  CRLF/CR→LF-normalized; old-format marks migrate via a raw-hash fallback and self-heal. Covered by
  unit tests plus an integration test of the swap-back scenario (with a negative control). Both editors.
- **Rider 2026 EDT compliance.** Rider 2026.1 hard-errors on synchronous process execution on the EDT.
  All git-spawning actions moved to pooled threads: branch picker, view/unview (row button, context
  menu, `v` key, section bulk actions, diff-toolbar toggle), track/untrack, base pick.

## 0.0.55

- **Rider: durable viewed/comment state.** Marks, untracks, comments, and base picks now force a
  debounced project save (~0.8s), so a hard IDE crash loses at most the last second instead of
  everything since the platform's last autosave. Bulk "view all" coalesces into one write. (VS Code
  already persisted promptly via its Memento store.)

## 0.0.54

- **Hide whitespace-only** now catches trailing-whitespace, final-newline, and CRLF/EOL-only changes
  (detects real changes via `git diff -w --numstat` instead of `--name-only`, which still listed
  them). Fixes files showing in the list with a seemingly-empty diff after a prettier pass, and the
  toggle appearing to do nothing. Binary files are kept (never swallowed by the filter). Both editors.
- **TODO click highlights** the marker through end of line, like a search hit. Both editors.
- **Diff-viewer "View" button auto-advances** to the next unviewed file — but only when the file is
  part of the current review, so marking viewed on an unrelated editor no longer yanks you into it.
- **Rider: single diff-preview tab** — added and modified files share one preview surface again;
  the earlier split (added-as-file vs modified-as-diff) left both tabs open and caused focus glitches.
- **Rider: preview coordination** — the file preview (TODO / search-match jumps) and the diff preview
  now close each other, so only one preview tab is ever open.
- VS Code: **View All / Unview All** toolbar icons un-swapped (View All = eye, Unview All = eye-closed).

## 0.0.51

- Docs: READMEs updated for the JetBrains port and current feature set; spec MDs removed.

## 0.0.50

- **JetBrains/Rider port** (`jetbrains/`, v0.1.0): native tool window with the Review / TODOs /
  Comments sections, viewed tracking (unsaved-edit aware), parent-branch inference with an
  ancestry-labeled picker, both diff toggles, since-last-review diffs, inline gutter comments with
  export, TODO scanner, Search section (name filter, scope dropdown, content search with
  case/word/regex toggles and match highlighting), hide-whitespace toggle, auto-refresh.
  Released as `vetty-rider-<version>.zip` alongside the VSIX.
- **Fixes (VS Code)**: repo-root resolution (workspace folder can be a subdir of the repo),
  non-ASCII paths (`core.quotePath=false`), renamed files diff against their old name instead of
  showing fully added, comment anchors no longer wiped when persisting with the file's tab closed,
  mark-viewed works from the left side of a since-review diff, "All unviewed" + individually
  checked files opens the union.
- **Performance**: file hashes cached by mtime/size, workspaceState reads memoized, bulk
  mark-viewed snapshots in one `git hash-object --stdin-paths` process, `git add` chunked,
  whitespace diff only computed while the toggle is on, TODO scan and search skip huge/binary files.
- **Multi-root**: `Vetty: Pick Workspace Folder` chooses which folder to review.
- **GC**: stale per-base state (viewed / ignored / groups / base memory) for deleted branches is
  pruned once per session.
- **Internals**: `extension.js` split into `src/` modules (core / tree / search / comments /
  commands); CI builds and attaches the Rider plugin zip to releases.

## 0.0.1

Initial release. Local code review for VS Code (and Cursor) — vet code you didn't write.

- **Review tree**: every file changed vs an inferred base branch, grouped Unviewed / Viewed / Untracked.
- **Base inference**: defaults to the current branch's direct parent; picker labels branches by
  ancestry (parent / ancestor / descendant / diverged), sorted by commits ahead. Diffs against the
  merge-base (matches GitHub's "files changed").
- **Viewed tracking**: content-hash based — edit a viewed file and it re-flags unviewed. Progress
  count + "all reviewed" state in the title. Auto-advance to the next unviewed file.
- **Since-last-review diffs**: unviewed files diff against the snapshot from when you last reviewed
  them, so you only see what's new.
- **Inline comments**: PR-style threads that persist and re-anchor by content across file rewrites;
  copy/export to clipboard.
- **Search panel**: scope chips (All / Unviewed / Added / Modified), filename filter with match
  count, and in-panel text search (case / whole-word / regex) that folds matches into the tree.
- **Triage helpers**: +/- line counts per file, hide whitespace-only changes, status badges,
  folder/flat toggle, huge-diff paging, multi-select bulk actions, TODO scanner.
- **Staging**: stage viewed files (or per-file) to bridge straight into a commit.
- **Auto-refresh** on any working-tree or git change, including edits made outside the editor.
- **Keyboard**: `j` / `k` next/prev unviewed, `v` toggle viewed, `Ctrl/Cmd+C` copy paths.
- **PR review** (experimental, off by default; requires the GitHub CLI `gh`): check out a PR, see
  its existing comments inline, and submit Comment / Approve / Request-changes back.
