# Vetty

**Vet code you didn't write.** A local code-review cockpit for VS Code (and Cursor). Pick a branch,
and Vetty lists every changed file, tracks which ones you've actually reviewed, and — when a file
changes again — shows you only what's new since you last looked.

It brings GitHub's review ergonomics (viewed-state, inline comments, per-file diffs) to your local
working tree — no PR required. Built for the rapid re-review loop that AI-assisted editing creates:
when an agent rewrites 30 files, Vetty tells you what it touched, what you've checked, and
what changed since your last pass.

## Features

| Feature                                                    | What it does                                                                                                | Why it helps                                   |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **Review changed files**                                   | Every file changed vs a branch or your working tree, grouped Unviewed / Viewed / Untracked                  | The whole scope of work in one place           |
| **Auto base branch**                                       | Infers the current branch's direct parent (closest ancestor); merge-base diff like GitHub's "files changed" | Right base, accurate change list, no setup     |
| **Viewed tracking**                                        | Mark files viewed; edit one and it re-flags unviewed (content-hash); progress + auto-advance                | Always know what you've actually reviewed      |
| **Since-last-review diff**                                 | Unviewed files diff against the version you last reviewed                                                   | See only what's*new*, not the whole file again |
| **Inline comments**                                        | PR-style notes that persist and re-anchor by content when a file is rewritten                               | Notes survive AI edits instead of drifting     |
| **In-panel text search**                                   | Search the shown files (case/word/regex); matches fold into the tree, click to jump                         | Find code without leaving the review           |
| **Scope filter**                                           | Dropdown to narrow to All / Unviewed / Added / Modified                                                     | One click to "just what I haven't reviewed"    |
| **Multi-root**                                             | `Vetty: Pick Workspace Folder` chooses which folder (repo) to review                                        | Works in multi-folder workspaces               |
| **Hide whitespace-only**                                   | Drop files whose only change is formatting                                                                  | Real changes stop hiding in reformat noise     |
| **Track / Untrack**                                        | Push noise files (lockfiles, generated) into their own section                                              | Focus only on what matters                     |
| **TODO scanner**                                           | Lists new TODO/FIXME/etc added in the branch                                                                | Catch leftover markers before they ship        |
| **Auto-refresh**                                           | Reloads on any file/git change, including AI edits with no save                                             | Tree stays current, no manual refresh          |
| **Stage viewed**                                           | One click stages every file you marked viewed                                                               | Bridge from review straight to a commit        |
| **PR review** _(experimental, off by default; needs `gh`)_ | Check out a PR, see its comments inline, submit Comment/Approve/Request-changes                             | Two-way PR review without leaving the editor   |

## For AI pair programming

When an agent edits your code, you didn't write it — so you have to vet it, fast, often, and again
after every revision. Vetty is built for exactly that loop (ordered by what matters most):

| The AI-pairing problem                                        | How Vetty helps                                                                                                                        |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Agent touched 30 files — what did it actually change?         | **Review tree** shows the full changed set vs the parent branch, grouped by review state.                                              |
| It rewrote files again — re-reading everything is exhausting. | **Since-last-review diff** shows only what changed since your last pass, not the whole file.                                           |
| I want the agent to fix what I flagged.                       | Comment on the code it wrote, then**Export Comments** copies them all as `file:line — note` — paste straight into the agent to action. |
| Did I actually look at all of it?                             | **Viewed tracking** re-flags any file the agent re-touches as unviewed; **auto-advance** + progress keep you moving.                   |
| My review notes vanish when the agent rewrites the file.      | **Content-anchored comments** re-find their line across rewrites instead of drifting.                                                  |
| The real change is buried in reformatting.                    | **Hide whitespace-only** drops pure-format churn so logic stands out.                                                                  |
| The agent edits on disk with no save event.                   | **Auto-refresh** reacts to any file change, including out-of-editor edits.                                                             |
| Leftover debug markers slip through.                          | **TODO scanner** lists new TODO/FIXME the branch introduced.                                                                           |

**The loop:** review the agent's code → comment the lines you want changed → **Export Comments** →
paste back → the agent fixes exactly those → **since-last-review** shows you only what it touched.

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

- Works in VS Code and any VS Code fork (Cursor, Windsurf, VSCodium). For JetBrains IDEs (Rider,
  IntelliJ, …) there's a native port — see [`jetbrains/`](jetbrains/README.md).
- Comments and viewed-state are local to your machine and stored per workspace.
- PR review needs the GitHub CLI (`gh`); without it (or with `vetty.pullRequests.enabled: false`)
  Vetty runs fully local with no change to the rest of its features.
