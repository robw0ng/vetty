---
name: vetty-review
description: Annotate the current branch (or just the changes since the last commit, per Vetty's Range mode) for review in Vetty (VS Code / Rider) — write an intuitive file review order plus short inline context notes, citing the existing code each change follows as precedent, that Vetty shows in the editor and its sidebar. Use when the user says "annotate for vetty", "vetty walkthrough", "review order for vetty", "add vetty comments", "explain these changes in vetty", or asks for a guided review of their branch's changes.
---

# Vetty review annotations

Vetty reads one file per git worktree and shows it live:

- **order** → with **Guided Review** on, the Review list follows this order. Rows show `#n`; your note is the row tooltip.
- **comments** → with Guided Review on, read-only "Claude" notes inline at the line and in the Comments sidebar.

Notes are context for the reader, not change requests. They never block staging.

## 1. Get the exact scope from Vetty — don't guess the diff

```bash
git rev-parse --absolute-git-dir           # <git-dir>
cat "<git-dir>/vetty/scope.json"           # written by Vetty on every refresh
git rev-parse HEAD                         # → "head" in the review file (Vetty shows "N commits behind")
```

`scope.json` = `{ branch, base, mergeBase, range, files: [{ file, status }] }`. **`files` is the whole
scope**: order and comment ONLY those paths, exactly as spelled. Vetty's base is often a parent
branch (not main), and it also counts uncommitted + untracked files — a guessed diff won't match.
Vetty ignores entries outside `files`.

**Check `base` first.** It must be the branch this one was cut from. If it shows a trunk (`develop`,
`main`) while the branch is stacked on something else, stop and ask the user to set Vetty's base to
`<parent>` (Change Base Branch in Vetty), then re-read `scope.json`. A review against the wrong base
describes the wrong diff.

### Mode: whole branch or since the last commit

`range` is the mode the user has Vetty in (its **Range** toggle). Annotate that mode:

| range | reviews | diff each file against | big-picture notes explain |
|---|---|---|---|
| `branch` | everything the branch changed | `mergeBase` | the file's role in the whole branch |
| `commit` | uncommitted changes since the last commit | `HEAD` | what this latest change does to the file |

- `status` `U` (untracked): read the whole file, in either mode.
- In `commit` mode, still read enough of the branch to explain context — but order and notes cover only the listed files.
- The user asks for the other mode than Vetty is in? Tell them to flip Vetty's **Range** toggle (that rewrites
  `scope.json`), then re-read it. Don't annotate a scope Vetty isn't showing.
- Say which mode you annotated in your final message.
- Rule of thumb: `branch` for a first review of the work, `commit` for a fix round after feedback.
- Re-run after any rebase or amend: lines and `head` move, and Vetty shows the review as stale.

No `scope.json` (Vetty not open on this repo yet)? Ask the user to open Vetty once, or fall back to
`git diff --name-status $(git merge-base HEAD <base>)` + `git ls-files --others --exclude-standard`.

### Find precedent for the new code

Before writing notes, look for existing code **outside the diff** that the new code copies or extends:
the same pattern in a sibling feature, the handler/validator/DTO it was modeled on, an existing helper
it mirrors. Search by the new code's shape (base classes, interfaces, naming like `*CommandHandler`,
the same framework calls) with grep / git grep.

- Found a precedent → cite it so the reader can compare: `**Precedent:** follows DeleteNoteCommandHandler (validate → load → mutate → publish).`
- Departs from its precedent → say how and why: `**Differs from precedent:** skips the shared-access check that AddNoteCommandHandler does — attach is view-only by design.`
- No precedent (genuinely new pattern) → say so on the big-picture note: `**Precedent:** none — first use of X in this service.`
- Name precedents by searchable identifier (class/method/file). Don't cite files inside the diff as precedent.

## 2. Write `<git-dir>/vetty/claude-review.json`

Create the `vetty` dir if missing. Overwrite the whole file each time (UTF-8 JSON).

```json
{
  "branch": "feature/login-rate-limit",
  "head": "3f2a9c1e0d…(full sha from git rev-parse HEAD)",
  "writtenAt": "2026-09-29T15:04:05Z",
  "order": [
    { "file": "src/auth/limits.ts", "note": "new limiter state + config" },
    { "file": "src/auth/login.ts", "note": "wires limiter into login" },
    "src/auth/login.test.ts"
  ],
  "comments": [
    {
      "file": "src/auth/limits.ts",
      "line": 12,
      "anchor": "export class Limiter {",
      "kind": "big-picture",
      "body": "- Adds a token-bucket limiter per IP + user.\n- **Called by:** `login.ts handleSubmit`.\n- **Uses:** `config.limits`."
    },
    {
      "file": "src/auth/limits.ts",
      "line": 41,
      "endLine": 58,
      "anchor": "take(key) {",
      "body": "- Refills lazily on read — no timer.\n\n| state | allow | next |\n|---|---|---|\n| full | yes | drain 1 |\n| empty | no | 429 + Retry-After |"
    }
  ]
}
```

- Paths: repo-root-relative, forward slashes.
- `line` / `endLine`: 1-based, in the **current working-tree** file. `endLine` optional.
- `anchor`: exact text of `line`, trimmed. Vetty uses it to re-find the line if code moves. Always include it.
- `order` entries: a path string, or `{ file, note }`. List **every** file in scope, once. Unlisted ones sort after, unnumbered.
- `kind`: `"big-picture"` on each file's role note; omit it on detail notes.
- `branch`: copy it from `scope.json`. Vetty hides the file on other branches.
- `head`: full sha of `git rev-parse HEAD`; `writtenAt`: current time, ISO 8601 UTC. Vetty uses them to
  show how stale the review is ("2h ago · 3 commits behind").

## 3. Review order — make it intuitive

Order so each file only depends on what came before it:

1. Big picture first: the file that best explains the change (entry point, main feature file).
2. Foundations: types, schemas, config, migrations, shared helpers.
3. Core logic that uses them.
4. Callers, wiring, UI.
5. Tests last (they read best once the code is known). Generated / lockfiles at the very end.

`note`: ≤ 8 words. Say what this file contributes — `adds retry state`, `calls limiter on login`.

## 4. Comments — short, concise, explain well

### Every file gets a big-picture note (required)

Each file in scope gets **at least one** note: its role in the whole branch. Put it on the file's
first changed line (for an untracked/new file, the first meaningful line — the class or main export).

Set `"kind": "big-picture"` on it — Vetty labels it "big picture" so readers can tell it apart.

It is 2–4 short bullets:
- First bullet: what this file adds or changes, ≤ 12 words.
- Then labeled bullets for its place in the flow, only the ones that apply:
  `**Called by:**`, `**Calls:**`, `**Implemented in:**`, `**Used by:**`, `**Built by:**`, `**Flow:**` (a → b → c),
  `**Precedent:**` (the existing code it's modeled on — see "Find precedent").
- Name neighbours by searchable identifier (class/method/file).
- Detail (why, edge cases, open questions) still goes in detail notes, not here.

Example:

```
- Adds attach and detach publish methods to the interface.
- **Called by:** `Order.Notes.cs`.
- **Implemented in:** `EventPublisher`.
```

Example:

```
- Handles `POST AttachNotes`.
- **Flow:** load target → resolve picks → attach each → save → publish.
- **Called by:** `OrderController.AttachNotes`.
```

Deleted files (`status` `D`) can't take a line note — their `order` note carries the big picture.

### Follow-up notes (where the big picture points)

A big-picture note names things — a **Flow:** step, a **Calls:** target, a rule or decision. Wherever
one of them happens in *this* file, put a short inline note at that line, so the reader who just read
the summary finds each piece where it lives.

- **One per thing named** that has a line in this file: each flow step, each call, each rule the
  big picture mentions. Things in other files are already reachable by name — no note for them here.
- **1–2 bullets, ≤ 15 words each.** Name which part of the big picture this is, then add the one
  fact the summary left out (why, edge case, what it guards).
- **Reuse the big picture's words** so the link is obvious: `- **Flow step 3:** owner check.`
- **Merge with the block note** when the step is the block's first line — one note, not two.
- Skip it when the line is self-explanatory and the summary already said everything.

Example — big picture says `**Flow:** validate → load attachment → owner check → create → save.`:

```
- **Owner check:** only the work order's own company adds a response.
- **Why:** the design's "Only the assigned user can add a reply" (12:345).
```

### Block notes (every non-trivial block)

The reader reads every changed line anyway, so give context at each logical block — they should
never hit meaningful code with no note nearby.

- **One note per logical block** of changed or new code: a method, a handler step, a query, a
  branch of a state machine, a config section, a test case group.
- **1–2 bullets.** What the block does in the flow, and why. Put it on the block's first line.
- **Merge neighbours**: adjacent small blocks doing one thing share one note.
- **Skip the trivial**: imports/usings, plain property lists, generated code, pure renames or
  formatting, obvious one-line wiring. A run of trivial blocks gets at most one note
  (`- DTO fields mirror the AttachNotes request body.`).
- If a note would only restate the code, drop it — a padded note trains the reader to skip notes.

### Detail notes (where a reader would pause)

On top of the block note, go deeper where it's earned: new concepts, non-obvious decisions, state
machines, cross-file contracts, subtle edge cases, risky spots, precedent departures. These can run
longer (up to 4 bullets or a table). Fold the detail into the block note when the block is small.

### Style — short, concrete, easy to digest (all notes)

A reader skims notes while reading code. Each note must land in about five seconds.

- **Lead with the point.** First bullet = the one thing to know, ≤ 12 words.
- **One idea per bullet**, ≤ ~15 words, 1–4 bullets per note. A `;`, a second clause, or a
  parenthetical = split into two bullets.
- **Why and what it connects to**, not a restatement of the code. Name the other file/function when
  a note depends on it: `→ called from login.ts handleSubmit`.
- **Label bullets when it helps scanning**: `**Why:**`, `**Calls:**`, `**Called by:**`, `**Edge:**`, `**Open:**`.
- **Plain, concrete words.** Spell out abbreviations once per note (work order (WO)) or avoid them;
  "rejects a template republished mid-dialog", not "handles version staleness".
- **Backticks only for names the reader will search for** — not for every noun.
- **Tables** for a state matrix, mode × input, or before/after behaviour: short cells (≤ 4 words),
  2–4 columns, a blank line before the table.
- No filler ("This function…", "Note that…"), no praise, no change requests.

Before (hard to digest):

```
- Auto-dispatch (Q12): copies the WO's active forms as attached, with no template re-check, so a later round survives a deactivate or republish.
```

After:

```
- Auto-dispatch copies the work order's active forms to the new PO.
- **Why:** no template re-check, so later rounds survive a deactivate or republish.
- Decided in Q1 (TICKET-1 planning questions).
```

### Citing things the reader can't see

You may cite decisions, questions or context from outside the code (a plan, ticket, design
thread, PR discussion, your own earlier session). Always say **where it's from** so the reader can
find it: `(Q2 — TICKET-1 planning questions)`, `(decided in PR #12 review)`, `(per ticket TICKET-1)`.
Mark open items as open: `Open: Q3 (TICKET-1 planning) — count child orders in the close dialog?`

**Figma nodes are always links, never a bare id.** Wrap the node id in a markdown link to the node:
`[12:345](https://www.figma.com/design/<fileKey>/<fileName>?node-id=12-345)`, with the id's `:` written as `-`
in the URL. Take the file key and name from the board URL the plan or ticket gives; if no board URL is known, ask
for it rather than citing a bare id.

Good:

```
- Debounced 150ms: a checkout fires dozens of VFS events.
- → reload() in VettyUi does the real work.
```

Bad: `This function sets up a listener that listens for file changes and then calls reload.`

## 5. Finish

Check before writing: every non-deleted file in `scope.json` has a big-picture note, every
non-trivial changed block has a block note, everything a big-picture note names that lives in the
same file has a follow-up note at its line, no note just restates its code, every `order` entry and
note path is in `scope.json`, and each new pattern names its precedent (or says none).

Tell the user in one or two lines: the mode (whole branch / since last commit), how many files were ordered, how many notes you wrote, and that
they should turn on Vetty's **Guided Review** toggle to see it. Re-run to update; the file is replaced.
