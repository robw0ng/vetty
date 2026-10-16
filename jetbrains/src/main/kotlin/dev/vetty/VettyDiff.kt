package dev.vetty

import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffManager
import com.intellij.diff.chains.SimpleDiffRequestChain
import com.intellij.diff.editor.ChainDiffVirtualFile
import com.intellij.diff.requests.DiffRequest
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.diff.util.DiffUserDataKeysEx
import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.ToggleAction
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.EDT
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.fileEditor.ex.FileEditorManagerEx
import com.intellij.openapi.fileEditor.impl.FileEditorOpenOptions
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/** Opening things in the IDE: file / TODO / search-hit previews and pinned tabs, and the diff request. Extension functions on VettyService. */

fun VettyService.relPath(vf: VirtualFile): String? {
    val root = repoRoot() ?: return null
    val p = vf.path
    return if (p.startsWith("$root/")) p.removePrefix("$root/") else null
}

internal fun VettyService.vfile(rel: String): VirtualFile? {
    val root = repoRoot() ?: return null
    val lfs = LocalFileSystem.getInstance()
    // findFileByPath is cached (no disk refresh) — much faster per diff; only refresh if it's unknown.
    return lfs.findFileByPath("$root/$rel") ?: lfs.refreshAndFindFileByPath("$root/$rel")
}

/** Open in a non-preview (pinned) tab — the "Open File" action. */
fun VettyService.openFile(rel: String) {
    vfile(rel)?.let { FileEditorManager.getInstance(project).openFile(it, true) }
}

/** Close the transient file-preview tab (called by the diff preview so only one preview shows). */
fun VettyService.closeFilePreview() {
    val prev = lastPreview ?: return
    lastPreview = null
    cs.launch(Dispatchers.EDT) {
        val fem = FileEditorManager.getInstance(project)
        if (fem.isFileOpen(prev)) fem.closeFile(prev)
    }
}

/** Navigate to line/col and, for a search hit, select the matched text (like VS Code's openMatch). */
private fun VettyService.navigateAndSelect(file: VirtualFile, line: Int, col: Int, len: Int) {
    OpenFileDescriptor(project, file, line, col).navigateInEditor(project, true)
    if (len <= 0) return
    val ed = FileEditorManager.getInstance(project).selectedTextEditor ?: return
    val doc = ed.document
    if (line >= doc.lineCount) return
    val start = (doc.getLineStartOffset(line) + col).coerceAtMost(doc.getLineEndOffset(line))
    val end = (start + len).coerceAtMost(doc.getLineEndOffset(line))
    ed.selectionModel.setSelection(start, end)
}

/**
 * Open a VirtualFile, replacing the previously single-clicked one (diff editors ignore the
 * preview-tab flag, so we close the prior tab ourselves to get the swap behavior).
 * openFile(...) is suspend in 2025.2 — launch on the scope (NOT runBlocking, which deadlocks the EDT).
 */
private fun VettyService.openPreview(file: VirtualFile, line: Int? = null, col: Int = 0, len: Int = 0) {
    closeDiffPreview?.invoke()  // a file preview replaces the diff preview → single preview surface
    val prev = lastPreview      // capture + set synchronously on EDT so concurrent opens don't race
    lastPreview = file
    cs.launch(Dispatchers.EDT) {
        val fem = FileEditorManager.getInstance(project)
        try {
            (fem as FileEditorManagerEx).openFile(file, FileEditorOpenOptions(usePreviewTab = true))
        } catch (e: Throwable) {
            fem.openFile(file, true)
        }
        if (prev != null && prev !== file && fem.isFileOpen(prev)) fem.closeFile(prev)  // close AFTER open → no blank flash
        if (line != null) navigateAndSelect(file, line, col, len)
    }
}

/** Open fully in a permanent tab (double-click). Never auto-closed; only clears the transient preview. */
private fun VettyService.openPinned(file: VirtualFile, line: Int? = null, col: Int = 0, len: Int = 0) {
    val prev = lastPreview
    lastPreview = null          // pinned tabs aren't tracked → never swapped away by a later click
    cs.launch(Dispatchers.EDT) {
        val fem = FileEditorManager.getInstance(project)
        try {
            (fem as FileEditorManagerEx).openFile(file, FileEditorOpenOptions(usePreviewTab = false))
        } catch (e: Throwable) {
            fem.openFile(file, true)
        }
        prev?.let { if (it !== file && fem.isFileOpen(it)) fem.closeFile(it) }  // close AFTER open → no blank flash
        if (line != null) navigateAndSelect(file, line, col, len)
    }
}

/** Base-side content for [rel] at [ref]; falls back to the file's OLD name when it was renamed,
 *  so a renamed file diffs against its previous content instead of showing as fully added. */
private fun VettyService.showBase(ref: String, rel: String): String {
    val s = git("show", "$ref:./$rel")   // ./ = cwd-relative path
    if (s.isNotEmpty()) return s
    for (line in git("diff", "--relative", "--diff-filter=R", "--name-status", ref).split("\n")) {
        val p = line.split("\t")
        if (p.size == 3 && p[2] == rel) return git("show", "$ref:./${p[1]}")
    }
    return ""
}

/** Build the diff request for a file (used by the in-place preview processor AND the pinned tab).
 *  A DELETED file (no VirtualFile) diffs base content against an empty right side. */
fun VettyService.buildDiffRequest(rel: String): DiffRequest {
    val vf = vfile(rel)
    lastDiffRel = rel   // so commenting from a unified diff (synthetic doc) still knows the file
    val blob = reviewedBlob(rel)
    val hasReview = sinceReview() && blob != null && !isViewed(rel)  // overlay on + snapshot + changed since
    val (leftText, label) = when {
        hasReview -> git("cat-file", "-p", blob!!) to "last viewed"
        isCommitRange() || rel in wtOnlySet -> showBase("HEAD", rel) to "uncommitted"   // uncommitted-only rows have no branch diff
        else -> showBase(baseRef() ?: "HEAD", rel) to "${base()} ↔ working"          // whole branch
    }
    val factory = DiffContentFactory.getInstance()
    val name = rel.substringAfterLast('/')
    if (vf == null) {
        // Deleted: base content ↔ empty. Keep the Viewed toggle so a deletion can be vetted too.
        val dftype = FileTypeManager.getInstance().getFileTypeByFileName(name)
        val dleft = leftText.replace("\r\n", "\n").replace("\r", "\n")
        val req = SimpleDiffRequest("$name (deleted)",
            factory.create(project, dleft, dftype), factory.create(project, "", dftype), label, "deleted")
        req.putUserData(DiffUserDataKeysEx.CONTEXT_ACTIONS, listOf(viewedToggle(rel)))
        return req
    }
    val ftype = FileTypeManager.getInstance().getFileTypeByFileName(vf.name)
    // git output is LF-normalized (core.autocrlf); match the working file's EOL so the diff doesn't
    // report "differences only in line separators".
    val sep = com.intellij.openapi.fileEditor.impl.LoadTextUtil.detectLineSeparator(vf, true) ?: "\n"
    val left = leftText.let { if (it.startsWith('﻿')) it.substring(1) else it }   // git keeps the UTF-8 BOM; IntelliJ strips it
        .replace("\r\n", "\n").replace("\r", "\n").let { if (sep == "\n") it else it.replace("\n", sep) }
    val req = SimpleDiffRequest("${rel.substringAfterLast('/')} ($label)",
        factory.create(project, left, ftype), factory.create(project, vf), label, "working tree")
    req.putUserData(DiffUserDataKeysEx.CONTEXT_ACTIONS, listOf(viewedToggle(rel)))
    // Land on the first comment, not the first change — notes above it would be scrolled past.
    firstCommentLine(rel)?.let {
        req.putUserData(com.intellij.diff.util.DiffUserDataKeys.SCROLL_TO_LINE,
            com.intellij.openapi.util.Pair.create(com.intellij.diff.util.Side.RIGHT, it))
    }
    return req
}

/** "Viewed" toggle for the diff toolbar (top-right), so you mark viewed while reviewing the file. */
private fun VettyService.viewedToggle(rel: String): AnAction = object : ToggleAction("Viewed", "Mark this file viewed", AllIcons.Actions.Checked) {
    override fun getActionUpdateThread() = ActionUpdateThread.EDT
    override fun isSelected(e: AnActionEvent) = isViewed(rel)
    override fun setSelected(e: AnActionEvent, state: Boolean) {
        // markViewed spawns git (hash-object) — keep it off the EDT (Rider 2026+ hard-errors).
        ApplicationManager.getApplication().executeOnPooledThread {
            if (state) markViewed(rel) else unmarkViewed(rel)
            onChange?.invoke()
        }
    }
}

/** Double-click: open the file's diff in a permanent (pinned) tab. The request build spawns git,
 *  so it runs off the EDT (the preview path already does, via the diff processor). */
fun VettyService.openDiffPinned(f: VFile) {
    val rel = f.rel
    ApplicationManager.getApplication().executeOnPooledThread {
        val req = try { buildDiffRequest(rel) } catch (e: Exception) { return@executeOnPooledThread }
        ApplicationManager.getApplication().invokeLater {
            val chainFile = try {
                ChainDiffVirtualFile(SimpleDiffRequestChain(listOf(req)), rel.substringAfterLast('/'))
            } catch (e: Throwable) { null }
            if (chainFile != null) openPinned(chainFile) else DiffManager.getInstance().showDiff(project, req)
        }
    }
}

fun VettyService.openTodo(rel: String, line: Int) = openTodoInternal(rel, line, false)
fun VettyService.openTodoPinned(rel: String, line: Int) = openTodoInternal(rel, line, true)

/** Open a search hit with the matched text selected. */
fun VettyService.openMatch(rel: String, line: Int, col: Int, len: Int) {
    vfile(rel)?.let { openPreview(it, (line - 1).coerceAtLeast(0), col, len) }
}
fun VettyService.openMatchPinned(rel: String, line: Int, col: Int, len: Int) {
    vfile(rel)?.let { openPinned(it, (line - 1).coerceAtLeast(0), col, len) }
}

private fun VettyService.openTodoInternal(rel: String, line: Int, pinned: Boolean) {
    val vf = vfile(rel) ?: return
    val l = (line - 1).coerceAtLeast(0)
    val (col, len) = todoSpan(vf, l)   // select the marker → end of line, like a search hit
    if (pinned) openPinned(vf, l, col, len) else openPreview(vf, l, col, len)
}

/** Column + length to select on a TODO line: from the marker keyword to end of line (0,0 if none). */
private fun VettyService.todoSpan(vf: VirtualFile, line: Int): Pair<Int, Int> {
    val text = ReadAction.compute<String?, RuntimeException> {
        FileDocumentManager.getInstance().getDocument(vf)?.let { d ->
            if (line < d.lineCount) d.getText(com.intellij.openapi.util.TextRange(d.getLineStartOffset(line), d.getLineEndOffset(line))) else null
        }
    } ?: return 0 to 0
    val col = VettyParse.todoCol(text)
    return if (col < 0) 0 to 0 else col to (text.length - col)
}
