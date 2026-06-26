# Changelog

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
