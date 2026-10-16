package dev.vetty

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.ui.Messages

/** Your review comments: add / delete / clear, their stage-on-view side effects, and export. Extension functions on VettyService. */

/**
 * rel for an editor: its real file, or the currently-open diff's file when the doc is synthetic
 * (unified diff). Used by both commenting and gutter decoration so both work in any diff view.
 */
fun VettyService.relForEditor(editor: Editor): String? {
    val f = FileDocumentManager.getInstance().getFile(editor.document)
    return (f?.let { relPath(it) }) ?: lastDiffRel
}

/**
 * Add a comment on the caret line/selection of [editor].
 * Split diff (right side) / normal file → the editor doc maps to the real file → exact line.
 * Unified diff → synthetic doc, so fall back to the open diff's file; the line's text anchors it.
 */
fun VettyService.addCommentOn(editor: Editor): Boolean {
    val rel = relForEditor(editor) ?: return false
    val doc = editor.document
    val sel = editor.selectionModel
    val startLine: Int
    val endLine: Int
    if (sel.hasSelection()) {
        startLine = doc.getLineNumber(sel.selectionStart)
        endLine = doc.getLineNumber(maxOf(sel.selectionEnd - 1, sel.selectionStart))  // inclusive last line
    } else {
        startLine = editor.caretModel.logicalPosition.line
        endLine = startLine
    }
    val span = endLine - startLine
    val anchor = doc.text.split("\n").getOrElse(startLine) { "" }.trim()
    val loc = if (span > 0) "${startLine + 1}-${endLine + 1}" else "${startLine + 1}"
    val body = Messages.showInputDialog(project, "Comment on $rel:$loc", "Vetty: Add Comment", null)
    if (body != null && body.isNotBlank()) { addComment(rel, startLine, span, anchor, body); refreshUiAndGutters() }
    return true
}

// Comments are branch-scoped like viewed marks: global comments leaked across sibling branches,
// and re-anchoring against the wrong branch's content corrupted their stored positions.
private fun VettyService.onBranch(c: VettyStateService.Comment) = c.branch == (curBranch ?: base())

fun VettyService.commentsFor(rel: String): List<VettyStateService.Comment> =
    state.comments.filter { it.file == rel && onBranch(it) }

fun VettyService.allComments(): List<VettyStateService.Comment> = state.comments.filter { onBranch(it) }

/** Earliest comment line on [rel] (yours + Claude's while shown), 0-based; null = none.
 *  ponytail: stored lines, not re-anchored — close enough to put the note on screen. */
fun VettyService.firstCommentLine(rel: String): Int? = (commentsFor(rel) + aiCommentsFor(rel)).minOfOrNull { it.line }

fun VettyService.addComment(rel: String, line: Int, span: Int, anchor: String, body: String) {
    state.comments.add(VettyStateService.Comment().apply {
        this.file = rel; this.line = line; this.span = span; this.anchor = anchor; this.body = body
        this.branch = curBranch ?: base() ?: ""
    })
    scheduleSave()
    unstageForComment(rel)
}

fun VettyService.deleteComment(c: VettyStateService.Comment) {
    state.comments.remove(c); scheduleSave()
    unviewOnCommentResolve(listOf(c.file))
}

fun VettyService.clearComments() {   // current branch only
    val rels = allComments().map { it.file }.distinct()
    state.comments.removeAll { onBranch(it) }; scheduleSave()
    unviewOnCommentResolve(rels)
}

/** Stage-on-view mode: resolving a file's LAST comment re-opens the verdict — the file returns
 *  to Unviewed, so the next explicit view is the approval that stages it. Pooled (EDT-safe). */
private fun VettyService.unviewOnCommentResolve(rels: List<String>) {
    if (!state.stageOnView) return
    val drop = rels.distinct().filter { commentsFor(it).isEmpty() && state.viewed.containsKey(key(it)) }
    if (drop.isEmpty()) return
    ApplicationManager.getApplication().executeOnPooledThread {
        for (rel in drop) unmarkViewed(rel)   // unview ⇒ unstage included
        refreshUiAndGutters()
    }
}

/** Comments = request changes (stage-on-view mode): commenting on a viewed file unstages it.
 *  Deleting/resolving comments never auto-stages — staging comes back only via an explicit
 *  (re-)view, and markViewed itself skips files that still have open comments.
 *  Pooled — comments are added from the EDT and git may not spawn there. */
private fun VettyService.unstageForComment(rel: String) {
    if (!state.stageOnView) return
    ApplicationManager.getApplication().executeOnPooledThread {
        if (isViewed(rel)) { git("restore", "--staged", "--", rel); refreshUiAndGutters() }
    }
}

/** Export this branch's comments paste-ready for an agent, like VS Code. */
fun VettyService.exportComments(): String {
    val mine = allComments()
    if (mine.isEmpty()) return ""
    val bullets = VettyParse.exportComments(mine).split("\n").joinToString("\n") { "- $it" }
    return "Address these review comments:\n\n$bullets\n"
}
