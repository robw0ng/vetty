# Changelog

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
