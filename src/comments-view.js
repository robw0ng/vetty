// The Comments view: sidebar list of this branch's comments (yours + pulled PR threads) and Claude's
// guided notes, plus the row actions (go to, edit, copy, delete). Mirrors Rider's Comments section.
const vscode = require('vscode');
const path = require('path');
const { lineRef, tablesToText } = require('../lib');
const { app, getCwd } = require('./core');
const { fileGroups } = require('./tree');
const comments = require('./comments');
const pr = require('./pr');
const guidedNotes = require('./guided-notes');

class CommentsTree {
  constructor(context) {
    this.context = context;
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
  }
  refresh() {
    this._emitter.fire();
    if (app.commentsTreeView) {
      const map = comments.getComments(this.context);
      const n = Object.values(map).reduce((a, notes) => a + notes.length, 0) + pr.prThreads().length + guidedNotes.aiThreads().length;
      app.commentsTreeView.description = n ? String(n) : '';
    }
  }
  getTreeItem(el) {
    return el;
  }
  getChildren(el) {
    if (el) return el.entries;
    const map = comments.getComments(this.context);
    const pairs = []; // yours + PR threads → "Comments"
    const guided = []; // Claude's notes → "Guided review"
    for (const rel of Object.keys(map)) {
      (map[rel] || []).forEach((n, i) => {
        const text = n.comments.join(' / ').replace(/\s+/g, ' ').trim();
        const loc = lineRef(n.range[0], n.range[2], n.range[3]);
        const it = new vscode.TreeItem(text || '(empty)');
        it.description = `:${loc}`; // the file is the parent row
        it.tooltip = `${rel}:${loc}\n\n${n.comments.join('\n\n')}`;
        it.iconPath = new vscode.ThemeIcon('comment');
        it.note = { rel, i }; // index into the stored per-file array, for edit/delete
        it.contextValue = 'vettyComment';
        it.command = { command: 'vetty.commentGoTo', title: 'Go to', arguments: [rel, n.range[0], n.anchor] };
        pairs.push([rel, it]);
      });
    }
    // Pulled PR threads (read-only; Delete hides them locally).
    for (const t of pr.prThreads()) {
      const line = t.range.start.line;
      const it = new vscode.TreeItem((t.prBody || '').replace(/\s+/g, ' ').trim() || '(empty)');
      it.description = `:${line + 1}  ·  PR @${t.prAuthor}${t.label?.startsWith('✓') ? ' · resolved' : ''}`;
      it.tooltip = `${t.prRel}:${line + 1} — ${t.label}\n\n@${t.prAuthor}: ${t.prBody}`;
      it.iconPath = new vscode.ThemeIcon('comment-discussion');
      it.pr = t;
      it.contextValue = 'vettyPrComment';
      it.command = { command: 'vetty.commentGoTo', title: 'Go to', arguments: [t.prRel, line] };
      pairs.push([t.prRel, it]);
    }
    // Claude context notes. Label = first line (bullet marker stripped); full markdown on hover.
    for (const t of guidedNotes.aiThreads()) {
      const line = t.range.start.line;
      const first = t.ai.body.split('\n').map((l) => l.replace(/^\s*([-*+]|\d+\.|\|)\s*/, '').trim()).find(Boolean);
      const it = new vscode.TreeItem(first || '(empty)');
      it.description = `:${line + 1}${t.ai.big ? '  ·  big picture' : ''}`; // the section already says Claude
      it.tooltip = new vscode.MarkdownString(`${t.ai.big ? '**Big picture**\n\n' : ''}${tablesToText(t.ai.body)}`);
      it.iconPath = new vscode.ThemeIcon(t.ai.big ? 'map' : 'sparkle');
      it.ai = t.ai;
      it.contextValue = 'vettyAiComment';
      it.command = { command: 'vetty.commentGoTo', title: 'Go to', arguments: [t.ai.file, line] };
      guided.push([t.ai.file, it]);
    }
    if (!pairs.length && !guided.length) {
      const it = new vscode.TreeItem('No comments');
      it.iconPath = new vscode.ThemeIcon('check');
      return [it];
    }
    if (!guided.length) return fileGroups(getCwd(), pairs, 'comment'); // no guided review → no extra level
    // Two sections so Claude's notes can be collapsed away, leaving just your comments. Stable ids →
    // VS Code remembers each section's collapsed state across refreshes and reloads.
    const section = (id, label, icon, entries) => {
      const it = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
      it.id = id;
      it.iconPath = new vscode.ThemeIcon(icon);
      it.contextValue = id;
      it.entries = entries;
      return it;
    };
    return [
      section('commentSection', `Comments (${pairs.length})`, 'comment', fileGroups(getCwd(), pairs, 'comment')),
      section('guidedSection', `Guided review (${guided.length})`, 'sparkle', fileGroups(getCwd(), guided, 'guided')),
    ];
  }
}

/** Jump to a comment's line in the working file (re-anchored by content, like opening the thread). */
async function commentGoTo(rel, line, anchor) {
  const cwd = getCwd();
  if (!cwd) return;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(cwd, rel)));
  const l = Math.min(comments.relocateLine(doc, line, anchor), Math.max(doc.lineCount - 1, 0));
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(l, 0, l, 0) });
}

/** Right-click "Go to" on a comment row (row click does the same; this covers the menu). */
async function commentOpen(context, item) {
  if (item?.pr) return commentGoTo(item.pr.prRel, item.pr.range.start.line);
  if (item?.ai) return commentGoTo(item.ai.file, item.command.arguments[1]); // [1] = relocated line
  const note = item?.note;
  if (!note) return;
  const n = comments.getComments(context)[note.rel]?.[note.i];
  if (n) await commentGoTo(note.rel, n.range[0], n.anchor);
}

/** Rows from a comments-view action: multi-selection if present, else the clicked row. A file header
 *  (or a whole section) stands for everything under it. */
function selectedItems(item, sel) {
  const picked = Array.isArray(sel) && sel.length ? sel : item ? [item] : [];
  const flat = (x) => (x?.entries ? x.entries.flatMap(flat) : [x]);
  return picked.flatMap(flat);
}
function selectedNotes(item, sel) {
  return selectedItems(item, sel).map((x) => x?.note).filter(Boolean);
}
function selectedPr(item, sel) {
  return selectedItems(item, sel).map((x) => x?.pr).filter(Boolean);
}
function selectedAi(item, sel) {
  return selectedItems(item, sel).map((x) => x?.ai).filter(Boolean);
}

async function commentDelete(context, item, sel) {
  const prs = selectedPr(item, sel);
  if (prs.length) await pr.dismissPrThreads(context, prs);
  const ai = selectedAi(item, sel);
  if (ai.length) guidedNotes.deleteAiNotes(ai);
  const notes = selectedNotes(item, sel);
  if (!notes.length) return;
  const map = comments.getComments(context);
  const drop = new Set(notes.map((n) => `${n.rel}\n${n.i}`));
  const next = {};
  for (const rel of Object.keys(map)) {
    const kept = (map[rel] || []).filter((_, i) => !drop.has(`${rel}\n${i}`));
    if (kept.length) next[rel] = kept;
  }
  await comments.saveAndRebuild(context, next);
  await comments.unviewOnCommentResolve(context, notes.map((n) => n.rel));
}

async function commentEdit(context, item) {
  const note = item?.note;
  if (!note) return;
  const map = comments.getComments(context);
  const n = map[note.rel]?.[note.i];
  if (!n) return;
  const value = await vscode.window.showInputBox({ prompt: `Comment on ${note.rel}`, value: n.comments.join('\n\n') });
  if (value === undefined) return; // Escape cancels
  const next = { ...map, [note.rel]: map[note.rel].map((x, i) => (i === note.i ? { ...x, comments: [value] } : x)) };
  await comments.saveAndRebuild(context, next);
}

async function commentCopy(context, item, sel) {
  const notes = selectedNotes(item, sel);
  const prs = selectedPr(item, sel);
  const ai = selectedAi(item, sel);
  if (!notes.length && !prs.length && !ai.length) return;
  const map = comments.getComments(context);
  const lines = notes
    .map((note) => {
      const n = map[note.rel]?.[note.i];
      if (!n) return null;
      const text = n.comments.join(' / ').replace(/\s+/g, ' ').trim();
      return `- ${note.rel}:${lineRef(n.range[0], n.range[2], n.range[3])} — ${text}`; // same format as Export
    })
    .filter(Boolean)
    .concat(prs.map((t) => `- ${t.prRel}:${t.range.start.line + 1} — ${(t.prBody || '').replace(/\s+/g, ' ').trim()}`));
  // Claude notes are multi-line markdown (bullets, tables) — keep their shape under a file:line heading.
  const aiBlocks = ai.map((c) => `### ${c.file}:${c.line + 1}${c.big ? ' (big picture)' : ''}\n\n${c.body}`);
  await vscode.env.clipboard.writeText([lines.join('\n'), aiBlocks.join('\n\n')].filter(Boolean).join('\n\n') + '\n');
  vscode.window.setStatusBarMessage(`Copied ${lines.length + aiBlocks.length} comment(s)`, 2000);
}

/** Section header Copy: everything under "Comments" or "Guided review" (section → file groups → rows). */
async function copySection(context, section) {
  const rows = (section?.entries || []).flatMap((g) => g.entries || []);
  if (rows.length) await commentCopy(context, null, rows);
}

module.exports = { CommentsTree, commentGoTo, commentOpen, commentDelete, commentEdit, commentCopy, copySection };
