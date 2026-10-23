// The Review view: DiffTree (changed files, Unviewed/Viewed/Ignored), its file decorations, and the
// per-file row grouping shared with the TODO and Comments views.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { parseNumstat, ago } = require('../lib');
const core = require('./core');
const {
  app, getCwd, git, untrackedFiles, getViewed, setViewed, viewedEntries, getIgnored, getGroups, setGroups, isViewed,
  resolveBase, mergeBaseRef, lastBranch, shortRef, DIFF_RANGE_SHORT, diffRange, sinceReviewOn, hasSinceReviewDiff,
} = core;

const PAGE_SIZE = 500; // flat-view rows per group before a "Show more" row appears

// Line counts for untracked files, cached by (mtime, size) — refreshes fire every ~400ms, so
// without the cache every untracked file would be re-read on each one. null = huge/binary/unreadable.
const lineCountCache = new Map(); // rel → { key: 'mtimeMs:size', n }
function untrackedLineCount(cwd, rel) {
  try {
    const p = path.join(cwd, rel);
    const st = fs.statSync(p);
    const key = `${st.mtimeMs}:${st.size}`;
    const c = lineCountCache.get(rel);
    if (c && c.key === key) return c.n;
    let n = null;
    if (st.size <= 1024 * 1024) {
      const buf = fs.readFileSync(p);
      if (!buf.includes(0)) {
        n = 0;
        for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
        if (buf.length && buf[buf.length - 1] !== 10) n++; // last line without trailing newline
      }
    }
    lineCountCache.set(rel, { key, n });
    return n;
  } catch {
    return null; // unreadable — no counts
  }
}

// Git-style badge + color on each changed file, reusing VS Code's built-in gitDecoration colors.
const STATUS_COLOR = {
  A: 'gitDecoration.addedResourceForeground',
  C: 'gitDecoration.addedResourceForeground',
  M: 'gitDecoration.modifiedResourceForeground',
  T: 'gitDecoration.modifiedResourceForeground',
  R: 'gitDecoration.renamedResourceForeground',
  U: 'gitDecoration.untrackedResourceForeground',
  D: 'gitDecoration.deletedResourceForeground',
};
const fileDecorations = {
  _emitter: new vscode.EventEmitter(),
  get onDidChangeFileDecorations() {
    return this._emitter.event;
  },
  refresh() {
    this._emitter.fire(undefined); // undefined → re-query all decorations
  },
  provideFileDecoration(uri) {
    const cwd = getCwd();
    if (uri.scheme !== 'file' || !cwd || !app.diffTree) return;
    const rel = path.relative(cwd, uri.fsPath).split(path.sep).join('/');
    const letter = app.diffTree.status.get(rel);
    if (!letter) return;
    const color = STATUS_COLOR[letter];
    // No decoration tooltip: VS Code appends it to every row's hover card ("• Changed vs …"), and
    // the Review row's own card already says the change kind + base.
    return { badge: letter, color: color ? new vscode.ThemeColor(color) : undefined };
  },
};

/** Activity Bar view: changed files grouped into Unviewed / Viewed, vs the selected branch. */
class DiffTree {
  constructor(context) {
    this.context = context;
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    this.base = lastBranch(context);
    this.files = [];
    this.added = new Set(); // files absent from base — diff left side would be empty, so open them as files
    this.status = new Map(); // rel → status letter (A/M/R/C/T) for the file decoration badge
    this.stat = new Map(); // rel → { add, del } line counts from --numstat
    this.nameFilter = ''; // lowercased filename filter; '' = show all
    this.scope = 'all'; // all | unviewed | added | modified — scope chips in the Search panel
    this.groupFilter = null; // null/[] = all groups; else array of group names to show (multi-select)
    this.searchMatches = null; // null = no text search; else Map rel → [{line, text}] (filters the tree)
    this.realChanged = new Set(); // files with non-whitespace changes (git diff -w)
    this.hideWhitespace = !!context.workspaceState.get('vetty.hideWhitespace');
    this.nested = !!context.workspaceState.get('vetty.nested'); // folder tree vs flat list
    this.pageLimits = {}; // per-group shown-row cap for the flat view (huge-PR paging)
    this.baseRef = this.base; // merge-base of base+HEAD (resolved in load); what we actually diff against
    this.itemByRel = new Map(); // rel → last-rendered file TreeItem, for reveal()
  }

  /** True if `rel` passes the active name filter + scope chip (+ text-search match set). */
  _matches(cwd, viewed, rel) {
    if (this.searchMatches && !this.searchMatches.has(rel)) return false;
    if (this.groupFilter && this.groupFilter.length && !this.groupFilter.includes(getGroups(this.context, this.base)[rel]))
      return false;
    // Whitespace-only modified files: present in the full diff but absent from `git diff -w`.
    if (this.hideWhitespace && this.status.get(rel) !== 'U' && !this.realChanged.has(rel)) return false;
    if (this.nameFilter && !rel.toLowerCase().includes(this.nameFilter)) return false;
    switch (this.scope) {
      case 'unviewed':
        return !isViewed(cwd, viewed, rel);
      case 'added':
        return ['A', 'U'].includes(this.status.get(rel));
      case 'modified':
        return ['M', 'T', 'R', 'C'].includes(this.status.get(rel));
      default:
        return true;
    }
  }

  /** Files currently shown (name filter + scope), excluding untracked-from-review. For text search scoping. */
  visibleFiles(cwd) {
    const viewed = getViewed(this.context, this.base);
    const ignored = getIgnored(this.context, this.base);
    return this._ordered(this.files.filter((f) => !ignored.has(f) && this._matches(cwd, viewed, f)));
  }

  /** Guided Review steps: Claude's order restricted to files actually in this review (out-of-diff
   *  and untracked-group entries dropped), renumbered 1..n so the #s have no gaps. Map rel → { n, note };
   *  empty while Guided Review is off. ponytail: recomputed per call — the order list is short. */
  steps() {
    const review = core.guidedReviewOn(this.context) ? core.claudeReview() : null;
    const map = new Map();
    if (!review?.order.size) return map;
    const present = new Set(this.files);
    const ignored = getIgnored(this.context, this.base);
    for (const [rel, e] of review.order)
      if (present.has(rel) && !ignored.has(rel)) map.set(rel, { n: map.size + 1, note: e.note });
    return map;
  }

  /** Guided Review: listed files first, in step order; the rest keep git's order after them.
   *  Everything that walks the list (groups, j/k) follows. */
  _ordered(list) {
    const steps = this.steps();
    if (!steps.size) return list;
    const at = (r) => steps.get(r)?.n ?? Infinity;
    return [...list].sort((a, b) => at(a) - at(b)); // stable
  }

  refresh() {
    this._emitter.fire();
  }

  async load() {
    const t0 = Date.now();
    const cwd = getCwd();
    this.base = cwd ? await resolveBase(this.context, cwd) : lastBranch(this.context);
    this.baseRef = cwd && this.base ? await mergeBaseRef(cwd, this.base) : this.base;
    // Rebase/merge detection: the merge-base moved → purge marks for files the rebase changed,
    // so their stale snapshots can't present the base's incoming changes as reviewable work.
    if (cwd && this.base) await core.purgeOnMergeBaseChange(this.context, cwd, this.base, this.baseRef);
    // In "since last commit" mode, list working-tree-vs-HEAD (like Source Control); else the branch's changes.
    this.listRef = diffRange(this.context) === 'commit' ? 'HEAD' : this.baseRef;
    const files = [];
    const added = new Set();
    const deleted = new Set(); // removed vs base — opens as base-content ↔ empty
    const status = new Map();
    const stat = new Map();
    const realChanged = new Set();
    const staged = new Set(); // in the index (git diff --cached)
    const staleStaged = new Set(); // staged AND edited since (working ≠ index) — restage before commit
    const dirty = new Set(); // working ≠ index (any file)
    const wtOnly = new Set(); // branch range: changed vs HEAD but NOT vs the merge-base (committed, then undone)
    if (cwd && this.base) {
      try {
        // All six git reads are independent — run them concurrently (sequential spawns made every
        // refresh, and the stage markers with it, take ~half a second on Windows).
        const [out, ns, wOut, untracked, cachedOut, dirtyOut] = await Promise.all([
          git(cwd, ['diff', '--name-status', this.listRef]),
          git(cwd, ['diff', '--numstat', this.listRef]),
          // Files with real (non-whitespace) changes — anything else is formatting-only. Use -w --numstat,
          // NOT --name-only: `--name-only -w` still LISTS trailing-whitespace / final-newline / CRLF-only
          // files (so they'd never hide), but --numstat emits no row for them. Keep binary files
          // (`-\t-\tpath`) as real changes so hide-whitespace never swallows an image. Toggle-gated.
          this.hideWhitespace ? git(cwd, ['diff', '-w', '--numstat', this.listRef]) : Promise.resolve(''),
          untrackedFiles(cwd),
          // Staged markers: `*` = in the index, `^` = staged but edited since (index ≠ working tree).
          git(cwd, ['diff', '--cached', '--name-only']),
          git(cwd, ['diff', '--name-only']),
        ]);
        const addNameStatus = (text, keep) => {
          for (const line of text.split('\n')) {
            const parts = line.split('\t');
            if (parts.length < 2) continue;
            const rel = parts[parts.length - 1].trim(); // rename → new path
            if (!rel || !keep(rel)) continue;
            const letter = parts[0].trim()[0];
            files.push(rel);
            status.set(rel, letter);
            if (letter === 'A') added.add(rel);
            if (letter === 'D') deleted.add(rel);
          }
        };
        addNameStatus(out, () => true);
        // +/- line counts (binary files report "-\t-"); skipped silently.
        parseNumstat(ns).forEach((v, k) => stat.set(k, v));
        for (const line of wOut.split('\n')) {
          const parts = line.split('\t');
          if (parts.length >= 3 && parts[2].trim()) realChanged.add(parts[2].trim());
        }
        for (const rel of untracked) {
          if (status.has(rel)) continue;
          files.push(rel);
          status.set(rel, 'U');
          added.add(rel); // no base version → open as file, not diff
          // Untracked files never appear in `git diff --numstat` — count their lines ourselves so
          // new files get a `+N` triage signal too. Skipped for huge/binary files.
          const n = untrackedLineCount(cwd, rel);
          if (n !== null) stat.set(rel, { add: n, del: 0 });
        }
        for (const r of cachedOut.split('\n')) {
          const rel = r.trim();
          if (rel) staged.add(rel);
        }
        for (const r of dirtyOut.split('\n')) {
          const rel = r.trim();
          if (!rel) continue;
          dirty.add(rel);
          if (staged.has(rel)) staleStaged.add(rel); // working ≠ index on a staged file
        }
        // Branch range: a change that was committed and then undone in the working tree nets to zero
        // vs the merge-base, so the branch diff drops the file — while Source Control still lists it
        // (it differs from HEAD). List those too, flagged uncommitted-only, and diff them vs HEAD.
        const uncommittedOnly = [...staged, ...dirty].filter((r) => !status.has(r));
        if (this.listRef !== 'HEAD' && uncommittedOnly.length) {
          const keep = new Set(uncommittedOnly);
          const [hns, hnum] = await Promise.all([
            git(cwd, ['diff', '--name-status', 'HEAD']),
            git(cwd, ['diff', '--numstat', 'HEAD']),
          ]);
          addNameStatus(hns, (r) => {
            if (!keep.has(r) || status.has(r)) return false;
            wtOnly.add(r);
            return true;
          });
          parseNumstat(hnum).forEach((v, k) => wtOnly.has(k) && stat.set(k, v));
        }
        // Stage-on-view sync: staging outside vetty (Source Control panel) counts as a review too.
        // Only clean staged files (index == working tree) qualify — a stale-staged file's working
        // copy holds unreviewed edits.
        if (vscode.workspace.getConfiguration('vetty').get('stageOnView', false)) {
          const viewed = getViewed(this.context, this.base);
          const ignored = getIgnored(this.context, this.base);
          const auto = [...staged].filter(
            (r) => status.has(r) && !staleStaged.has(r) && !ignored.has(r) && !isViewed(cwd, viewed, r)
          );
          // Commit self-heal: format-on-commit hooks (lint-staged etc.) rewrite reviewed files
          // during the commit, so their hash-bound marks go stale even though the new content is
          // exactly what got committed. Commit ⊇ staging ⇒ view: a file that ALREADY holds a mark
          // and is now clean vs HEAD re-heals instead of dropping to Unviewed. Never creates marks.
          const healed = files.filter(
            (r) => viewed[r] !== undefined && !staged.has(r) && !dirty.has(r) && !deleted.has(r) &&
              !ignored.has(r) && !isViewed(cwd, viewed, r)
          );
          const marks = [...auto, ...healed];
          if (marks.length) {
            Object.assign(viewed, await viewedEntries(cwd, marks));
            await setViewed(this.context, this.base, viewed);
          }
        }
        this.untracked = untracked; // shared with the TODO scan (same refresh) — saves a `git ls-files`
        this._lastErr = null;
      } catch (e) {
        // Empty tree + a visible reason, once per distinct error (refreshes fire every ~400ms).
        const msg = String(e?.message || e).split('\n')[0];
        if (msg !== this._lastErr) vscode.window.showErrorMessage(`Vetty: ${msg}`);
        this._lastErr = msg;
      }
    }
    this.files = files;
    this.added = added;
    this.deleted = deleted;
    this.dirty = dirty; // working ≠ index — with `staged`, distinguishes committed (clean) rows
    this.wtOnly = wtOnly;
    // Basenames that occur more than once: only those rows show their folder (the rest is noise the
    // tooltip already carries).
    const seen = new Map();
    for (const f of files) seen.set(path.basename(f), (seen.get(path.basename(f)) || 0) + 1);
    this.dupNames = new Set([...seen].filter(([, n]) => n > 1).map(([b]) => b));
    this.status = status;
    this.stat = stat;
    this.realChanged = realChanged;
    this.staged = staged;
    this.staleStaged = staleStaged;
    // Drop group assignments for files no longer changed (committed/reverted). Skip in commit mode,
    // where `files` is only the uncommitted subset — pruning then would wrongly forget branch files.
    if (cwd && this.base && diffRange(this.context) !== 'commit') {
      const groups = getGroups(this.context, this.base);
      const fileSet = new Set(files);
      let changed = false;
      for (const r of Object.keys(groups)) if (!fileSet.has(r)) (delete groups[r], (changed = true));
      if (changed) await setGroups(this.context, this.base, groups);
    }
    this.refresh();
    this.updateProgress();
    require('./search').postSearchCounts(); // lazy: search requires this module's app refs via core
    fileDecorations.refresh();
    app.todoTree?.load();
    require('./guided-notes').syncAiThreads(); // Claude notes: rebuilt only when the review file/branch changed
    await this._guidedStatus(cwd);
    // Publish the exact review set so a Claude session annotates what Vetty lists — not its own guess
    // at the diff (Vetty's base is often a parent branch, and it counts uncommitted + untracked files).
    if (cwd && this.base) {
      const ignored = getIgnored(this.context, this.base);
      core.writeScope({
        branch: core.activeBranchName(),
        base: this.base,
        mergeBase: this.baseRef,
        range: diffRange(this.context),
        files: files.filter((f) => !ignored.has(f)).map((f) => ({ file: f, status: status.get(f) })),
      });
    }
    core.dbg(`load done — ${Date.now() - t0}ms, ${files.length} files (base ${this.base})`);
  }

  /** Staleness of the guided review (commits since it was written) + announce (re)annotations.
   *  `behind` is one `git rev-list --count` per load, only while Guided Review is on with a review. */
  async _guidedStatus(cwd) {
    const stamp = core.claudeReviewStamp();
    const review = core.guidedReviewOn(this.context) ? core.claudeReview() : null;
    this.guidedBehind = null;
    if (review?.head && cwd) {
      try {
        this.guidedBehind = parseInt(await git(cwd, ['rev-list', '--count', `${review.head}..HEAD`]), 10) || 0;
      } catch {
        this.guidedBehind = null; // head unknown (rewritten history) — no number to show
      }
    }
    // Announce once per file version: a new/updated review is easy to miss with the toggle off.
    if (stamp === this.guidedStamp) return;
    const first = this.guidedStamp === undefined;
    this.guidedStamp = stamp;
    if (first || !stamp) return; // startup / deletion — nothing to announce
    const forBranch = core.claudeReviewFileBranch();
    if (!core.guidedReviewOn(this.context)) {
      if (forBranch && forBranch !== core.activeBranchName()) return; // another branch's — silent
      vscode.window
        .showInformationMessage(`Guided review ready for ${forBranch || 'this branch'}.`, 'Turn on')
        .then((pick) => pick === 'Turn on' && require('./review-nav').toggleGuidedReview(this.context));
    } else if (review) {
      const n = this.steps().size;
      vscode.window.setStatusBarMessage(`Guided review updated: ${n} file${n === 1 ? '' : 's'}, ${review.comments.length} notes`, 4000);
    }
  }

  /** Show "N/total viewed · <mode>" by the title + a comment-count badge on the view. */
  updateProgress() {
    if (!app.diffTreeView) return;
    vscode.commands.executeCommand('setContext', 'vetty.hasBase', !!this.base); // drives viewsWelcome
    const cwd = getCwd();
    const order = this.guidedSummary();
    const mode = `range: ${DIFF_RANGE_SHORT[diffRange(this.context)]} · compare: ${sinceReviewOn(this.context) ? 'last viewed' : 'base'}${order}`;
    if (!cwd || !this.base) {
      app.diffTreeView.description = mode;
      app.diffTreeView.badge = undefined;
      return;
    }
    const viewed = getViewed(this.context, this.base);
    const ignored = getIgnored(this.context, this.base);
    const active = this.files.filter((f) => !ignored.has(f));
    const vw = active.filter((f) => isViewed(cwd, viewed, f)).length;
    const progress = !active.length ? '' : vw === active.length ? `✓ ${active.length}` : `${vw}/${active.length}`;
    // Make active filtering visible: a chip/name/group/search filter can silently hide files.
    const shown = this.visibleFiles(cwd).length;
    const filtered = shown < active.length ? `⚠ filtered: ${shown} of ${active.length}` : '';
    app.diffTreeView.description = [filtered, progress, mode].filter(Boolean).join('  ·  ');
    // Activity-bar badge = unviewed file count (like Source Control's change count).
    const unviewed = active.length - vw;
    app.diffTreeView.badge = unviewed ? { value: unviewed, tooltip: `${unviewed} unviewed file(s)` } : undefined;
  }

  /** " · guided · 2h ago · 3 commits behind · 2 unannotated" for the view description ('' when off/none). */
  guidedSummary() {
    const review = core.guidedReviewOn(this.context) ? core.claudeReview() : null;
    const steps = this.steps();
    if (!review || !steps.size) return '';
    const ignored = getIgnored(this.context, this.base);
    const missing = this.files.filter((f) => !ignored.has(f) && !steps.has(f)).length;
    return [
      ' · guided',
      ago(review.writtenAt),
      this.guidedBehind ? `${this.guidedBehind} commit${this.guidedBehind === 1 ? '' : 's'} behind` : '',
      missing ? `${missing} unannotated` : '',
    ].filter(Boolean).join(' · ');
  }

  getTreeItem(el) {
    return el;
  }

  getParent(el) {
    return el ? el.parent : undefined;
  }

  /** Reveal + select a file row (used by auto-advance so the list highlights the open file). */
  revealFile(rel) {
    const it = this.itemByRel.get(rel);
    if (it && app.diffTreeView && app.diffTreeView.visible) app.diffTreeView.reveal(it, { select: true, focus: false }).then(undefined, () => {});
  }

  // Stamp each child with its parent (for getParent/reveal) and index file rows by path.
  getChildren(el) {
    if (!el) this.itemByRel = new Map();
    const children = this._children(el) || [];
    for (const c of children) {
      c.parent = el || undefined;
      if (c.rel) this.itemByRel.set(c.rel, c);
    }
    return children;
  }

  _children(el) {
    const cwd = getCwd();
    if (!cwd) return [];

    // A file row in search mode expands to its matching lines.
    if (el && el.matches) {
      return el.matches.map((mt) => {
        const it = new vscode.TreeItem(`${mt.line}: ${mt.text.trim().slice(0, 120)}`);
        it.iconPath = new vscode.ThemeIcon('search');
        it.tooltip = `${el.rel}:${mt.line}`;
        // Select the matched text so it's highlighted on open.
        it.command = { command: 'vetty.openMatch', title: 'Open', arguments: [el.rel, mt.line, mt.col || 0, mt.len || 0] };
        return it;
      });
    }

    if (!this.base) return []; // viewsWelcome shows the "pick a branch" message

    if (!el) {
      if (!this.files.length) return []; // viewsWelcome shows the "no changes" message
      const viewed = getViewed(this.context, this.base);
      const ignored = getIgnored(this.context, this.base);
      const shown = this._ordered(this.files.filter((f) => this._matches(cwd, viewed, f)));
      const active = shown.filter((f) => !ignored.has(f));
      const unv = active.filter((f) => !isViewed(cwd, viewed, f));
      const vw = active.filter((f) => isViewed(cwd, viewed, f));
      const ig = shown.filter((f) => ignored.has(f));
      return [
        this._group(`Unviewed (${unv.length}) · vs ${shortRef(this.base)}`, unv, true, false, 'group-unviewed', `vs ${this.base}`),
        this._group(`Viewed (${vw.length})`, vw, false, false, 'group-viewed'), // starts collapsed; VS Code keeps your toggle,
        this._group(`Ignored (${ig.length})`, ig, false, true, 'group-ignored'),
      ];
    }

    // Group or folder node: flat list (paged), or one level of the folder tree when nested.
    const files = el.files || [];
    if (this.nested) return this._folderChildren(cwd, files, el.prefix || '', !!el.ignored);

    // Flat mode can be thousands of rows; page it so a huge PR stays responsive.
    const key = el.contextValue || 'group';
    const limit = this.pageLimits[key] || PAGE_SIZE;
    const rows = files.slice(0, limit).map((f) => this._file(cwd, f, !!el.ignored));
    if (files.length > limit) {
      const more = new vscode.TreeItem(`Show ${Math.min(PAGE_SIZE, files.length - limit)} more… (${files.length - limit} hidden)`);
      more.iconPath = new vscode.ThemeIcon('ellipsis');
      more.command = { command: 'vetty.showMore', title: 'Show more', arguments: [key] };
      rows.push(more);
    }
    return rows;
  }

  /** Immediate children (subfolders + files) of `prefix` within `files`, for the nested view. */
  _folderChildren(cwd, files, prefix, isIgnored) {
    const folders = new Map(); // segment → files under it
    const leaves = [];
    for (const rel of files) {
      const rest = rel.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) leaves.push(rel);
      else {
        const seg = rest.slice(0, slash);
        if (!folders.has(seg)) folders.set(seg, []);
        folders.get(seg).push(rel);
      }
    }
    const folderNodes = [...folders.entries()].map(([seg, fs]) => {
      const it = new vscode.TreeItem(seg, vscode.TreeItemCollapsibleState.Expanded);
      it.iconPath = vscode.ThemeIcon.Folder;
      it.files = fs;
      it.prefix = prefix + seg + '/';
      it.ignored = isIgnored;
      it.contextValue = 'folder';
      it.id = `folder:${this.base}:${it.prefix}`; // stable → keeps expand state
      return it;
    });
    return [...folderNodes, ...leaves.map((f) => this._file(cwd, f, isIgnored))];
  }

  _group(label, files, expanded, ignored, contextValue, tooltip) {
    const it = new vscode.TreeItem(
      label,
      expanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
    );
    it.files = files;
    it.ignored = !!ignored;
    it.contextValue = contextValue || 'group';
    it.id = contextValue || 'group'; // stable id so VS Code keeps expand/collapse across refreshes
    if (tooltip) it.tooltip = tooltip;
    return it;
  }

  /** Row hover card: name + change kind, folder, one line per state, then Claude's why (Guided Review). */
  _tooltip(rel, { isIgnored, viewed, snap, isClean, nComments, step }) {
    const KIND = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'New file' };
    const facts = [
      isIgnored ? 'Ignored (review noise)' : viewed ? 'Viewed' : snap ? 'Unviewed — edited since you viewed it' : 'Unviewed',
      this.wtOnly?.has(rel) ? 'Uncommitted only — the working tree undoes a committed change (diff vs HEAD)' : '',
      this.staleStaged?.has(rel) ? 'Staged, but edited since — restage before commit'
        : this.staged?.has(rel) ? 'Staged'
        : isClean && !isIgnored ? 'Committed — no uncommitted changes' : '',
      nComments ? `${nComments} open comment${nComments === 1 ? '' : 's'} — blocks auto-stage` : '',
    ].filter(Boolean);
    const dir = path.dirname(rel);
    const md = new vscode.MarkdownString();
    md.appendMarkdown('**').appendText(path.basename(rel)).appendMarkdown('**');
    const kind = KIND[this.status.get(rel)];
    if (kind) md.appendText(`  ·  ${kind}${this.wtOnly?.has(rel) ? ' vs HEAD' : ` vs ${this.base}`}`);
    if (dir !== '.') md.appendMarkdown('\n\n').appendText(dir);
    md.appendMarkdown('\n\n---\n\n');
    for (const f of facts) md.appendMarkdown('- ').appendText(f).appendMarkdown('\n');
    if (step) {
      md.appendMarkdown(`\n---\n\n**Guided #${step.n}**`);
      if (step.note) md.appendText(`  ·  ${step.note}`);
    } else if (!isIgnored && this.steps().size) {
      md.appendMarkdown('\n---\n\n_Not in guided review_ — re-run the annotation to cover this file.');
    }
    return md;
  }

  _file(cwd, rel, isIgnored) {
    const dir = path.dirname(rel);
    const hits = this.searchMatches && this.searchMatches.get(rel);
    // Leading stage marker: `*` staged, `^` staged but edited since staging (restage before commit).
    const stageMark = this.staleStaged?.has(rel) ? '^ ' : this.staged?.has(rel) ? '* ' : '';
    const it = new vscode.TreeItem(
      stageMark + path.basename(rel), // filename first, like Source Control
      hits ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
    );
    const s = this.stat.get(rel);
    const counts = s ? `+${s.add} −${s.del}` : ''; // triage signal: how big is this change
    const dirPart = this.nested || dir === '.' || !this.dupNames?.has(path.basename(rel)) ? '' : dir; // only to disambiguate
    const matchPart = hits ? `${hits.length} match${hits.length === 1 ? '' : 'es'}` : '';
    const group = getGroups(this.context, this.base)[rel];
    const groupPart = group ? `[${group}]` : '';
    // 💬N = open comments (changes requested) — also why stage-on-view skips this file.
    const nComments = (require('./comments').getComments(this.context)[rel] || []).length;
    const commentPart = nComments ? `💬${nComments}` : '';
    // ↻ = viewed before, edited since — a re-review, not a first look (snapshot restorable).
    const viewedNow = isViewed(cwd, getViewed(this.context, this.base), rel);
    const rePart =
      !viewedNow && !isIgnored && reviewedBlob(getViewed(this.context, this.base), rel) ? '↻' : ''; // edited since viewed (tooltip explains)
    const wtPart = this.wtOnly?.has(rel) ? 'uncommitted' : ''; // not in the branch diff (tooltip explains)
    // Claude's review order: `#n` + its one-line why, while the sort toggle is on.
    const step = this.steps().get(rel);
    const stepPart = step ? `#${step.n}` : '';
    it.description = [stepPart, groupPart, matchPart, counts, wtPart, commentPart, rePart, dirPart]
      .filter(Boolean)
      .join('  ·  ');
    if (hits) it.matches = hits; // makes the row expandable into its matching lines
    const viewed = viewedNow;
    it.rel = rel;
    it.id = `file:${this.base}:${rel}`; // stable id so reveal() can match across refreshes
    it.resourceUri = vscode.Uri.file(path.join(cwd, rel));
    // Suffixes (menu when-clauses match by prefix/regex so they stay invisible unless asked for):
    //   -snap   = unviewed with a last-viewed snapshot → row offers "Revert to Last Viewed" inline
    //   -staged = in the index → drives Stage↔Unstage and View & Stage / Unview & Unstage labels
    //   -clean  = no uncommitted changes (committed) → Stage / & Stage / Revert Changes all hide
    const snap = !!rePart;
    const isClean =
      !this.staged?.has(rel) && !this.dirty?.has(rel) && this.status.get(rel) !== 'U';
    const suffix = isIgnored ? '' : this.staged?.has(rel) ? '-staged' : isClean ? '-clean' : '';
    it.contextValue = isIgnored
      ? 'file-ignored'
      : (viewed ? 'file-viewed' : snap ? 'file-unviewed-snap' : 'file-unviewed') + suffix;
    it.tooltip = this._tooltip(rel, { isIgnored, viewed, snap, isClean, nComments, step });
    // During a search, clicking the row toggles its matches (no command) instead of opening.
    if (!hits) {
      // Added file → open whole file, UNLESS it has a since-review snapshot to diff against.
      const cmd = this.added.has(rel) && !hasSinceReviewDiff(this.context, cwd, this.base, rel)
        ? 'vetty.treeOpenFile'
        : 'vetty.treeOpenDiff';
      it.command = { command: cmd, title: 'Open', arguments: [it] };
    }
    return it;
  }
}

/** Parent rows for a per-file list (TODOs, comments): file icon + name, dir + count dimmed, expanded.
 *  `pairs` = [rel, entry][]; returns TreeItems carrying `.rel` and `.entries` (insertion order kept). */
function fileGroups(cwd, pairs, kind) {
  const byRel = new Map();
  for (const [rel, e] of pairs) (byRel.get(rel) || byRel.set(rel, []).get(rel)).push(e);
  return [...byRel].map(([rel, entries]) => {
    const it = new vscode.TreeItem(path.basename(rel), vscode.TreeItemCollapsibleState.Expanded);
    const dir = path.dirname(rel);
    it.description = [dir === '.' ? '' : dir, String(entries.length)].filter(Boolean).join('  ·  ');
    it.tooltip = rel;
    if (cwd) it.resourceUri = vscode.Uri.file(path.join(cwd, rel)); // → file-type icon
    it.id = `${kind}-file:${rel}`; // stable → keeps expand state across refreshes
    it.contextValue = `${kind}File`;
    it.rel = rel;
    it.entries = entries;
    return it;
  });
}

module.exports = { DiffTree, fileDecorations, fileGroups, untrackedLineCount, PAGE_SIZE };
