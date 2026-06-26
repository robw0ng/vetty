# Vetty

**Vet code you didn't write.** A local code-review cockpit for VS Code (and Cursor). Pick a branch,
and Vetty lists every changed file, tracks which ones you've actually reviewed, and — when a file
changes again — shows you only what's new since you last looked.

It brings GitHub's review ergonomics (viewed-state, inline comments, per-file diffs) to your local
working tree — no PR required. Built for the rapid re-review loop that AI-assisted editing creates:
when an agent rewrites 30 files, Vetty tells you what it touched, what you've checked, and
what changed since your last pass.

## Features

| Feature | What it does | Why it helps |
|---|---|---|
| **Diff vs branch** | Lists every file changed vs a branch you pick | See the whole scope of work in one place |
| **Diff working changes** | Pick your current branch → shows just uncommitted edits | Review your own work before committing |
| **Auto base branch** | Infers the current branch's direct parent (closest ancestor); picker labels parent/ancestor/descendant/diverged | Diffs against the right base with no setup |
| **Viewed tracking** | Mark files viewed; edit one and it auto-flags unviewed again | Always know what you've actually looked at |
| **Progress count** | Shows `3/12 viewed` by the title | See review completeness at a glance |
| **Auto-advance** | Mark viewed → next unviewed file opens automatically | Blow through a review without clicking around |
| **Since-last-review diff** | Unviewed files diff against the version you last reviewed | Only see *new* changes, not the whole file again |
| **Diff-mode toggle** | Flip between since-review and full-vs-base diff | Pick the view you need per moment |
| **Status badges** | `A`/`M`/`U`/`R` colored marks like Source Control | Spot adds vs edits vs new files instantly |
| **Untracked files** | New uncommitted files show too (`U`) | Nothing slips through unreviewed |
| **Track / Untrack** | Push noise files (lockfiles, generated) into their own section | Focus only on what matters |
| **Folder vs flat toggle** | Switch between nested folders and a flat file list | Flat for small diffs, nested for big ones |
| **Multi-select** | Shift/Ctrl-click files → bulk view/untrack/open | Act on many files at once |
| **Scope chips** | Narrow the tree to All / Unviewed / Added / Modified | One click to "just what I haven't reviewed" |
| **Filename filter** | Live-filter the tree by name, with match count + clear | Jump to a file in a huge diff |
| **Text search** | Searches the shown files (case/word/regex); matches fold into the Review tree | Find code without leaving the panel — rows expand to matching lines |
| **Inline comments** | PR-style notes on lines; persist and re-anchor by content when a file is rewritten | Notes survive AI edits instead of drifting |
| **Hide whitespace-only** | Drop files whose only change is formatting | Real changes stop hiding in reformat noise |
| **Copy / export comments** | Copy one or all as `file:line(s) — note` (spans multi-line ranges) | Paste into AI chat or a ticket |
| **TODO scanner** | Lists new TODO/FIXME/etc added in the branch | Catch leftover markers before they ship |
| **Auto-refresh** | Reloads on any file/git change (incl. AI edits) | Tree stays current, no manual refresh |
| **Open file / diff** | One click per row, or all-in-group | Get into the actual review fast |
| **Merge-base diff + fetch** | Diffs against the merge-base (like GitHub's "files changed"); Fetch button updates remotes | Accurate change list even when the base has moved on |
| **PR review** *(experimental, off by default; needs `gh`)* | Check out a teammate's PR, see its existing comments inline, submit Comment/Approve/Request-changes back | Full two-way PR review without leaving the editor |
| **Line counts** | `+42 −7` per file row | Triage which file to review first |
| **Stage viewed** | One click stages every file you marked viewed | Bridge from review straight to a commit |
| **Review-complete** | Title shows `✓ all N reviewed` when done | Know when you've covered everything |
| **Copy paths / keys** | Ctrl+C copies selected paths; `j`/`k` next/prev unviewed, `v` toggle | Fast keyboard-driven review |

## Getting started

1. Open a git repo folder.
2. Click the **Vetty** icon in the Activity Bar.
3. It auto-picks a base branch (main/master/…) — or click the branch button to choose one.
4. Walk the **Review** list: click a file to diff it, mark it viewed, leave comments.

## Toolbar

`branch` · `refresh` · `diff-mode (since-review / full)` · `tree / flat` · `export comments` · `clear comments`

## Pull request review (optional)

With the **GitHub CLI (`gh`)** installed and authenticated (`gh auth login`), Vetty can review
teammate PRs end to end:

1. Click the **pull-request** button → pick an open PR → Vetty checks it out and diffs it against
   its base branch (`origin/<base>`, fetched fresh). The PR's existing review comments appear inline
   as read-only threads.
2. Review files, mark them viewed, leave inline comments.
3. **Submit Review** → choose **Comment**, **Approve**, or **Request changes** → your local comments
   post to the PR as one review.
4. **Finish Review** → returns to your previous branch and deletes the local PR branch.

PR review is **experimental and off by default**. Turn on `vetty.pullRequests.enabled` (and have
`gh` installed/authenticated) to try it; otherwise Vetty stays purely local.

## Keyboard (when the Review view is focused)

- `j` / `k` — open next / previous unviewed file
- `v` — toggle viewed on the active file
- `Ctrl/Cmd+C` — copy selected file paths

## How it works

- **Changed files:** `git diff --name-status --diff-filter=d <base>` plus untracked files
  (`git ls-files --others --exclude-standard`).
- **Viewed state:** stored per base branch as a content hash — edit a viewed file and it re-flags as
  unviewed automatically. Marking viewed also snapshots the file as a git blob.
- **Since-last-review diff:** unviewed files diff against that snapshot blob instead of the base
  branch, so you see only what changed since your last pass. Snapshots are best-effort git objects;
  if one is ever garbage-collected, the diff falls back gracefully.
- **Comments:** built on VS Code's native Comments API, persisted in workspace state. Local by
  default; during a PR review you can push them to the PR as a GitHub review.

## Notes

- Works in VS Code and any VS Code fork (Cursor, Windsurf, VSCodium). Not JetBrains/Rider.
- Comments and viewed-state are local to your machine and stored per workspace.
- PR review needs the GitHub CLI (`gh`); without it (or with `vetty.pullRequests.enabled: false`)
  Vetty runs fully local with no change to the rest of its features.
