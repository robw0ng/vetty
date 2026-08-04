// The Activity Bar views: DiffTree (changed files, Unviewed/Viewed/Untracked), TodoTree, file
// decorations, and the open/navigate/toggle behaviors that belong to them.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { parseNumstat } = require('../lib');
const core = require('./core');
const {
  app, getCwd, git, untrackedFiles, getViewed, setViewed, viewedEntries, getIgnored, getGroups, setGroups, isViewed,
  resolveBase, mergeBaseRef, lastBranch, shortRef, baseUriFor, blobUriFor, reviewedBlob,
  DIFF_RANGE_SHORT, diffRange, sinceReviewOn, hasSinceReviewDiff, findTodos, refreshTree,
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
    return {
      badge: letter,
      tooltip: `Changed vs ${app.diffTree.base} (${letter})`,
      color: color ? new vscode.ThemeColor(color) : undefined,
    };
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
    return this.files.filter((f) => !ignored.has(f) && this._matches(cwd, viewed, f));
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
        for (const line of out.split('\n')) {
          const parts = line.split('\t');
          if (parts.length < 2) continue;
          const rel = parts[parts.length - 1].trim(); // rename → new path
          if (!rel) continue;
          const letter = parts[0].trim()[0];
          files.push(rel);
          status.set(rel, letter);
          if (letter === 'A') added.add(rel);
          if (letter === 'D') deleted.add(rel);
        }
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
        const dirty = new Set(); // working ≠ index (any file)
        for (const r of dirtyOut.split('\n')) {
          const rel = r.trim();
          if (!rel) continue;
          dirty.add(rel);
          if (staged.has(rel)) staleStaged.add(rel); // working ≠ index on a staged file
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
      } catch {
        // leave empty
      }
    }
    this.files = files;
    this.added = added;
    this.deleted = deleted;
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
    core.dbg(`load done — ${Date.now() - t0}ms, ${files.length} files (base ${this.base})`);
  }

  /** Show "N/total viewed · <mode>" by the title + a comment-count badge on the view. */
  updateProgress() {
    if (!app.diffTreeView) return;
    vscode.commands.executeCommand('setContext', 'vetty.hasBase', !!this.base); // drives viewsWelcome
    const cwd = getCwd();
    const mode = `range: ${DIFF_RANGE_SHORT[diffRange(this.context)]} · compare: ${sinceReviewOn(this.context) ? 'last viewed' : 'base'}`;
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
      const shown = this.files.filter((f) => this._matches(cwd, viewed, f));
      const active = shown.filter((f) => !ignored.has(f));
      const unv = active.filter((f) => !isViewed(cwd, viewed, f));
      const vw = active.filter((f) => isViewed(cwd, viewed, f));
      const ig = shown.filter((f) => ignored.has(f));
      return [
        this._group(`Unviewed (${unv.length}) · vs ${shortRef(this.base)}`, unv, true, false, 'group-unviewed', `vs ${this.base}`),
        this._group(`Viewed (${vw.length})`, vw, true, false, 'group-viewed'),
        this._group(`Untracked (${ig.length})`, ig, false, true, 'group-ignored'),
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
    const dirPart = this.nested || dir === '.' ? '' : dir; // dir shown by hierarchy when nested
    const matchPart = hits ? `${hits.length} match${hits.length === 1 ? '' : 'es'}` : '';
    const group = getGroups(this.context, this.base)[rel];
    const groupPart = group ? `[${group}]` : '';
    it.description = [groupPart, matchPart, counts, dirPart].filter(Boolean).join('  ·  ');
    if (hits) it.matches = hits; // makes the row expandable into its matching lines
    const viewed = isViewed(cwd, getViewed(this.context, this.base), rel);
    it.rel = rel;
    it.id = `file:${this.base}:${rel}`; // stable id so reveal() can match across refreshes
    it.resourceUri = vscode.Uri.file(path.join(cwd, rel));
    // -snap suffix = unviewed but a last-viewed snapshot exists → the row offers "Revert to Last
    // Viewed" inline. Menu when-clauses match by prefix so the suffix stays invisible to them.
    const snap = !viewed && !isIgnored && reviewedBlob(getViewed(this.context, this.base), rel);
    it.contextValue = isIgnored ? 'file-ignored' : viewed ? 'file-viewed' : snap ? 'file-unviewed-snap' : 'file-unviewed';
    const stageNote = this.staleStaged?.has(rel)
      ? ' — staged, but modified since (restage before commit)'
      : this.staged?.has(rel) ? ' — staged' : '';
    const delNote = this.deleted.has(rel) ? ' — deleted by this branch' : '';
    it.tooltip = `${rel} — ${isIgnored ? 'untracked' : viewed ? 'viewed' : 'unviewed'}${delNote}${stageNote}`;
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

/** Side-panel "New TODOs" view: TODO/FIXME markers introduced vs the selected branch. */
class TodoTree {
  constructor(context) {
    this.context = context;
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    this.items = [];
  }
  refresh() {
    this._emitter.fire();
  }
  async load() {
    const cwd = getCwd();
    const ref = app.diffTree?.listRef; // honor the active diff mode (branch merge-base vs HEAD)
    this.items = cwd && ref ? await findTodos(cwd, ref) : [];
    this.refresh();
  }
  getTreeItem(el) {
    return el;
  }
  getChildren(el) {
    if (el) return [];
    const cwd = getCwd();
    // Slice TODOs by the Review panel's active filter (group / scope / name / search) for a focused view.
    const visible = cwd && app.diffTree ? new Set(app.diffTree.visibleFiles(cwd)) : null;
    const items = visible ? this.items.filter((t) => visible.has(t.rel)) : this.items;
    if (!items.length) {
      const it = new vscode.TreeItem('No TODOs');
      it.iconPath = new vscode.ThemeIcon('check');
      return [it];
    }
    return items.map((t) => {
      const msg = t.text.replace(/^\s*(\/\/+|#+|\/\*+|\*+|<!--|--)\s?/, '').replace(/\s*(\*\/|-->)\s*$/, '').trim();
      const it = new vscode.TreeItem(msg || t.text);
      it.description = `${path.basename(t.rel)}:${t.line}`; // filename:line, dimmed
      it.tooltip = `${t.rel}:${t.line}\n\n${t.text}`;
      it.iconPath = new vscode.ThemeIcon('checklist');
      it.todo = t; // for multi-select copy
      it.contextValue = 'vettyTodo'; // gates the row menu/buttons (the "No TODOs" row has none)
      it.command = { command: 'vetty.openTodo', title: 'Open', arguments: [t.rel, t.line] };
      return it;
    });
  }
}

/** Ctrl/Cmd+C in the Todos view: copy the selected TODOs as `file:line — text`. */
async function copyTodos() {
  const lines = (app.todoTreeView?.selection || [])
    .filter((i) => i.todo)
    .map((i) => `- ${i.todo.rel}:${i.todo.line} — ${i.todo.text.trim()}`);
  if (!lines.length) return;
  await vscode.env.clipboard.writeText(lines.join('\n'));
  vscode.window.setStatusBarMessage(`Copied ${lines.length} TODO(s)`, 2000);
}

/** Right-click "Go to" on a TODO row (row click does the same; this covers the menu). */
async function todoOpenItem(item) {
  if (item?.todo) await openTodo(item.todo.rel, item.todo.line);
}

/** Copy the clicked TODO row (or the multi-selection) as paste-ready bullets. */
async function todoCopyItems(item, sel) {
  const items = Array.isArray(sel) && sel.length ? sel : item ? [item] : [];
  const lines = items.filter((i) => i?.todo).map((i) => `- ${i.todo.rel}:${i.todo.line} — ${i.todo.text.trim()}`);
  if (!lines.length) return;
  await vscode.env.clipboard.writeText(lines.join('\n'));
  vscode.window.setStatusBarMessage(`Copied ${lines.length} TODO(s)`, 2000);
}

/** Toolbar: copy ALL currently-shown TODOs (respects the active Review filters) as bullets. */
async function exportTodos() {
  const cwd = getCwd();
  const visible = cwd && app.diffTree ? new Set(app.diffTree.visibleFiles(cwd)) : null;
  const items = (app.todoTree?.items || []).filter((t) => !visible || visible.has(t.rel));
  if (!items.length) {
    vscode.window.showInformationMessage('No TODOs to export.');
    return;
  }
  await vscode.env.clipboard.writeText(items.map((t) => `- ${t.rel}:${t.line} — ${t.text.trim()}`).join('\n') + '\n');
  vscode.window.showInformationMessage(`Copied ${items.length} TODO(s) to the clipboard.`);
}

async function openTodo(rel, line) {
  const cwd = getCwd();
  if (!cwd) return;
  const uri = vscode.Uri.file(path.join(cwd, rel));
  const doc = await vscode.workspace.openTextDocument(uri);
  const l = Math.min(Math.max(line - 1, 0), Math.max(doc.lineCount - 1, 0));
  const text = doc.lineAt(l).text;
  const m = text.match(core.TODO_RE); // highlight the marker → end of line, like a search hit
  const sel = m ? new vscode.Range(l, m.index, l, text.length) : new vscode.Range(l, 0, l, 0);
  await vscode.window.showTextDocument(doc, { selection: sel });
}

/** Open a file and select (highlight) the matched text at a search hit. */
async function openMatch(rel, line, col, len) {
  const cwd = getCwd();
  if (!cwd) return;
  const uri = vscode.Uri.file(path.join(cwd, rel));
  const sel = new vscode.Range(line - 1, col, line - 1, col + len);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { selection: sel });
}

/** Open one file's diff: since-review overlay wins when active; otherwise the range's base.
 *  Deleted files diff against an EMPTY right side (there's no working file to show). */
function openOneDiff(context, cwd, base, rel, opts) {
  const fileUri = vscode.Uri.file(path.join(cwd, rel));
  const gone = app.diffTree?.deleted?.has(rel);
  const rightUri = gone ? baseUriFor(fileUri, '') : fileUri; // ref '' → the provider returns ''
  const rightLabel = gone ? 'deleted' : 'working';
  if (hasSinceReviewDiff(context, cwd, base, rel)) {
    const blob = reviewedBlob(getViewed(context, base), rel);
    return vscode.commands.executeCommand('vscode.diff', blobUriFor(fileUri, blob), rightUri, `${rel} (last viewed ↔ ${rightLabel})`, opts);
  }
  if (diffRange(context) === 'commit') {
    // Working tree vs HEAD = uncommitted changes only. New/untracked files → empty left side.
    return vscode.commands.executeCommand('vscode.diff', baseUriFor(fileUri, 'HEAD'), rightUri, `${rel} (uncommitted${gone ? ' ↔ deleted' : ''})`, opts);
  }
  const ref = (app.diffTree && app.diffTree.baseRef) || base; // whole branch: diff against the merge-base
  return vscode.commands.executeCommand('vscode.diff', baseUriFor(fileUri, ref), rightUri, `${rel} (${base} ↔ ${rightLabel})`, opts);
}

/** Open a changed file the right way: whole file for new files, else its diff. */
async function openReviewFile(context, cwd, base, rel, opts = { preview: true }) {
  if (app.diffTree.added.has(rel) && !hasSinceReviewDiff(context, cwd, base, rel)) {
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(cwd, rel)), opts);
  } else {
    await openOneDiff(context, cwd, base, rel, opts);
  }
}

/** j/k navigation: open the next/prev unviewed file relative to the active one. */
async function navigateUnviewed(context, dir) {
  const cwd = getCwd();
  const base = app.diffTree?.base;
  if (!cwd || !base) return;
  const viewed = getViewed(context, base);
  const unviewed = app.diffTree.visibleFiles(cwd).filter((f) => !isViewed(cwd, viewed, f)); // within the filtered slice
  if (!unviewed.length) {
    vscode.window.setStatusBarMessage('No unviewed files', 2000);
    return;
  }
  const cur = core.activeRelPath(cwd);
  const idx = cur ? unviewed.indexOf(cur) : -1;
  const next =
    idx >= 0 ? unviewed[(idx + dir + unviewed.length) % unviewed.length] : unviewed[dir > 0 ? 0 : unviewed.length - 1];
  await openReviewFile(context, cwd, base, next);
  app.diffTree.revealFile(next); // highlight it in the list
}

/** Expand all groups + their folders (VS Code expands up to 3 levels per reveal). */
async function expandAll() {
  if (!app.diffTree || !app.diffTreeView) return;
  const roots = app.diffTree.getChildren();
  for (const g of Array.isArray(roots) ? roots : []) {
    if (!g || !g.files) continue; // skip the welcome/placeholder item
    try {
      await app.diffTreeView.reveal(g, { select: false, focus: false, expand: 3 });
    } catch {
      // reveal can reject if the view isn't ready — ignore
    }
  }
}

/** Collapse the nested folders but leave the Unviewed/Viewed/Untracked groups expanded. */
async function collapseFolders() {
  if (!app.diffTree || !app.diffTreeView) return;
  await vscode.commands.executeCommand('workbench.actions.treeView.vettyView.collapseAll'); // collapses everything
  const roots = app.diffTree.getChildren();
  for (const g of Array.isArray(roots) ? roots : []) {
    if (!g || !g.files) continue;
    try {
      await app.diffTreeView.reveal(g, { select: false, focus: false, expand: 1 }); // re-open just the group (folders stay collapsed)
    } catch {
      // ignore
    }
  }
}

function showMore(groupKey) {
  if (!app.diffTree) return;
  app.diffTree.pageLimits[groupKey] = (app.diffTree.pageLimits[groupKey] || PAGE_SIZE) + PAGE_SIZE;
  app.diffTree.refresh();
}

async function toggleNesting(context) {
  if (!app.diffTree) return;
  app.diffTree.nested = !app.diffTree.nested;
  await context.workspaceState.update('vetty.nested', app.diffTree.nested);
  await vscode.commands.executeCommand('setContext', 'vetty.nested', app.diffTree.nested);
  refreshTree();
}

async function toggleWhitespace(context) {
  if (!app.diffTree) return;
  app.diffTree.hideWhitespace = !app.diffTree.hideWhitespace;
  await context.workspaceState.update('vetty.hideWhitespace', app.diffTree.hideWhitespace);
  await vscode.commands.executeCommand('setContext', 'vetty.hideWhitespace', app.diffTree.hideWhitespace);
  await app.diffTree.load(); // realChanged is only computed while the toggle is on → needs a reload, not a re-render
}

/** Range toggle: whole-branch (vs merge-base) ⇄ since-last-commit (vs HEAD). Changes the file set. */
async function toggleRange(context) {
  const next = diffRange(context) === 'commit' ? 'branch' : 'commit';
  await context.workspaceState.update('vetty.diffRange', next);
  await vscode.commands.executeCommand('setContext', 'vetty.diffRange', next);
  await app.diffTree.load(); // the listed file set differs (branch changes vs uncommitted-vs-HEAD)
  vscode.window.setStatusBarMessage(`Range: ${DIFF_RANGE_SHORT[next]}`, 2000);
}

/** Since-review overlay toggle: unviewed files diff against your last-reviewed snapshot. */
async function toggleSinceReview(context) {
  const next = !sinceReviewOn(context);
  await context.workspaceState.update('vetty.sinceReview', next);
  await vscode.commands.executeCommand('setContext', 'vetty.sinceReview', next);
  await app.diffTree.load();
  vscode.window.setStatusBarMessage(`Compare: ${next ? 'last viewed' : 'base'}`, 2000);
}

module.exports = {
  DiffTree, TodoTree, fileDecorations,
  copyTodos, openTodo, openMatch, todoOpenItem, todoCopyItems, exportTodos,
  openOneDiff, openReviewFile, navigateUnviewed,
  expandAll, collapseFolders, showMore,
  toggleNesting, toggleWhitespace, toggleRange, toggleSinceReview,
};
