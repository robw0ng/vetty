package dev.vetty

import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.markup.GutterIconRenderer
import com.intellij.openapi.editor.markup.HighlighterLayer
import com.intellij.openapi.editor.markup.HighlighterTargetArea
import com.intellij.openapi.editor.markup.RangeHighlighter
import com.intellij.openapi.editor.markup.TextAttributes
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.util.Key
import java.awt.datatransfer.StringSelection

/** Inline comments in editors: line highlight + gutter icon with its popup, and the editor actions. */

private val COMMENT_BG = com.intellij.ui.JBColor(0xFFF6D5, 0x3B3A2A)  // faint highlight for commented lines

object VettyGutter {
    private val KEY = Key.create<MutableList<RangeHighlighter>>("vetty.highlighters")

    /** Decorate any editor whose document maps to a repo file with comments — works in diff viewers too. */
    fun decorate(project: Project, editor: Editor) {
        editor.getUserData(KEY)?.forEach { it.dispose() }
        val list = ArrayList<RangeHighlighter>()
        editor.putUserData(KEY, list)
        val svc = project.service<VettyService>()
        val rel = svc.relForEditor(editor) ?: return   // real file, or the open diff's file for unified view
        // Only persist line drift from a REAL file editor. Synthetic diff sides (snapshot/unified) reanchor
        // against old/merged content — decorate them read-only, never write c.line back from them.
        val realFile = com.intellij.openapi.fileEditor.FileDocumentManager.getInstance().getFile(editor.document)
        val persist = realFile != null && svc.relPath(realFile) == rel
        val doc = editor.document
        val lines = doc.text.split("\n")
        for (c in svc.commentsFor(rel) + svc.aiCommentsFor(rel)) {
            val line = VettyParse.reanchor(lines, c.line, c.anchor)
            if (persist && !c.ai && line != c.line) c.line = line   // persist drift only from the real file (never Claude's file)
            if (line < doc.lineCount) {
                val end = (line + c.span).coerceIn(line, doc.lineCount - 1)
                val attrs = TextAttributes().apply { backgroundColor = COMMENT_BG }  // shade the spanned lines
                val h = editor.markupModel.addRangeHighlighter(
                    doc.getLineStartOffset(line), doc.getLineEndOffset(end),
                    HighlighterLayer.SELECTION - 1, attrs, HighlighterTargetArea.LINES_IN_RANGE
                )
                h.gutterIconRenderer = VettyGutterIcon(project, c)
                list.add(h)
            }
        }
    }

    fun redecorateAll(project: Project) {
        for (ed in EditorFactory.getInstance().allEditors) {
            if (ed.project == null || ed.project == project) decorate(project, ed)
        }
    }
}

private class VettyGutterIcon(private val project: Project, val c: VettyStateService.Comment) :
    GutterIconRenderer() {
    override fun getIcon() = if (c.ai) AllIcons.Actions.IntentionBulb else AllIcons.General.Balloon
    // Claude notes are markdown (bullets, tables): monospace keeps table columns aligned.
    override fun getTooltipText() = if (!c.ai) c.body
        else "<html><b>Claude${if (c.big) " · big picture" else ""}</b>${VettyReviewFile.mdToHtml(c.body)}</html>"
    override fun isNavigateAction() = true
    override fun getClickAction(): AnAction = object : AnAction() {
        override fun actionPerformed(e: AnActionEvent) {
            val svc = project.service<VettyService>()
            val group = DefaultActionGroup().apply {
                if (!c.ai) add(object : AnAction("Edit") {
                    override fun getActionUpdateThread() = ActionUpdateThread.EDT
                    override fun actionPerformed(ev: AnActionEvent) =
                        Messages.showInputDialog(project, "Comment", "Edit Comment", null, c.body, null)
                            ?.let { c.body = it; svc.refreshUiAndGutters() } ?: Unit
                })
                add(object : AnAction("Copy") {
                    override fun getActionUpdateThread() = ActionUpdateThread.EDT
                    override fun actionPerformed(ev: AnActionEvent) =
                        CopyPasteManager.getInstance().setContents(StringSelection(VettyParse.exportComments(listOf(c))))
                })
                add(object : AnAction("Delete") {
                    override fun getActionUpdateThread() = ActionUpdateThread.EDT
                    override fun actionPerformed(ev: AnActionEvent) { svc.deleteAnyComments(listOf(c)); svc.refreshUiAndGutters() }
                })
            }
            com.intellij.openapi.ui.popup.JBPopupFactory.getInstance().createActionGroupPopup(
                null, group, e.dataContext,
                com.intellij.openapi.ui.popup.JBPopupFactory.ActionSelectionAid.MNEMONICS, true
            ).show(com.intellij.ui.awt.RelativePoint(java.awt.MouseInfo.getPointerInfo().location))  // at the clicked icon
        }
    }
    override fun equals(other: Any?) = other is VettyGutterIcon && other.c === c
    override fun hashCode() = System.identityHashCode(c)
}

/** Find Action → "Vetty: Clear Guided Review": deletes Claude's review order + notes for this worktree. */
class VettyClearGuidedReviewAction : AnAction() {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val svc = project.service<VettyService>()
        if (Messages.showYesNoDialog(project,
                "Clear the guided review? This deletes Claude's review order and all its notes (in both editors).",
                "Vetty: Clear Guided Review", "Clear", "Cancel", null) != Messages.YES) return
        if (!svc.clearGuidedReview()) { Messages.showInfoMessage(project, "No guided review to clear.", "Vetty"); return }
        svc.refreshUiAndGutters()   // notes leave the gutter + list; order drops from the tree
    }
}

class VettyAddCommentAction : AnAction() {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        if (!project.service<VettyService>().addCommentOn(editor)) {
            Messages.showInfoMessage(project, "Comment on the working-tree side of a tracked file.", "Vetty")
        }
    }
}
