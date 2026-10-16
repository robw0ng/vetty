// Claude's guided-review notes as read-only editor threads, rebuilt from the review file. Context,
// NOT change requests: they never block stage-on-view and aren't exported as tasks. Delete removes
// the note from the file itself, so it goes for both editors. Owns the live Claude threads.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { relocate, tablesToText } = require('../lib');
const { app, refreshTree, getCwd, claudeReview, claudeReviewPath, deleteClaudeComments, guidedReviewOn, guidedNotesExpanded } = require('./core');
const comments = require('./comments');
const pr = require('./pr');

const threads = [];
let shown = null; // key of what the live threads were built from (review object + included notes)

function aiThreads() {
  return threads;
}

/** Rebuild Claude threads when the review file (or branch) changed. Cheap no-op otherwise. */
function syncAiThreads() {
  const cwd = getCwd();
  const controller = comments.controller();
  const review = app.context && guidedReviewOn(app.context) ? claudeReview() : null; // Guided Review off → no notes
  // Only notes on files in this review — a note on a file Vetty doesn't list has no row to belong to.
  const inReview = new Set(app.diffTree?.files || []);
  const notes = (review?.comments || []).filter((c) => inReview.has(c.file));
  const key = review ? notes.map((c) => `${c.file}:${c.line}`).join('|') : null;
  if (!controller || !cwd || (review === shown?.review && key === shown?.key)) return;
  shown = { review, key };
  for (const t of threads) t.dispose();
  threads.length = 0;
  const linesOf = new Map(); // rel → current lines, to re-anchor notes the code has moved since
  for (const c of notes) {
    if (!linesOf.has(c.file)) {
      let lines = [];
      try {
        lines = fs.readFileSync(path.join(cwd, c.file), 'utf8').split(/\r?\n/);
      } catch {
        // deleted file — keep stored lines
      }
      linesOf.set(c.file, lines);
    }
    const fileLines = linesOf.get(c.file);
    // Clamp: a note whose line is gone (file shrank, anchor not found) still needs a real line to sit on.
    const last = Math.max(0, fileLines.length - 1);
    const line = Math.min(relocate(fileLines, c.line, c.anchor), last);
    const range = new vscode.Range(line, 0, Math.min(line + (c.endLine - c.line), last), 0);
    // The author line above the body says what kind of note it is, not who wrote it.
    const comment = { body: new vscode.MarkdownString(tablesToText(c.body)), mode: vscode.CommentMode.Preview, author: { name: c.big ? 'Big picture' : 'Detail' } };
    const thread = controller.createCommentThread(vscode.Uri.file(path.join(cwd, c.file)), range, [comment]);
    thread.isAi = true; // never persisted; delete = remove from the review file
    thread.ai = c;
    thread.canReply = false;
    thread.contextValue = 'aiComment';
    thread.label = 'Claude · guided review'; // source once, in the header
    thread.collapsibleState = aiState(c);
    threads.push(thread);
  }
  app.commentsTree?.refresh();
}

/** Big-picture notes always open; the rest follow "Guided notes: expanded/collapsed" (⋯ menu). A
 *  file dense with block notes reads better with them one click away. */
function aiState(c) {
  const open = c.big || (app.context && guidedNotesExpanded(app.context));
  return open ? vscode.CommentThreadCollapsibleState.Expanded : vscode.CommentThreadCollapsibleState.Collapsed;
}
/** Re-apply the expanded/collapsed preference to the live threads (no rebuild). */
function applyGuidedNotesState() {
  for (const t of threads) t.collapsibleState = aiState(t.ai);
}

/** Earliest line (0-based) holding a comment on `rel` — Claude notes (while shown), PR threads, or
 *  your own — else null. Opening a file scrolls here so notes above the first change aren't missed. */
function firstCommentLine(context, rel) {
  const lines = threads.filter((t) => t.ai.file === rel).map((t) => t.range.start.line);
  for (const t of pr.prThreads()) if (t.prRel === rel) lines.push(t.range.start.line);
  for (const n of comments.getComments(context)[rel] || []) lines.push(n.range[0]);
  return lines.length ? Math.min(...lines) : null;
}

/** Delete Claude notes from the shared review file, then rebuild. */
function deleteAiNotes(notes) {
  try {
    deleteClaudeComments(notes);
  } catch (e) {
    vscode.window.showErrorMessage(`Could not update the Claude review file: ${e.message}`);
  }
  syncAiThreads();
}

/** Palette: delete the guided review (Claude's order + all its notes) for this worktree — both
 *  editors, since they share the file. scope.json stays: Vetty rewrites it on every refresh anyway. */
async function clearGuidedReview() {
  const p = claudeReviewPath();
  if (!p || !fs.existsSync(p)) {
    vscode.window.showInformationMessage('No guided review to clear.');
    return;
  }
  const ok = await vscode.window.showWarningMessage(
    "Clear the guided review? This deletes Claude's review order and all its notes (in both editors).",
    { modal: true },
    'Clear'
  );
  if (ok !== 'Clear') return;
  try {
    fs.unlinkSync(p);
  } catch (e) {
    vscode.window.showErrorMessage(`Could not delete ${p}: ${e.message}`);
    return;
  }
  syncAiThreads();
  refreshTree();
  vscode.window.setStatusBarMessage('Guided review cleared', 2500);
}

module.exports = { aiThreads, syncAiThreads, applyGuidedNotesState, firstCommentLine, deleteAiNotes, clearGuidedReview };
