package dev.vetty

import com.intellij.icons.AllIcons
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.vcs.FileStatus
import com.intellij.ui.ColoredTreeCellRenderer
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBLabel
import javax.swing.JTree
import javax.swing.tree.DefaultMutableTreeNode

/** Tree node types and the row renderer shared by the tool window's three trees. */

internal class GroupNode(val group: Group, val count: Int)
internal class FolderNode(val name: String, val path: String)
internal class FileHeader(val rel: String, val count: Int)   // parent row in the TODO / comment lists
internal class SectionNode(val title: String, val count: Int,   // Comments pane: "Comments" / "Guided review"
                          val items: List<VettyStateService.Comment>)   // what the header's Copy button copies
internal class Match(val rel: String, val line: Int, val text: String, val col: Int, val len: Int)  // a content-search hit (child row of a file)

internal const val ROW_ICON = 22

/** Icon label that paints Rider's rounded action-button hover background when hovered. */
internal class IconCell(icon: javax.swing.Icon?, private val hovered: Boolean) : JBLabel(icon) {
    init { isOpaque = false; horizontalAlignment = javax.swing.SwingConstants.CENTER }
    override fun paintComponent(g: java.awt.Graphics) {
        if (hovered) com.intellij.openapi.actionSystem.ex.ActionButtonLook.SYSTEM_LOOK.paintLookBackground(
            g, java.awt.Rectangle(0, 0, width, height),
            com.intellij.util.ui.JBUI.CurrentTheme.ActionButton.hoverBackground()
        )
        super.paintComponent(g)
    }
}

/** Single-letter status badge + theme color (reuses IntelliJ's VCS FileStatus palette). */
private fun statusInfo(f: VFile): Pair<String, FileStatus> = when {
    f.group == Group.UNTRACKED -> "U" to FileStatus.UNKNOWN
    f.status == "A" || f.status == "U" -> "A" to FileStatus.ADDED   // git-untracked NEW file is an addition
    f.status == "D" -> "D" to FileStatus.DELETED
    f.status == "R" -> "R" to FileStatus.MODIFIED
    f.status == "C" -> "C" to FileStatus.MODIFIED
    else -> "M" to FileStatus.MODIFIED
}

internal class VettyTextRenderer(
    private val svc: VettyService,
    private val matchCount: (String) -> Int,   // active-search hits for a file row ("N matches")
    private val dupName: (String) -> Boolean,  // basename shared by several listed files → show its folder
) : ColoredTreeCellRenderer() {
    override fun customizeCellRenderer(
        tree: JTree, value: Any?, selected: Boolean, expanded: Boolean,
        leaf: Boolean, row: Int, hasFocus: Boolean
    ) {
        icon = null  // reset: renderer is reused across rows
        val obj = (value as? DefaultMutableTreeNode)?.userObject
        when (obj) {
            is GroupNode -> {
                val label = when (obj.group) {
                    Group.UNVIEWED -> "Unviewed"; Group.VIEWED -> "Viewed"; Group.UNTRACKED -> "Ignored"
                }
                append("$label (${obj.count})", SimpleTextAttributes.REGULAR_BOLD_ATTRIBUTES)
            }
            is FolderNode -> {
                icon = AllIcons.Nodes.Folder
                append(obj.name)
            }
            is SectionNode -> {
                icon = if (obj.title == "Guided review") AllIcons.Actions.IntentionBulb else AllIcons.General.Balloon
                append("${obj.title} (${obj.count})", SimpleTextAttributes.REGULAR_BOLD_ATTRIBUTES)
            }
            is FileHeader -> {
                val name = obj.rel.substringAfterLast('/')
                icon = FileTypeManager.getInstance().getFileTypeByFileName(name).icon
                append(name)
                val dir = obj.rel.substringBeforeLast('/', "")
                append("   ${listOf(dir, obj.count.toString()).filter { it.isNotEmpty() }.joinToString("  ·  ")}",
                    SimpleTextAttributes.GRAYED_ATTRIBUTES)
            }
            is Match -> {
                icon = AllIcons.Actions.Find
                append("${obj.line}: ", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                append(obj.text.trim().take(120))
            }
            is Todo -> {
                val msg = obj.text
                    .replace(Regex("""^\s*(/{2,}|#+|/\*+|\*+|<!--|--)\s?"""), "")
                    .replace(Regex("""\s*(\*/|-->)\s*$"""), "").trim().ifEmpty { obj.text }
                append(msg)
                append("   :${obj.line}", SimpleTextAttributes.GRAYED_ATTRIBUTES)   // the file is the parent row
            }
            is VettyStateService.Comment -> {
                icon = if (obj.ai) AllIcons.Actions.IntentionBulb else AllIcons.General.Balloon
                // Claude notes are multi-line markdown — the row shows the first line, bullet stripped.
                append(if (!obj.ai) obj.body else obj.body.lines()
                    .map { it.replace(Regex("^\\s*([-*+]|\\d+\\.|\\|)\\s*"), "").trim() }.firstOrNull { it.isNotEmpty() } ?: "")
                val loc = if (obj.span > 0) "${obj.line + 1}-${obj.line + obj.span + 1}" else "${obj.line + 1}"
                append("   :$loc${if (obj.big) "  ·  big picture" else ""}", SimpleTextAttributes.GRAYED_ATTRIBUTES)   // section says Claude
            }
            is VFile -> {
                val name = obj.rel.substringAfterLast('/')
                val dir = obj.rel.substringBeforeLast('/', "")
                val (letter, status) = statusInfo(obj)
                val color = status.color
                icon = FileTypeManager.getInstance().getFileTypeByFileName(name).icon
                append("$letter  ", SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, color))
                // Leading stage marker: `*` staged, `^` staged but edited since staging.
                val stage = if (obj.stageMark.isEmpty()) "" else "${obj.stageMark} "
                append(stage + name, SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, color))  // filename colored by status
                val step = svc.orderStep(obj.rel)   // Claude's review order: #n + one-line why
                val extras = buildList {
                    if (step != null) add("#${step.first}")   // already 1-based, gap-free
                    val mc = matchCount(obj.rel)
                    if (mc > 0) add("$mc match${if (mc == 1) "" else "es"}")
                    if (obj.add > 0 || obj.del > 0) add("+${obj.add} −${obj.del}")
                    if (obj.wtOnly) add("uncommitted")   // not in the branch diff (tooltip explains)
                    if (dir.isNotEmpty() && !svc.nested() && dupName(name)) add(dir)   // only to disambiguate same-named files
                }
                if (extras.isNotEmpty()) append("   ${extras.joinToString("  ·  ")}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                val n = svc.commentsFor(obj.rel).size
                if (n > 0) append("  💬$n", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                // ↻ = viewed before, edited since — a re-review, not a first look (snapshot restorable).
                if (obj.group == Group.UNVIEWED && svc.hasSnapshot(obj.rel))
                    append("  ↻", SimpleTextAttributes.GRAYED_ATTRIBUTES)   // edited since viewed (tooltip explains)
            }
        }
    }
}
