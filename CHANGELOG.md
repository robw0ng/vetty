# Changelog

## 0.0.106

UI/UX declutter pass. Both editors unless noted.

- **Rows**: the folder shows only when two listed files share a name; `↻ since view` → `↻`,
  `uncommitted only` → `uncommitted` (tooltips explain both).
- **Hover buttons**: Open File + View/Unview (+ Revert to Last Viewed on `↻` rows). Revert Changes,
  Stage and Unstage are right-click only now; Open All in Group left the header too.
- **Right-click menu** regrouped: review → groups → stage → revert → ignore.
- **"Untracked" group is now "Ignored"**, with **Ignore / Include** actions — "untracked" clashed with
  git's meaning (new files, which are reviewable).
- **Title bar (VS Code)**: Refresh and Clear All Comments moved to ⋯; Compare uses history/diff
  icons instead of the eye (that's View/Unview). ⋯ titles are imperative ("Turn Guided Review On",
  "Show Uncommitted Only"), guided items grouped at the top. "Todos" view → "TODOs".
- **Rider toolbar**: Base, Range, Compare, Guided Review stay; the rest sit behind ⋯. Row icons paint
  only on the hovered/selected row (space reserved, so text doesn't jump).

## 0.0.105

Guided review audit — feedback, reading, and a few fixes. Both editors unless noted.

- **New review announced.** When Claude (re)writes the review with Guided Review off, a "Guided
  review ready for `branch` — Turn on" toast appears; with it on, a quiet "updated: N files, M notes".
- **Staleness in the view description**: `guided · 2h ago · 3 commits behind · 2 unannotated`. The
  skill now records `head` + `writtenAt`.
- **Unannotated files** say so in their tooltip.
- **Guided notes collapsed by default** (big picture stays open); "Guided Notes: expand/collapse" in
  the Review ⋯ menu. VS Code.
- **Clear guided review** in the Guided review section's right-click menu.
- Wrong-branch toggle message names both branches.
- Rider gutter tooltips render the note's markdown (bullets, bold, code, tables) instead of raw text.
- Fixes: a note whose line no longer exists is clamped to the file's last line; selecting a file
  header or section in the Comments panel copies/deletes everything under it.

## 0.0.104

- **Copy** button on each Comments-panel section header: copy all your comments (+ PR), or all of
  Claude's guided-review notes, separately. Claude notes copy as markdown under `### file:line`
  headings so bullets and tables survive. Both editors.

## 0.0.103

- Comments panel splits into **Comments** (yours + PR) and **Guided review** (Claude's notes) as two
  collapsible sections — collapse Guided review to see only your comments; the collapsed state sticks.
  With no Claude notes, the panel stays the plain per-file list. Both editors.

## 0.0.102

- Opening a file from the Review list (click, j/k) lands on its **first comment** — yours, Claude's
  notes while Guided Review is on, or PR threads — instead of the first change, so notes above it
  aren't scrolled past. No comments → first change, as before. Both editors.

## 0.0.101

- VS Code: Claude note threads say "Claude · guided review" once in the header; the line above the
  body now says the note's kind (**Big picture** / **Detail**) instead of repeating "Claude".

## 0.0.100

- Tables in Claude notes are a box-drawn grid: a border on every cell, a rule between every row, and
  a double rule under the header, so rows are as easy to tell apart as columns. Both editors.

## 0.0.99

- Tables in Claude notes render as aligned monospace columns (VS Code's comment widget draws GFM
  tables with no borders or padding, so columns ran together). Both editors.
- Skill: big-picture notes are back to 2–4 labeled bullets (`**Called by:**`, `**Implemented in:**`,
  `**Flow:**` …) — the one-line `← / →` arrows were ambiguous and hard to scan.

## 0.0.98

- VS Code: Claude note threads are headed "Guided review" (the author line already says Claude).
- Skill: the per-file big-picture note is one line (`what · ← callers · → uses`).
- Big-picture notes are marked: the skill sets `"kind": "big-picture"`; VS Code heads the thread
  "Guided review · big picture" (map icon + "big picture" in the sidebar), Rider tags the row and tooltip.

## 0.0.97

- Guided Review rows show only `#n`; Claude's one-line why moved to the row tooltip (it was
  truncated noise in a narrow sidebar). Both editors.
- VS Code: file-row tooltips are a formatted card — name + change kind vs base, folder, one line per
  state (viewed / staged / committed / comments), then `Guided #n · why`. The file-decoration text
  VS Code appended ("• Changed vs …") is gone.

## 0.0.96

- **Guided Review covers exactly what Vetty lists.** Vetty now publishes its review set (base,
  merge-base, range, files) to `<git-dir>/vetty/scope.json`; the `vetty-review` skill annotates only
  those files instead of guessing the diff (Vetty's base is often a parent branch, and it counts
  uncommitted + untracked files). Order entries and notes on files outside the review are ignored,
  and `#n` is renumbered over the files actually listed — no more gaps like #1, #3. Both editors.
- **Vetty: Clear Guided Review** (Ctrl+Shift+P in VS Code, Find Action in Rider) deletes Claude's
  order and all its notes for the worktree, after a confirm. Shared file, so both editors clear.

## 0.0.95

- **Guided Review** toggle replaces the sort toggle. On: Claude's review order (`#n` + why) AND
  Claude's notes. Off: regular path order, and Claude's notes are hidden. VS Code moves it into the
  Review view's **⋯** menu. Both editors.

## 0.0.94

- **Claude review annotations.** Any Claude session can write `<git-dir>/vetty/claude-review.json`
  (one per worktree, branch-scoped): an intuitive file **review order** with a one-line why per file,
  plus short **context notes** at specific lines (bullets, tables for state matrices). Both editors
  pick it up live. The `vetty-review` Claude skill (in `skills/`) teaches the format and writing style.
- **Claude notes** show inline (expanded, read-only, re-anchored by line text) and in the Comments
  sidebar under their file. They're context, not change requests: they never block stage-on-view and
  aren't exported. Delete removes a note from the file, so it's gone in both editors.
- **Sort: Claude's review order** toolbar toggle: Unviewed/Viewed follow Claude's order, rows show
  `#n` + the note, and `j`/`k` walk the same order. Unlisted files keep path order after them.

## 0.0.93

- **Uncommitted-only changes show in whole-branch mode.** A change committed and then undone in the
  working tree nets to zero vs the merge-base, so it used to vanish from Vetty while Source Control
  still listed it. It now shows, tagged **uncommitted only**, and its diff opens vs HEAD. Both editors.
- **TODOs and comments are grouped by file**: a header row per file (icon, name, folder, count)
  with the entries beneath showing `:line`. Both editors.
- **Stricter TODO matching**: a marker counts only after a comment leader (`// TODO`, `# FIXME`,
  `/* HACK`, `* NOTE`, `<!-- WIP`, `-- XXX`) or as a `TODO:` / `TODO(name):` label, so identifiers
  like `%TEMP%`, `$env:TEMP` or `` `TEMP` `` in prose no longer show up. Both editors.
- **PR comments in the Comments sidebar** (VS Code), with Go to / Copy, and **Delete** to hide a PR
  comment locally — GitHub is untouched, and it stays hidden across re-pulls and restarts.
- **Unstage** row action; committed (clean) rows hide Stage / Revert Changes, which would be no-ops.
- Row badges: `💬N` open comments (why stage-on-view skipped the file), `↻ since view` for a file
  viewed before and edited since. Stage-on-view says when it skips files that have comments.
- **checkout -b continuation**: a new child branch inherits its parent's review state (viewed,
  untracked, groups, comments), hash-gated so only unchanged files stay viewed. Never into a trunk.
- Revert Changes warns about deletion only when the selection holds untracked files.
- **Fix** (VS Code): an endless ~400ms refresh loop — Vetty's own `git diff` reads rewrite
  `.git/index`, which the watcher treated as a change.

## 0.0.87

- **Stage-on-view mode** (opt-in: `vetty.stageOnView` / Rider toolbar toggle) — viewed = approved =
  staged. View stages, unview unstages, buttons read **View & Stage / Unview & Unstage**. Staging
  outside Vetty (Source Control / commit pane) counts as a view; format-on-commit hooks
  (lint-staged etc.) no longer unview — a marked file that's clean vs HEAD self-heals its mark.
- **Comments = request changes** (stage-on-view): viewing a commented file never stages it;
  commenting on a viewed file unstages it; deleting a file's last comment drops it back to
  Unviewed so the next view is the approval. Both editors.
- **Revert actions**: full **Revert Changes** (restore to HEAD, untracked deleted) and
  **Revert to Last Viewed** (restore the review snapshot — flips straight back to Viewed, index
  kept in sync). One state-appropriate inline button per row; both in the right-click menu, which
  is reorganized (review → manage → revert → track). Both editors.
- **Ignore patterns**: globs that send matches to Untracked on every branch — a review-noise layer
  on top of .gitignore, no repo file. `vetty.ignorePatterns` setting / Rider toolbar dialog.
  `**` crosses folders; `*`/`?` don't.
- **Alt+Shift+C** adds a comment on the caret line in any editor/diff (VS Code keybinding; Rider
  already had it).
- **Debug log** (`vetty.debug` / `#dev.vetty`): git spawn timings, watcher-triggered reloads, load
  stats — for churn hunting.
- **Fix**: TODOs in paths containing spaces (git's trailing-tab diff headers) now detected.

## 0.0.79

- **Untracked (new) files show `+N` line counts** — git's numstat can't cover untracked files, so
  Vetty counts them itself, cached by (mtime, size) so refreshes don't re-read anything. Huge (>1MB)
  and binary files show no count. Both editors.

## 0.0.77

- **No auto-advance on mark-viewed** — anywhere (tree actions, `v` key, diff-viewer View button).
  The row stays selected in its new group, like staging. Explicit navigation (`j`/`k`,
  Next/Prev Unviewed) unchanged. Both editors.

## 0.0.75

- VS Code: the **Viewed group defaults to expanded** on reload (Unviewed already did; Untracked
  stays collapsed). Rider already behaved this way.

## 0.0.72

- **Deletions are reviewable.** Files removed by the branch show as red `D` rows with `−N` counts and
  open as a base-content ↔ empty diff. Mark-viewed works via a tombstone: stays viewed while the file
  stays gone, re-flags if it comes back. Unstaged renames now show honestly as `D` old + `U` new;
  staged/committed renames stay a single `R` row. Both editors.
- **Rebase-aware marks.** When the merge-base moves (base rebased/merged into the branch), marks whose
  file content changed are fully purged — snapshot included — so the since-review overlay never
  presents the base's incoming changes as review work. Untouched files keep their marks. Both editors.
- **Comments section in VS Code** (below Todos), mirroring Rider: click to jump, right-click
  Go to / Edit / Copy / Delete (multi-select), Export + Clear + Pull-PR on the section header.
  Comment actions removed from the Review view's menu.
- **Inline row buttons**: Copy + Delete on comment rows, Copy on TODO rows, with right-click menus
  (Go to / Copy) and an Export TODOs toolbar button — both editors.
- **Stage markers**: leading `*` (staged) / `^` (staged but edited since) on file names, updating
  live. All per-refresh git reads now run in parallel (was sequential — noticeably faster).
- **Menus**: VS Code right-click reorganized to match Rider (review actions, separator, management;
  Untrack at the bottom, Track only on untracked rows with an inline Track button). Rider context-menu
  Open Diff / Open File act on the whole selection.

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
