# Vetty Roadmap

**Thesis:** code generation is commoditizing; *verification* is the bottleneck. Vetty grows from a
review extension into the review-first coding environment — the place you trust what agents wrote.

**Baseline (today):** VS Code extension + Rider plugin at feature parity. Changed-file review vs an
inferred parent branch (merge-base, same-tip/reflog aware), content-hash viewed tracking
(EOL-normalized, rebase-aware purge, deletion tombstones), since-last-review diffs, branch-scoped
comments with export, TODO scanner, scoped search, stage markers, deletions/renames, GC'd state,
CI releasing both artifacts per tag.

---

## Stage 1 — Extension-phase features (no fork needed)

Ordered roughly by value ÷ effort. Each is shippable independently.

### 1.1 Stack panel (graphite-style up/down/restack, pure git)
New "Stack" section in the Vetty container. Detailed phases:
1. **Read-only + navigation**: infer stacks transitively (existing closest-ancestor + same-tip +
   reflog logic), persist confirmed edges `{branch → {parent, parentTipSha}}` (inference proposes,
   stored graph is truth). Render trunk-at-bottom list, current highlighted, `↑ahead` +
   `needs restack` badges (parent tip ≠ recorded sha), PR numbers via `gh`. Click = checkout
   (dirty-tree guard). `Stack: Up/Down` commands + keybindings.
2. **Restack engine**: `git rebase --onto <newParentTip> <recordedParentTip> <child>`, cascade over
   descendants, pause on conflict (detect `.git/rebase-merge`), panel buttons for continue/abort,
   resume cascade, auto-stash around the whole op. *This is 80% of the difficulty — design the
   pause/resume state first.*
3. **Lifecycle**: create-on-top, insert between levels, fold into parent, delete + re-parent
   children (+ cascade restack).
4. **Remote**: sync trunk → cascade restack → prune merged (GC hooks exist). Push stack with
   `--force-with-lease` ONLY. `gh` PR chain: one PR per level, base = parent, retarget on merge.
5. **Polish**: drag-and-drop re-parenting; Rider port (Swing patterns all exist in VettyUi).

Synergies: `mergeBaseByBranch` (reuse pattern for parentTipSha), branch-keyed marks survive
checkouts, restack triggers the existing mark purge, `parMap`/parallel git.
Risks: conflict-mid-cascade UX; never mutate during an in-progress rebase/merge.

### 1.2 Closed agent loop
Today: Export Comments → paste into agent → re-review via since-review diff. Make it one button:
- "Send to agent" runs a configurable command (`claude -p "<comments>"` / any CLI), streams output
  to a Vetty terminal/panel, and on completion auto-refreshes (watchers already catch the edits).
- Per-comment "Fix this" (single-comment prompt) and whole-review "Fix all".
- The since-review overlay is already the perfect "re-review only its delta" — this just closes the
  loop natively. Config: `vetty.agent.command` with `{comments}` placeholder.
Effort: small-medium. Highest leverage per line of code in this whole roadmap.

### 1.3 Provenance-lite (who wrote this change)
Full provenance needs a fork; a useful subset doesn't:
- Watch working-tree writes (watchers exist). When a file changes with no editor typing session
  behind it (no recent Document edits), tag the change window as "external/agent"; typing = "human".
- Store per-file last-writer tag + timestamp alongside marks; show a badge (🤖/👤) on rows;
  scope filter "agent-written only".
- Optional: integrate with agent-loop runs (1.2) — anything changed during a send-to-agent run is
  definitively agent-authored.
Honest ceiling: heuristic, file-granularity, local-only. Still enough for "show me unvetted agent
output", which is the query that matters.

### 1.4 Review sessions (shareable)
- Marks + comments + progress + base pin exported as one JSON artifact; import merges it.
- Use: handoff a half-done review, or attach the artifact to a PR for a teammate.
- Storage already branch+repo-scoped; export is mostly serialization + an import merge policy
  (theirs-wins vs mine-wins prompt).
Effort: small. Do after 1.2.

### 1.5 Review timeline
- Every mark already snapshots a git blob. Keep the last N snapshots per file instead of 1
  (entry: list of `{blob, timestamp}`).
- UI: row context menu → "Compare against…" → pick snapshot (QuickPick with timestamps) → diff.
- GC: cap N (3–5), prune with the existing branch GC.
Effort: small-medium. Niche but cheap given the blob machinery exists.

### 1.6 Sort order for the review list
- Toggle: name (current) / first-commit order (`git log --reverse --name-only mergebase..HEAD`,
  first-seen per file) / recently-modified (mtime). Follow-the-story reviewing for stacked work.
Effort: small. Parked from an earlier discussion — still worth it.

### 1.7 Review gates (extension-grade)
- Can't truly block `git commit` from an extension, but can: warn-on-stage (exists for groups),
  a "review complete" status bar gate, and an opt-in git pre-commit hook Vetty installs
  (`vetty verify` CLI stub checking marks state) for people who want hard enforcement.
- Stamp `Reviewed-by:` / `Vetted:` trailer via prepare-commit-msg hook (opt-in).
Effort: medium (the CLI stub is the new surface).

### 1.8 Activity + review analytics (local WakaTime, two layers)
Nobody measures verification effort — generation gets all the dashboards. Track both layers:
- **Coding layer (classic WakaTime)**: heartbeat model — on keystroke/scroll/focus, record
  `{timestamp, file, language, project, branch, isWrite}`; coalesce into activity spans with an
  idle timeout (~2 min). Stats: time per day/project/language/branch, keystrokes, active vs idle.
- **Review layer (the differentiator)**: active time on Vetty-opened diffs + views, marks-per-session,
  comments written, agent round-trips (from 1.2), churn reviewed (± lines vetted). Every stat
  splittable by author type once provenance-lite (1.3) lands — "time reviewing agent code vs writing
  my own" is the headline number.
- **Store**: local JSONL per day in global storage. No telemetry, no server — the anti-WakaTime:
  data never leaves the machine. Optional export (CSV/JSON) for people who want their own charts.
- **Dashboard**: a Vetty webview — writing vs reviewing split per day, per-branch/file drill-down,
  files vetted vs changed, streaks, "review debt" (changed-but-unvetted over time).
- **Tie-ins**: gates (1.7) can flag "reviewed for 4s"; sessions (1.4) carry time totals.
Effort: medium. Ship the capture layer early (data accrues before any dashboard exists); heartbeat
capture is cheap (both editors have the listeners already — document/editor events, Rider's
EditorFactory multicaster). Dashboard later. Rider parity via the same JSONL schema.

### 1.9 Worktree manager + slice overlays
Parallel work without branch-switch churn. Two halves:
- **Worktree manager**: panel over `git worktree list --porcelain` — create (folder convention
  `../<repo>.wt/<branch>`), open-in-new-window, remove (dirty guard), per-worktree badges (branch,
  dirty, ahead). Vetty state is already isolated per worktree for free: keys are repo-root-scoped
  and a worktree's `--show-toplevel` is its own path.
- **Slice overlays** ("run this branch's changes here without switching"): pick a source
  branch/worktree → `git restore --source=<src> -- <its changed-vs-mergebase files>` (a set Vetty
  already computes) into the current tree, uncommitted. Manifest `{source, files, at}` stored;
  overlaid files badged; banner "overlay active: <src> (N files)"; one-click remove =
  `git restore --source=HEAD -- <files>`.
- **Guard rails** (the whole feature is guard rails): refuse overlay onto locally-dirty files (or
  auto-stash first); loud warning on stage/commit while an overlay is active (committing the slice
  by accident is THE footgun); overlay auto-removed before branch switch/restack.
Effort: manager small, overlays medium (guards are most of it). Pairs naturally with the stack
panel (1.1) — "run the stack up to level N" is just an overlay of levels above HEAD.

### 1.10 Team layer (hub, presence, sharing)
The first feature that can't be purely local — so phase it by infrastructure cost:
- **P1 — serverless team feel (no backend)**:
  - *Presence via Discord Rich Presence*: local RPC to the running Discord client — status shows
    "Reviewing feature-x (7/12 files)" / "In agent loop" / "Restacking". Zero servers, instant
    Discord-native statuses. Opt-in, with a privacy filter (hide repo/file names mode).
  - *Sharing via GitHub as the data plane*: review sessions (1.4) pushed as gists/PR artifacts;
    comments posted to PRs (PR mode already does half); stack state shareable as an artifact.
- **P2 — self-hosted relay (team hub)**: a tiny websocket relay a team runs themselves (single
  binary/container, rooms keyed by repo remote URL). Live presence in a Vetty "Team" section: who's
  on which branch/stack level, review progress, statuses (reviewing/coding/afk/in-agent-loop),
  "nudge" (ask for review of a session). Live-shared review sessions: marks + comments sync so two
  people can split a review. Self-hosted keeps the privacy stance intact.
- **P3 — hosted hub (product decision)**: accounts, orgs, history — only if this stops being a
  personal project. Explicitly out of scope until Stage 3 traction exists.
Guard: every team feature opt-in; local-only mode always fully functional. The moment presence
leaks data by default, the privacy story (1.8's whole pitch) dies.
Effort: P1 small-medium (Discord RPC lib + gist plumbing), P2 medium-large (the relay + sync
semantics — start with last-writer-wins on marks, comments append-only).

---

## Stage 2 — The fork decision

**Gate:** fork ONLY when Stage 1 features hit the workbench ceiling and people (≥ a team beyond
you + coworker) actually use the extension weekly. Forks inherit VS Code's upstream-merge treadmill
forever — that's a standing tax measured in engineer-hours per month. Cursor's playbook: the fork
was justified by extension-impossible features, after traction.

Fork-only features (the list that justifies it):

### 2.1 Hunk-level review
Viewed/approve per hunk inside the diff editor; approved hunks stage exactly (git add -p engine);
hunk marks re-anchor across edits (anchor machinery generalizes). File-level viewed becomes the
summary of hunk states. **The single biggest product upgrade in this roadmap.**

### 2.2 Review mode as a workbench state
Full-window review session: queue, progress in the title bar, j/k/v global, diff-first layout,
zero side-panel squinting. Owns the shell — impossible as an extension.

### 2.3 True provenance
Line-level authorship persisted in local history: which agent, which session, which prompt produced
each line. Review-by-provenance queries. Requires editor-core hooks into every text change + the
agent runtime integration (1.2/1.3 are the prototype).

### 2.4 Native UI freedoms
Tri-state checkboxes, row backgrounds, custom tree rendering, SCM integration — every compromise
logged in this repo's history disappears.

### 2.5 Hard review gates
Commit/push actually blocked in the built-in git flow until the changed set is vetted; team policy
config; trailers first-class.

---

## Stage 3 — Product

- **Marketplace**: publish the extension (real publisher ID, not `local`), OpenVSX for the forks.
  JetBrains Marketplace for the plugin. This is the traction engine for the Stage 2 gate.
- **Docs site**: the README's AI-pairing loop is the pitch; one page, GIFs of the loop.
- **Dogfood metric**: you + coworker using it for every PR. If either of you bypasses it for a
  week, fix why before adding features.
- **Keep**: no telemetry, local-only state, one-shot release script, CHANGELOG discipline.

## Monetization

Stay 100% free until installs are real — marketplace publish is the gate; no users, nothing to
monetize. Then, in order of friction:

1. **Open-core, team-paid** (the natural split — the roadmap already divides along it):
   - Free forever: everything local — review core, marks, comments, stack panel, worktrees,
     analytics, serverless team features (1.10 P1).
   - Paid: the hosted/team layer — presence/sync relay as a service (1.10 P3), shared live review
     sessions, org dashboards. Individuals never pay; teams do. (GitLens/GitKraken playbook.)
2. **Payment rails**: JetBrains Marketplace has *native paid licensing* → the Rider plugin can go
   freemium there with zero payment infra (easiest first dollar). VS Code Marketplace has NO
   payment rails → own license keys (LemonSqueezy/Paddle) checked in-extension, GitLens-Pro style.
3. **The review-first-team angle — the real pricing power**: review gates (1.7) + provenance
   (1.3/2.3) + `Reviewed-by` trailers compose into an **audit trail proving humans vetted
   AI-generated code**. Crucially, this does NOT need regulation to sell: the buyer is an EM/CTO
   who declares the team review-first as internal policy — "no unvetted agent code ships" — and
   needs tooling to make that real (gates), visible (team dashboards, review debt from 1.8), and
   provable (trailers). Per-seat B2B sold to eng orgs, not developers. Positioning: "the
   verification layer for AI-assisted teams." Regulated industries (finance/health/safety-critical)
   are the later, bigger wave if governance mandates land — same product, higher stakes. This is
   the only piece with startup-grade economics; treat 1.3 + 1.7 + 1.8's team stats as its prototype
   and keep the audit data model export-friendly (signed/tamper-evident trailers later).
4. **Sponsors/donations**: GitHub Sponsors + README nudge. Coffee money; fine to enable early.

Sober numbers: dev-tool conversion runs 1–2% of actives, and paid = support burden. Solo, tiers 1–2
are a lifestyle-business ceiling; tier 3 is the venture-shaped bet.

## Suggested order

1. 1.2 agent loop (small, thesis-defining)
2. 1.1 stack panel phases 1–2 (the daily-driver feature)
3. 1.6 sort order + 1.5 timeline (small wins between big ones)
4. 1.3 provenance-lite
5. 1.1 phases 3–4, 1.4 sessions, 1.7 gates
6. Marketplace publish → watch usage → Stage 2 decision
