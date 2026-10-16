package dev.vetty

import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.editor.colors.EditorFontType
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopup
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.BasicStroke
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Component
import java.awt.Dimension
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.RenderingHints
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.DefaultListModel
import javax.swing.JLabel
import javax.swing.JList
import javax.swing.JPanel
import javax.swing.ListCellRenderer
import javax.swing.event.DocumentEvent
import javax.swing.event.DocumentListener

/**
 * Base-branch picker: the terminal picker's branch tree as a popup. Trunk at the foot, stacks growing upward,
 * every branch above its parent; lanes painted with Graphics2D (no font to misalign); ◉ you are
 * here (white), cyan BASE on the base in use, (trunk) / (no trunk), ⌂ for branches checked out in
 * other worktrees; one palette colour per branch. Type to filter, ↑↓ Enter Esc, hover moves the
 * cursor, click picks. Mirrors src/branchpick.js.
 */
class VettyBasePicker(private val project: Project, private val rows: List<PickRow>, private val onPick: (String) -> Unit) {
    private val model = DefaultListModel<PickRow>()
    private val list = JBList(model)
    private val filter = JBTextField()
    private val hint = JLabel()
    private var popup: JBPopup? = null
    private val dark = !JBColor.isBright()
    private val palette: List<Color> = run {
        val accent = JBUI.CurrentTheme.Focus.focusColor().let { c ->
            val hsb = Color.RGBtoHSB(c.red, c.green, c.blue, null); (hsb[0] * 360).toDouble()
        }
        VettyBranchTree.branchPalette(rows.size, accent).map { h -> VettyBranchTree.hslToRgb(h, 0.95, if (dark) 0.68 else 0.38).let { Color(it[0], it[1], it[2]) } }
    }
    private val colorOf: Map<String, Color> = rows.withIndex().associate { it.value.name to palette[it.index] }   // stable per branch, not per filtered index
    private val hereColor = if (dark) Color.WHITE else Color.BLACK
    private val baseColor = if (dark) Color(0, 200, 255) else VettyBranchTree.hslToRgb(192.0, 1.0, 0.32).let { Color(it[0], it[1], it[2]) }
    private val dim = UIUtil.getContextHelpForeground()
    private val mono = EditorColorsManager.getInstance().globalScheme.getFont(EditorFontType.PLAIN)
    private val bold = EditorColorsManager.getInstance().globalScheme.getFont(EditorFontType.BOLD)

    fun show() {
        rows.forEach { model.addElement(it) }
        list.cellRenderer = Renderer()
        list.selectionMode = javax.swing.ListSelectionModel.SINGLE_SELECTION
        if (rows.isNotEmpty()) list.selectedIndex = 0
        list.addListSelectionListener { updateHint() }
        // Hover moves the cursor — one highlight, like a quick pick.
        list.addMouseMotionListener(object : java.awt.event.MouseMotionAdapter() {
            override fun mouseMoved(e: MouseEvent) { val i = list.locationToIndex(e.point); if (i >= 0 && i != list.selectedIndex) list.selectedIndex = i }
        })
        list.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) { if (javax.swing.SwingUtilities.isLeftMouseButton(e)) pick() }
        })
        filter.emptyText.text = "Type to filter…"
        filter.document.addDocumentListener(object : DocumentListener {
            override fun insertUpdate(e: DocumentEvent) = refilter()
            override fun removeUpdate(e: DocumentEvent) = refilter()
            override fun changedUpdate(e: DocumentEvent) = refilter()
        })
        // The text field keeps focus; arrows / Enter / Esc drive the list from there.
        filter.addKeyListener(object : KeyAdapter() {
            override fun keyPressed(e: KeyEvent) {
                val n = model.size
                fun move(d: Int) { if (n > 0) list.selectedIndex = (list.selectedIndex + d).coerceIn(0, n - 1); list.ensureIndexIsVisible(list.selectedIndex); e.consume() }
                when (e.keyCode) {
                    KeyEvent.VK_DOWN -> move(1); KeyEvent.VK_UP -> move(-1)
                    KeyEvent.VK_PAGE_DOWN -> move(10); KeyEvent.VK_PAGE_UP -> move(-10)
                    KeyEvent.VK_HOME -> move(-n); KeyEvent.VK_END -> move(n)
                    KeyEvent.VK_ENTER -> { pick(); e.consume() }
                    KeyEvent.VK_ESCAPE -> { popup?.cancel(); e.consume() }
                }
            }
        })
        val title = JLabel("Pick the base branch").apply { font = bold }
        val sub = JLabel("Vetty reviews what your branch changed since it. The parent it was cut from is usually right.").apply { foreground = dim }
        val head = JPanel(BorderLayout(0, JBUI.scale(4))).apply {
            border = JBUI.Borders.empty(10, 12, 6, 12)
            add(JPanel(BorderLayout(0, JBUI.scale(2))).apply { add(title, BorderLayout.NORTH); add(sub, BorderLayout.SOUTH) }, BorderLayout.NORTH)
            add(filter, BorderLayout.SOUTH)
        }
        hint.foreground = dim
        hint.border = JBUI.Borders.empty(6, 12)
        updateHint()
        val panel = JPanel(BorderLayout()).apply {
            add(head, BorderLayout.NORTH)
            add(JBScrollPane(list).apply { border = JBUI.Borders.empty(0, 6) }, BorderLayout.CENTER)
            add(hint, BorderLayout.SOUTH)
            preferredSize = Dimension(JBUI.scale(720), JBUI.scale(Math.min(120 + 24 * rows.size, 640)))
        }
        popup = JBPopupFactory.getInstance().createComponentPopupBuilder(panel, filter)
            .setTitle("Pick Base Branch").setRequestFocus(true).setResizable(true).setMovable(true)
            .setCancelOnClickOutside(true).createPopup()
        popup!!.showCenteredInCurrentWindow(project)
    }

    private fun refilter() {
        val q = filter.text.trim().lowercase()
        val keep = list.selectedValue
        model.clear()
        rows.filter { q.isEmpty() || it.name.lowercase().contains(q) }.forEach { model.addElement(it) }
        val i = (0 until model.size).firstOrNull { model[it] === keep } ?: 0
        if (model.size > 0) list.selectedIndex = i
        updateHint()
    }

    private fun updateHint() {
        val onSelf = list.selectedValue?.current == true
        hint.text = "↑↓ move · PgUp/PgDn page · Enter ${if (onSelf) "review uncommitted changes only" else "use as base"} · Esc close"
    }

    private fun pick() {
        val r = list.selectedValue ?: return
        popup?.closeOk(null)
        onPick(r.name)
    }

    /** One row: lanes painted edge to edge (so verticals join across rows), then name, chips, tags. */
    private inner class Renderer : JPanel(), ListCellRenderer<PickRow> {
        private var row: PickRow? = null
        private var index = 0
        private var selected = false
        private val W = JBUI.scale(9); private val H = JBUI.scale(22); private val R = JBUI.scale(4).toFloat() + 0.5f
        private val width = rows.maxOfOrNull { it.cells.size } ?: 1
        init { isOpaque = true; preferredSize = Dimension(0, H) }
        override fun getListCellRendererComponent(l: JList<out PickRow>, v: PickRow, i: Int, sel: Boolean, focus: Boolean): Component {
            row = v; index = i; selected = sel
            background = if (sel) UIUtil.getListSelectionBackground(true) else UIUtil.getListBackground()
            return this
        }
        override fun paintComponent(g0: Graphics) {
            super.paintComponent(g0)
            val r = row ?: return
            val g = g0 as Graphics2D
            g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON)
            val x0 = JBUI.scale(6)
            val cy = H / 2f
            val nodeColor = if (r.current) hereColor else if (r.base) baseColor else colorOf[r.name] ?: dim
            // lanes
            g.color = dim; g.stroke = BasicStroke(1.5f)
            r.cells.forEachIndexed { i, c ->
                val x = x0 + i * W + W / 2f; val n = c.node != null
                if (c.up) g.draw(java.awt.geom.Line2D.Float(x, 0f, x, if (n) cy - R else cy))
                if (c.down) g.draw(java.awt.geom.Line2D.Float(x, if (n) cy + R else cy, x, H.toFloat()))
                if (c.left) g.draw(java.awt.geom.Line2D.Float((x0 + i * W).toFloat(), cy, if (n) x - R else x, cy))
                if (c.right) g.draw(java.awt.geom.Line2D.Float(if (n) x + R else x, cy, (x0 + (i + 1) * W).toFloat(), cy))
            }
            // nodes
            r.cells.forEachIndexed { i, c ->
                val node = c.node ?: return@forEachIndexed
                val x = x0 + i * W + W / 2f
                val filled = node == '◉' || node == '◈'; val diamond = node == '◇' || node == '◈'
                val shape: java.awt.Shape = if (diamond) java.awt.geom.Path2D.Float().apply {
                    moveTo(x, cy - R - 1); lineTo(x + R + 1, cy); lineTo(x, cy + R + 1); lineTo(x - R - 1, cy); closePath()
                } else java.awt.geom.Ellipse2D.Float(x - R, cy - R, 2 * R, 2 * R)
                g.color = if (filled) nodeColor else background; g.fill(shape)
                g.color = nodeColor; g.draw(shape)
            }
            // name + chips + tags
            var x = (x0 + width * W + JBUI.scale(6)).toFloat()
            g.font = if (r.current || r.base) bold else mono
            val fm = g.fontMetrics
            val ty = cy + (fm.ascent - fm.descent) / 2f
            g.color = nodeColor
            g.drawString(r.name, x, ty); x += (fm.stringWidth(r.name) + JBUI.scale(10)).toFloat()
            fun chip(text: String, hue: Double) {
                val bg = VettyBranchTree.hslToRgb(hue, 0.85, if (dark) 0.17 else 0.88).let { Color(it[0], it[1], it[2]) }
                val fg = VettyBranchTree.hslToRgb(hue, 0.70, if (dark) 0.80 else 0.25).let { Color(it[0], it[1], it[2]) }
                g.font = bold.deriveFont(bold.size2D * 0.85f)
                val w = g.fontMetrics.stringWidth(text) + JBUI.scale(12); val h = JBUI.scale(16)
                g.color = bg; g.fill(java.awt.geom.RoundRectangle2D.Float(x, cy - h / 2f, w.toFloat(), h.toFloat(), 6f, 6f))
                g.color = fg; g.drawString(text, x + JBUI.scale(6), cy + (g.fontMetrics.ascent - g.fontMetrics.descent) / 2f)
                x += (w + JBUI.scale(10)).toFloat()
            }
            fun tag(text: String) { g.font = mono; g.color = dim; g.drawString(text, x, ty); x += (g.fontMetrics.stringWidth(text) + JBUI.scale(10)).toFloat() }
            if (r.current) chip("← YOU ARE HERE", 50.0) else if (r.base) chip("CURRENT BASE", 192.0)
            if (r.trunk) tag("(trunk)") else if (r.noTrunk) tag("(no trunk)")
            if (r.worktree.isNotEmpty()) tag("⌂ ${r.worktree}")
        }
        override fun getToolTipText(): String? = row?.worktree?.takeIf { it.isNotEmpty() }?.let { "checked out in the $it worktree" }
    }
}
