package dev.vetty

import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.actionSystem.ToggleAction
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.editor.markup.GutterIconRenderer
import com.intellij.openapi.editor.markup.HighlighterLayer
import com.intellij.openapi.editor.markup.HighlighterTargetArea
import com.intellij.openapi.editor.markup.RangeHighlighter
import com.intellij.openapi.editor.markup.TextAttributes
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.vcs.FileStatus
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.SimpleToolWindowPanel
import com.intellij.openapi.util.Key
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.ColoredTreeCellRenderer
import com.intellij.ui.OnePixelSplitter
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.treeStructure.Tree
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.datatransfer.StringSelection
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.JPanel
import javax.swing.JTree
import javax.swing.SwingUtilities
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeModel
import javax.swing.tree.TreePath
import javax.swing.tree.TreeSelectionModel

// ---- tool window ---------------------------------------------------------------------------

class VettyToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = VettyPanel(project)
        val content = ContentFactory.getInstance().createContent(panel, "", false)
        toolWindow.contentManager.addContent(content)
    }
}

private class GroupNode(val group: Group, val count: Int)
private class FolderNode(val name: String, val path: String)
private class Match(val rel: String, val line: Int, val text: String, val col: Int, val len: Int)  // a content-search hit (child row of a file)

class VettyPanel(private val project: Project) : SimpleToolWindowPanel(true, true) {
    private val svc = project.service<VettyService>()
    // Ctrl/Cmd+C on each tree copies the selected rows as text (not the node toString).
    private fun copyProviderFor(enabled: () -> Boolean, copy: () -> Unit) = object : com.intellij.ide.CopyProvider {
        override fun getActionUpdateThread() = ActionUpdateThread.EDT
        override fun performCopy(dataContext: com.intellij.openapi.actionSystem.DataContext) = copy()
        override fun isCopyEnabled(dataContext: com.intellij.openapi.actionSystem.DataContext) = enabled()
        override fun isCopyVisible(dataContext: com.intellij.openapi.actionSystem.DataContext) = true
    }
    private fun treeWithCopy(provider: com.intellij.ide.CopyProvider) =
        object : Tree(DefaultTreeModel(DefaultMutableTreeNode())), com.intellij.openapi.actionSystem.UiDataProvider {
            override fun uiDataSnapshot(sink: com.intellij.openapi.actionSystem.DataSink) {
                sink[com.intellij.openapi.actionSystem.PlatformDataKeys.COPY_PROVIDER] = provider
            }
        }
    private val tree = treeWithCopy(copyProviderFor({ selectedFiles().isNotEmpty() }, { copySelectedPaths() }))
    private val todoTree = treeWithCopy(copyProviderFor({ selectedTodos().isNotEmpty() }, { copyTodos() }))
    private val commentTree = treeWithCopy(copyProviderFor({ selectedComments().isNotEmpty() }, { copyComments(selectedComments()) }))
    private val header = JBLabel().apply { border = JBUI.Borders.empty(4, 6) }
    private fun sectionHeader() = JBLabel().apply { border = JBUI.Borders.empty(4, 6); font = font.deriveFont(java.awt.Font.BOLD) }
    private val reviewHeader = sectionHeader()
    private val todoHeader = sectionHeader()
    private val commentHeader = sectionHeader()
    private val searchHeader = sectionHeader()
    private lateinit var searchPanel: JPanel
    private var searchCollapsed = false
    private val reviewScroll = JBScrollPane(tree)
    private val todoScroll = JBScrollPane(todoTree)
    private val commentScroll = JBScrollPane(commentTree)
    private lateinit var bottomSplitter: OnePixelSplitter
    private lateinit var mainSplitter: OnePixelSplitter
    private var reviewCollapsed = false
    private var todoCollapsed = false
    private var commentCollapsed = false
    private var reviewCount = 0
    private var todoCount = 0
    private var commentCount = 0
    // Explicit per-group expand state (robust to empty groups, unlike reading it back off the tree).
    private val groupExpanded = mutableMapOf(Group.UNVIEWED to true, Group.VIEWED to true, Group.UNTRACKED to false)
    private val collapsedFolders = HashSet<String>()  // folder paths the user collapsed (folders default expanded)
    private var current: List<VFile> = emptyList()    // the SHOWN slice (post-filter) — nav/advance stay within it
    private var allFiles: List<VFile> = emptyList()   // the full changed set from the last load
    // Session-only filters, like VS Code: a stale persisted filter would silently hide files.
    private var nameFilter = ""
    private var scope = "All"   // All | Unviewed | Added | Modified
    private var searchMatches: Map<String, List<Match>>? = null  // null = no active content search
    private var lastTodos: List<Todo> = emptyList()
    private var lastComments: List<VettyStateService.Comment> = emptyList()
    private var hoverRow = -1     // row + icon index currently under the cursor (for the hover highlight)
    private var hoverIcon = -1
    private var pressedPath: javax.swing.tree.TreePath? = null  // path under the cursor at mouse-press
    private val cellRenderer = VettyCellRenderer()
    private val diffPreview = VettyDiffPreview()

    /** In-place diff preview: one editor tab whose request is swapped on each single-click (like the Commit view). */
    private inner class VettyDiffPreview : com.intellij.openapi.vcs.changes.EditorTabDiffPreview(project) {
        var producer: com.intellij.diff.chains.DiffRequestProducer? = null
        var viewer: com.intellij.diff.impl.CacheDiffRequestProcessor.Simple? = null
        override fun createViewer(): com.intellij.diff.impl.DiffEditorViewer {
            val p = object : com.intellij.diff.impl.CacheDiffRequestProcessor.Simple(project) {
                override fun getCurrentRequestProvider() = producer
            }
            viewer = p
            return p
        }
        override fun collectDiffProducers(selectedOnly: Boolean): com.intellij.openapi.ListSelection<out com.intellij.diff.chains.DiffRequestProducer> =
            producer?.let { com.intellij.openapi.ListSelection.createSingleton(it) } ?: com.intellij.openapi.ListSelection.empty()
        override fun getEditorTabName(viewer: com.intellij.diff.impl.DiffEditorViewer?): String =
            producer?.name?.substringAfterLast('/') ?: "Vetty Diff"
        override fun hasContent(): Boolean = producer != null
        fun show(rel: String) {
            producer = object : com.intellij.diff.chains.DiffRequestProducer {
                override fun getName() = rel
                override fun process(c: com.intellij.openapi.util.UserDataHolder, i: com.intellij.openapi.progress.ProgressIndicator) =
                    svc.buildDiffRequest(rel)
            }
            if (isPreviewOpen()) viewer?.updateRequest(true, null)   // swap content in place
            openPreview(false)   // reveal/select the preview tab (switch back if a pinned tab was active)
        }
    }

    fun showPreview(rel: String) = diffPreview.show(rel)

    /** Ctrl/Cmd+C → copy the selected file paths (newline-joined), like the VS Code extension. */
    private fun copySelectedPaths() {
        val rels = selectedFiles().map { it.rel }
        if (rels.isNotEmpty()) CopyPasteManager.getInstance().setContents(StringSelection(rels.joinToString("\n")))
    }

    private fun selectedTodos(): List<Todo> =
        todoTree.selectionPaths?.mapNotNull { (it.lastPathComponent as? DefaultMutableTreeNode)?.userObject as? Todo } ?: emptyList()

    private fun copyTodos() {
        val t = selectedTodos()
        if (t.isNotEmpty()) CopyPasteManager.getInstance().setContents(StringSelection(t.joinToString("\n") { "- ${it.rel}:${it.line} — ${it.text}" }))  // bullet format, same as VS Code
    }

    /** Inline row buttons: view/unview (check=View, X=Unview) + Open File. (Track lives in the right-click menu.) */
    private fun fileActions(vf: VFile): List<Triple<javax.swing.Icon, String, () -> Unit>> = buildList {
        if (vf.group != Group.UNTRACKED) {
            val viewed = vf.group == Group.VIEWED
            val icon = if (viewed) AllIcons.Actions.Cancel else AllIcons.Actions.Checked
            add(Triple(icon, if (viewed) "Unview" else "View") { svc.toggleViewed(vf.rel); reload() })
        }
        add(Triple(AllIcons.Actions.MenuOpen, "Open File") { svc.openFile(vf.rel) })
    }

    // ---- filter / search panel (name filter + scope + content search over the shown files) ----

    /** Text field with a leading search icon and a trailing clear ✕ that appears when non-empty (like VS Code). */
    private fun clearableSearchField(hint: String): com.intellij.ui.components.fields.ExtendableTextField {
        val f = com.intellij.ui.components.fields.ExtendableTextField()
        f.emptyText.text = hint
        f.addExtension(object : com.intellij.ui.components.fields.ExtendableTextComponent.Extension {
            override fun getIcon(hovered: Boolean): javax.swing.Icon = AllIcons.Actions.Search
            override fun isIconBeforeText() = true
        })
        val clear = object : com.intellij.ui.components.fields.ExtendableTextComponent.Extension {
            override fun getIcon(hovered: Boolean): javax.swing.Icon =
                if (hovered) AllIcons.Actions.CloseHovered else AllIcons.Actions.Close
            override fun getActionOnClick(): Runnable = Runnable { f.text = "" }
            override fun getTooltip() = "Clear"
        }
        f.document.addDocumentListener(object : com.intellij.ui.DocumentAdapter() {
            override fun textChanged(e: javax.swing.event.DocumentEvent) {
                f.removeExtension(clear)
                if (f.text.isNotEmpty()) f.addExtension(clear)
                f.revalidate(); f.repaint()
            }
        })
        return f
    }

    private val filterField = clearableSearchField("Filter by name")
    private val searchField = clearableSearchField("Search in shown files (Enter)")
    private val scopeBox = com.intellij.openapi.ui.ComboBox(arrayOf("All", "Unviewed", "Added", "Modified"))
    // Native find-bar style toggles (same icons/behavior as the IDE's own Find).
    private var caseSel = false
    private var wordSel = false
    private var regexSel = false
    private fun searchToggleAction(text: String, icon: javax.swing.Icon, get: () -> Boolean, set: (Boolean) -> Unit) =
        object : ToggleAction(text, null, icon) {
            override fun getActionUpdateThread() = ActionUpdateThread.EDT
            override fun isSelected(e: AnActionEvent) = get()
            override fun setSelected(e: AnActionEvent, state: Boolean) {
                set(state)
                if (searchField.text.isNotBlank()) runSearch(searchField.text.trim())  // re-run live
            }
        }

    /** True if [f] passes the active name filter + scope + whitespace filter (+ content-search match set
     *  unless [ignoreSearch]). */
    private fun applyFilters(files: List<VFile>, ignoreSearch: Boolean = false): List<VFile> = files.filter { f ->
        (ignoreSearch || searchMatches?.containsKey(f.rel) != false) &&
        !f.wsOnly &&   // whitespace-only change while the hide-whitespace toggle is on
        (nameFilter.isEmpty() || f.rel.contains(nameFilter, ignoreCase = true)) &&
        when (scope) {
            // Untracked/noise files aren't "viewed", so they stay visible in their section (like VS Code).
            "Unviewed" -> f.group != Group.VIEWED
            "Added" -> f.status == "A" || f.status == "U"
            "Modified" -> f.status != "A" && f.status != "U"
            else -> true
        }
    }

    /** Re-slice the already-loaded file set through the filters — no git. */
    private fun refilter() = rebuild(allFiles, lastTodos, lastComments)

    /** Content search over the shown files; results fold into the tree as child rows per file.
     *  Case/word/regex toggles build the matcher exactly like VS Code's buildSearchRegex. */
    private fun runSearch(q: String) {
        val root = project.basePath ?: return
        if (q.isEmpty()) return
        val re = try {
            var src = if (regexSel) q else Regex.escape(q)
            if (wordSel) src = "\\b$src\\b"
            Regex(src, if (caseSel) emptySet() else setOf(RegexOption.IGNORE_CASE))
        } catch (e: Exception) {
            Messages.showErrorDialog(project, e.message ?: "Bad pattern", "Vetty: Invalid Regex")
            return
        }
        // Search only the reviewable slice — user-untracked noise files stay out (like VS Code's visibleFiles).
        val shown = applyFilters(allFiles, ignoreSearch = true).filter { it.group != Group.UNTRACKED }.map { it.rel }
        ApplicationManager.getApplication().executeOnPooledThread {
            val m = LinkedHashMap<String, MutableList<Match>>()
            var n = 0
            outer@ for (rel in shown) {
                val file = java.io.File(root, rel)
                if (file.length() > 1024 * 1024) continue   // huge file — skip the read
                val text = try { file.readText() } catch (e: Exception) { continue }
                if ('\u0000' in text) continue   // binary
                val lines = text.split("\n")
                for (i in lines.indices) {
                    val mt = re.find(lines[i]) ?: continue
                    m.getOrPut(rel) { ArrayList() }.add(Match(rel, i + 1, lines[i], mt.range.first, mt.value.length))
                    if (++n >= 2000) break@outer   // safety cap
                }
            }
            ApplicationManager.getApplication().invokeLater({ searchMatches = m; refilter() }, ModalityState.any())
        }
    }

    init {
        val group = DefaultActionGroup().apply {
            add(RefreshAction()); add(ChangeBaseAction()); add(RangeAction()); add(SinceReviewAction()); add(WhitespaceAction())
            addSeparator()
            add(NestedToggleAction()); add(ExpandAllAction()); add(CollapseAllAction())
        }
        com.intellij.openapi.util.Disposer.register(project, diffPreview)
        val tb = ActionManager.getInstance().createActionToolbar("Vetty", group, true)
        tb.targetComponent = this
        toolbar = tb.component

        // Filter/search wiring. Name filter + scope apply live; content search runs on Enter.
        filterField.document.addDocumentListener(object : com.intellij.ui.DocumentAdapter() {
            override fun textChanged(e: javax.swing.event.DocumentEvent) { nameFilter = filterField.text.trim(); refilter() }
        })
        searchField.document.addDocumentListener(object : com.intellij.ui.DocumentAdapter() {
            override fun textChanged(e: javax.swing.event.DocumentEvent) {
                if (searchField.text.isBlank() && searchMatches != null) { searchMatches = null; refilter() }
            }
        })
        searchField.addKeyListener(object : KeyAdapter() {
            override fun keyPressed(e: KeyEvent) { if (e.keyCode == KeyEvent.VK_ENTER) runSearch(searchField.text.trim()) }
        })
        scopeBox.addActionListener { scope = scopeBox.selectedItem as String; refilter() }

        tree.isRootVisible = false
        tree.showsRootHandles = true
        tree.selectionModel.selectionMode = TreeSelectionModel.DISCONTIGUOUS_TREE_SELECTION  // Ctrl/Shift multi-select
        tree.cellRenderer = cellRenderer
        tree.addMouseListener(object : MouseAdapter() {
            override fun mousePressed(e: MouseEvent) { pressedPath = tree.getPathForLocation(e.x, e.y); maybePopup(e) }
            override fun mouseReleased(e: MouseEvent) = maybePopup(e)
            override fun mouseExited(e: MouseEvent) { if (hoverRow != -1) { hoverRow = -1; hoverIcon = -1; tree.repaint() } }
            override fun mouseClicked(e: MouseEvent) {
                if (e.isPopupTrigger || !SwingUtilities.isLeftMouseButton(e)) return
                if (e.isControlDown || e.isShiftDown || e.isMetaDown) return  // multi-select gesture → don't open
                // Use the press-time path: a double-click that expanded a group must not open the file that slid under the cursor.
                val path = pressedPath ?: return
                val obj = (path.lastPathComponent as? DefaultMutableTreeNode)?.userObject
                if (obj is Match) {  // search hit → jump to the line, matched text selected
                    if (e.clickCount >= 2) { cancelClick(); svc.openMatchPinned(obj.rel, obj.line, obj.col, obj.len) }
                    else scheduleClick { svc.openMatch(obj.rel, obj.line, obj.col, obj.len) }
                    return
                }
                val vf = obj as? VFile ?: return
                // Inline row button hit? (icons sit at the left, before the row content)
                if (e.clickCount == 1) {
                    val rb = tree.getPathBounds(path)
                    val acts = fileActions(vf)
                    if (rb != null && e.x >= rb.x && e.x < rb.x + acts.size * ROW_ICON) {
                        val idx = ((e.x - rb.x) / ROW_ICON).coerceIn(0, acts.size - 1)
                        cancelClick(); acts[idx].third.invoke(); return
                    }
                }
                // During a search, a file row toggles its match rows instead of opening (like VS Code).
                if (searchMatches?.containsKey(vf.rel) == true) {
                    cancelClick()
                    if (e.clickCount == 1) { if (tree.isExpanded(path)) tree.collapsePath(path) else tree.expandPath(path) }
                    return
                }
                // New file (no base content) → open the whole file, not a noisy diff-vs-empty (like VS Code),
                // UNLESS it has a since-review snapshot to diff against.
                if (isNewFile(vf)) {
                    if (e.clickCount >= 2) { cancelClick(); svc.openFile(vf.rel) }
                    else scheduleClick { svc.openFilePreview(vf.rel) }
                    return
                }
                if (e.clickCount >= 2) { cancelClick(); svc.openDiffPinned(vf) }  // double → open fully (pinned)
                else scheduleClick { showPreview(vf.rel) }                         // single → in-place preview (swaps)
            }
        })
        tree.addMouseMotionListener(object : java.awt.event.MouseMotionAdapter() {
            override fun mouseMoved(e: MouseEvent) {
                var hr = -1; var hi = -1; var tip: String? = null
                val row = tree.getRowForLocation(e.x, e.y)
                if (row >= 0) {
                    val vf = (tree.getPathForRow(row)?.lastPathComponent as? DefaultMutableTreeNode)?.userObject as? VFile
                    val rb = tree.getRowBounds(row)
                    val acts = vf?.let { fileActions(it) } ?: emptyList()
                    if (vf != null && rb != null && e.x >= rb.x && e.x < rb.x + acts.size * ROW_ICON) {
                        hr = row; hi = ((e.x - rb.x) / ROW_ICON).coerceIn(0, acts.size - 1); tip = acts[hi].second
                    }
                }
                tree.toolTipText = tip   // tooltip names the inline action (View / Unview)
                tree.cursor = if (hr >= 0) java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR)
                              else java.awt.Cursor.getDefaultCursor()
                if (hr != hoverRow || hi != hoverIcon) { hoverRow = hr; hoverIcon = hi; tree.repaint() }
            }
        })
        tree.addTreeExpansionListener(object : javax.swing.event.TreeExpansionListener {
            override fun treeExpanded(e: javax.swing.event.TreeExpansionEvent) = setGroupExpanded(e, true)
            override fun treeCollapsed(e: javax.swing.event.TreeExpansionEvent) = setGroupExpanded(e, false)
            private fun setGroupExpanded(e: javax.swing.event.TreeExpansionEvent, v: Boolean) {
                when (val o = (e.path.lastPathComponent as? DefaultMutableTreeNode)?.userObject) {
                    is GroupNode -> groupExpanded[o.group] = v
                    is FolderNode -> if (v) collapsedFolders.remove(o.path) else collapsedFolders.add(o.path)
                }
            }
        })
        tree.addKeyListener(object : KeyAdapter() {
            override fun keyPressed(e: KeyEvent) = when (e.keyCode) {
                KeyEvent.VK_V -> toggleViewedSelected()
                KeyEvent.VK_J -> navUnviewed(1)
                KeyEvent.VK_K -> navUnviewed(-1)
                else -> Unit
            }
        })
        todoTree.isRootVisible = false
        todoTree.showsRootHandles = false
        todoTree.selectionModel.selectionMode = TreeSelectionModel.DISCONTIGUOUS_TREE_SELECTION  // Ctrl/Shift multi-select
        todoTree.cellRenderer = cellRenderer
        todoTree.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (!SwingUtilities.isLeftMouseButton(e)) return
                if (e.isControlDown || e.isShiftDown || e.isMetaDown) return  // multi-select gesture → don't open
                val p = todoTree.getPathForLocation(e.x, e.y) ?: return
                val t = (p.lastPathComponent as? DefaultMutableTreeNode)?.userObject as? Todo ?: return
                if (e.clickCount >= 2) { cancelClick(); svc.openTodoPinned(t.rel, t.line) }
                else scheduleClick { svc.openTodo(t.rel, t.line) }
            }
        })

        commentTree.isRootVisible = false
        commentTree.showsRootHandles = false
        commentTree.selectionModel.selectionMode = TreeSelectionModel.DISCONTIGUOUS_TREE_SELECTION  // Ctrl/Shift multi-select
        commentTree.cellRenderer = cellRenderer
        commentTree.addMouseListener(object : MouseAdapter() {
            override fun mousePressed(e: MouseEvent) = commentPopup(e)
            override fun mouseReleased(e: MouseEvent) = commentPopup(e)
            override fun mouseClicked(e: MouseEvent) {
                if (e.isPopupTrigger || !SwingUtilities.isLeftMouseButton(e)) return
                if (e.isControlDown || e.isShiftDown || e.isMetaDown) return  // multi-select gesture → don't jump
                val p = commentTree.getPathForLocation(e.x, e.y) ?: return
                val c = (p.lastPathComponent as? DefaultMutableTreeNode)?.userObject as? VettyStateService.Comment ?: return
                svc.openTodo(c.file, c.line + 1)   // jump to the commented line in the working file
            }
        })

        // Clickable bold headers — click to collapse/expand the section (chevron shows state).
        fun collapsible(h: JBLabel, toggle: () -> Unit) {
            h.cursor = java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR)
            h.addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) { toggle(); applyCollapse() }
            })
        }
        collapsible(reviewHeader) { reviewCollapsed = !reviewCollapsed }
        collapsible(todoHeader) { todoCollapsed = !todoCollapsed }
        collapsible(commentHeader) { commentCollapsed = !commentCollapsed }

        fun pane(label: JBLabel, scroll: JBScrollPane) = JPanel(BorderLayout()).apply {
            add(label, BorderLayout.NORTH); add(scroll, BorderLayout.CENTER)
        }
        // Comments section gets its own header toolbar (Export / Clear) instead of the main toolbar.
        val commentTools = ActionManager.getInstance().createActionToolbar(
            "VettyComments", DefaultActionGroup().apply { add(ExportAction()); add(ClearCommentsAction()) }, true)
        commentTools.targetComponent = this
        val commentPane = JPanel(BorderLayout()).apply {
            add(JPanel(BorderLayout()).apply {
                add(commentHeader, BorderLayout.WEST); add(commentTools.component, BorderLayout.EAST)
            }, BorderLayout.NORTH)
            add(commentScroll, BorderLayout.CENTER)
        }
        // Three peer sections — Review / TODOs / Comments — each resizable (drag) AND collapsible (click header).
        bottomSplitter = OnePixelSplitter(true, 0.5f).apply {
            firstComponent = pane(todoHeader, todoScroll)
            secondComponent = commentPane
        }
        mainSplitter = OnePixelSplitter(true, 0.6f).apply {
            firstComponent = pane(reviewHeader, reviewScroll)
            secondComponent = bottomSplitter
        }
        // Status line (base · progress · mode) + a collapsible "Search" section pinned at the very top.
        val filterRow = JPanel(BorderLayout(4, 0)).apply {
            border = JBUI.Borders.empty(0, 4, 2, 4)
            add(filterField, BorderLayout.CENTER)
            add(scopeBox, BorderLayout.EAST)
        }
        val togglesGroup = DefaultActionGroup().apply {
            add(searchToggleAction("Match Case", AllIcons.Actions.MatchCase, { caseSel }, { caseSel = it }))
            add(searchToggleAction("Match Whole Word", AllIcons.Actions.Words, { wordSel }, { wordSel = it }))
            add(searchToggleAction("Use Regular Expression", AllIcons.Actions.Regex, { regexSel }, { regexSel = it }))
        }
        val togglesTb = ActionManager.getInstance().createActionToolbar("VettySearchToggles", togglesGroup, true)
        togglesTb.targetComponent = this
        val searchRow = JPanel(BorderLayout(4, 0)).apply {
            border = JBUI.Borders.empty(0, 4, 2, 4)
            add(searchField, BorderLayout.CENTER)
            add(togglesTb.component, BorderLayout.EAST)
        }
        searchPanel = JPanel().apply {
            layout = javax.swing.BoxLayout(this, javax.swing.BoxLayout.Y_AXIS)
            add(filterRow); add(searchRow)
        }
        collapsible(searchHeader) { searchCollapsed = !searchCollapsed }
        // BoxLayout centers children with mismatched alignmentX — pin everything to the left edge.
        for (c in listOf(header, searchHeader, searchPanel, filterRow, searchRow)) c.alignmentX = 0f
        val north = JPanel().apply {
            layout = javax.swing.BoxLayout(this, javax.swing.BoxLayout.Y_AXIS)
            add(header); add(searchHeader); add(searchPanel)
        }
        setContent(JPanel(BorderLayout()).apply {
            add(north, BorderLayout.NORTH)
            add(mainSplitter, BorderLayout.CENTER)
        })

        svc.onChange = { reload() }   // git work runs off the EDT
        svc.onContentChange = { ApplicationManager.getApplication().invokeLater { regroup() } }  // fast, no git
        reload()
    }

    // Debounce single vs double click: a single-click open waits out the double-click window so a
    // following double-click can cancel it (otherwise both fire → file opens twice).
    private var clickTimer: javax.swing.Timer? = null
    private fun scheduleClick(run: () -> Unit) {
        clickTimer?.stop()
        clickTimer = javax.swing.Timer(250) { run() }.apply { isRepeats = false; start() }
    }
    private fun cancelClick() { clickTimer?.stop(); clickTimer = null }

    private fun simpleAction(text: String, run: () -> Unit) = object : AnAction(text) {
        override fun getActionUpdateThread() = ActionUpdateThread.EDT
        override fun actionPerformed(e: AnActionEvent) = run()
    }

    private fun maybePopup(e: MouseEvent) {
        if (!e.isPopupTrigger) return
        val path = tree.getPathForLocation(e.x, e.y) ?: return
        val obj = (path.lastPathComponent as? DefaultMutableTreeNode)?.userObject
        if (obj is GroupNode) { showGroupMenu(e, obj.group); return }   // right-click a section → View/Unview all
        if (tree.selectionPaths?.contains(path) != true) tree.selectionPath = path  // right-click outside selection → reselect
        if (selectedFiles().isEmpty()) return
        val inUntracked = activeFile()?.group == Group.UNTRACKED
        val group = DefaultActionGroup().apply {
            if (!inUntracked) {
                add(simpleAction(if (activeFile()?.group == Group.VIEWED) "Unview" else "View") { toggleViewedSelected() })
            }
            add(simpleAction("Open Diff") { activeFile()?.let { showPreview(it.rel) } })
            add(simpleAction("Open File") { activeFile()?.let { svc.openFile(it.rel) } })
            addSeparator()
            if (inUntracked) add(simpleAction("Track") { selectedFiles().forEach { svc.track(it.rel) }; reload() })
            else add(simpleAction("Untrack") { selectedFiles().forEach { svc.untrack(it.rel) }; reload() })
        }
        com.intellij.openapi.ui.popup.JBPopupFactory.getInstance().createActionGroupPopup(
            null, group, com.intellij.ide.DataManager.getInstance().getDataContext(tree),
            com.intellij.openapi.ui.popup.JBPopupFactory.ActionSelectionAid.MNEMONICS, true
        ).show(com.intellij.ui.awt.RelativePoint(e))
    }

    private fun selectedComments(): List<VettyStateService.Comment> =
        commentTree.selectionPaths?.mapNotNull { (it.lastPathComponent as? DefaultMutableTreeNode)?.userObject as? VettyStateService.Comment }
            ?: emptyList()

    private fun copyComments(list: List<VettyStateService.Comment>) =
        CopyPasteManager.getInstance().setContents(  // bullet format, same as VS Code's copy-comment
            StringSelection(VettyParse.exportComments(list).split("\n").joinToString("\n") { "- $it" }))

    /** Right-click a comment (or several) in the Comments pane → Go to / Edit / Copy / Delete. */
    private fun commentPopup(e: MouseEvent) {
        if (!e.isPopupTrigger) return
        val p = commentTree.getPathForLocation(e.x, e.y) ?: return
        if (commentTree.selectionPaths?.contains(p) != true) commentTree.selectionPath = p  // right-click outside selection → reselect
        val sel = selectedComments()
        if (sel.isEmpty()) return
        val group = DefaultActionGroup().apply {
            if (sel.size == 1) {
                val c = sel[0]
                add(simpleAction("Go to") { svc.openTodo(c.file, c.line + 1) })
                add(simpleAction("Edit") {
                    Messages.showInputDialog(project, "Comment", "Edit Comment", null, c.body, null)
                        ?.let { c.body = it; svc.refreshUiAndGutters() }
                })
                add(simpleAction("Copy") { copyComments(sel) })
                add(simpleAction("Delete") { svc.deleteComment(c); svc.refreshUiAndGutters() })
            } else {
                add(simpleAction("Copy ${sel.size}") { copyComments(sel) })
                add(simpleAction("Delete ${sel.size}") { sel.forEach { svc.deleteComment(it) }; svc.refreshUiAndGutters() })
            }
        }
        com.intellij.openapi.ui.popup.JBPopupFactory.getInstance().createActionGroupPopup(
            null, group, com.intellij.ide.DataManager.getInstance().getDataContext(commentTree),
            com.intellij.openapi.ui.popup.JBPopupFactory.ActionSelectionAid.MNEMONICS, true
        ).show(com.intellij.ui.awt.RelativePoint(e))
    }

    /** Open every file in a section — diff for changed files, whole file for new ones. Confirms if many. */
    private fun openAllFiles(items: List<VFile>) {
        if (items.size > 30 &&
            Messages.showYesNoDialog(project, "Open ${items.size} editors?", "Vetty", null) != Messages.YES) return
        for (f in items) if (isNewFile(f)) svc.openFile(f.rel) else svc.openDiffPinned(f)
    }

    /** Right-click a section header → bulk View all / Unview all / Open all for that section. */
    private fun showGroupMenu(e: MouseEvent, grp: Group) {
        val items = current.filter { it.group == grp }
        if (items.isEmpty()) return
        val group = DefaultActionGroup()
        when (grp) {
            Group.UNVIEWED -> group.add(simpleAction("View all (${items.size})") {
                items.forEach { svc.markViewed(it.rel) }; reload()
            })
            Group.VIEWED -> group.add(simpleAction("Unview all (${items.size})") {
                items.forEach { svc.unmarkViewed(it.rel) }; reload()
            })
            Group.UNTRACKED -> group.add(simpleAction("Track all (${items.size})") {
                items.forEach { svc.track(it.rel) }; reload()
            })
        }
        group.add(simpleAction("Open all (${items.size})") { openAllFiles(items) })
        com.intellij.openapi.ui.popup.JBPopupFactory.getInstance().createActionGroupPopup(
            null, group, com.intellij.ide.DataManager.getInstance().getDataContext(tree),
            com.intellij.openapi.ui.popup.JBPopupFactory.ActionSelectionAid.MNEMONICS, true
        ).show(com.intellij.ui.awt.RelativePoint(e))
    }

    /** Added/untracked file with no since-review snapshot — nothing to diff against. */
    private fun isNewFile(f: VFile) = (f.status == "A" || f.status == "U") && !svc.hasSinceReviewDiff(f.rel)

    /** All selected changed files (multi-select); the most-recently clicked one. */
    private fun selectedFiles(): List<VFile> =
        tree.selectionPaths?.mapNotNull { (it.lastPathComponent as? DefaultMutableTreeNode)?.userObject as? VFile } ?: emptyList()

    private fun activeFile(): VFile? =
        (tree.lastSelectedPathComponent as? DefaultMutableTreeNode)?.userObject as? VFile

    /** Toggle viewed on the selection; if a single file was just marked viewed, auto-advance like VS Code. */
    private fun toggleViewedSelected() {
        val sel = selectedFiles()
        if (sel.isEmpty()) return
        val advanceFrom = if (sel.size == 1 && !svc.isViewed(sel[0].rel)) sel[0].rel else null
        sel.forEach { svc.toggleViewed(it.rel) }
        // reload is async now — advance only after the rebuilt `current` reflects the new groups.
        reload { advanceFrom?.let { advanceToNextUnviewed(it) } }
    }

    /** Select + preview the next still-unviewed file after `fromRel` (wraps around). */
    private fun advanceToNextUnviewed(fromRel: String) {
        val order = current.map { it.rel }
        val start = order.indexOf(fromRel).coerceAtLeast(0)
        val rotated = order.drop(start + 1) + order.take(start + 1)
        val next = rotated.map { r -> current.first { it.rel == r } }.firstOrNull { it.group == Group.UNVIEWED }
        next?.let { select(it.rel); openRow(it) }
    }

    /** Open a row the right way: whole file for new files, else the in-place diff preview. */
    private fun openRow(f: VFile) {
        if (isNewFile(f)) svc.openFilePreview(f.rel) else showPreview(f.rel)
    }

    private fun navUnviewed(dir: Int) {
        val unviewed = current.filter { it.group == Group.UNVIEWED }
        if (unviewed.isEmpty()) return
        // Anchor on the file in the ACTIVE EDITOR (covers open diffs via lastDiffRel), like VS Code;
        // fall back to the tree selection.
        val cur = FileEditorManager.getInstance(project).selectedTextEditor?.let { svc.relForEditor(it) }
            ?: activeFile()?.rel
        val idx = unviewed.indexOfFirst { it.rel == cur }
        val next = if (idx < 0) (if (dir > 0) 0 else unviewed.size - 1)
                   else ((idx + dir) % unviewed.size + unviewed.size) % unviewed.size
        select(unviewed[next].rel)
        openRow(unviewed[next])
    }

    private fun select(rel: String) {
        // Walk the WHOLE tree — nested mode puts files under folder nodes, not directly under groups.
        val e = (tree.model.root as DefaultMutableTreeNode).depthFirstEnumeration()
        while (e.hasMoreElements()) {
            val n = e.nextElement() as DefaultMutableTreeNode
            if ((n.userObject as? VFile)?.rel == rel) {
                val path = TreePath(n.path)
                tree.selectionPath = path
                tree.scrollPathToVisible(path)
                return
            }
        }
    }

    private fun chev(c: Boolean) = if (c) "▸" else "▾"
    private fun updateSectionTitles() {
        searchHeader.text = "${chev(searchCollapsed)}  Search"
        reviewHeader.text = "${chev(reviewCollapsed)}  Review ($reviewCount)"
        todoHeader.text = "${chev(todoCollapsed)}  TODOs ($todoCount)"
        commentHeader.text = "${chev(commentCollapsed)}  Comments ($commentCount)"
    }

    /** Push the divider so a collapsed side shrinks to just its header; leave it when neither/both collapsed. */
    private fun setSplit(sp: OnePixelSplitter, firstCol: Boolean, secondCol: Boolean, fH: JBLabel, sH: JBLabel) {
        val h = sp.height
        if (h <= 0) return
        sp.proportion = when {
            firstCol && !secondCol -> ((fH.preferredSize.height + 2f) / h).coerceIn(0.02f, 0.5f)
            !firstCol && secondCol -> (1f - (sH.preferredSize.height + 2f) / h).coerceIn(0.5f, 0.98f)
            else -> sp.proportion
        }
    }

    /** Collapse/expand any of the sections; keeps each header visible. */
    private fun applyCollapse() {
        if (::searchPanel.isInitialized) {
            searchPanel.isVisible = !searchCollapsed
            searchPanel.parent?.revalidate(); searchPanel.parent?.repaint()
        }
        reviewScroll.isVisible = !reviewCollapsed
        todoScroll.isVisible = !todoCollapsed
        commentScroll.isVisible = !commentCollapsed
        updateSectionTitles()
        setSplit(bottomSplitter, todoCollapsed, commentCollapsed, todoHeader, commentHeader)
        setSplit(mainSplitter, reviewCollapsed, todoCollapsed && commentCollapsed, reviewHeader, todoHeader)
        bottomSplitter.revalidate(); bottomSplitter.repaint()
        mainSplitter.revalidate(); mainSplitter.repaint()
    }

    /** Reload: ALL git work runs off the EDT (it spawns several processes — on-EDT it freezes the UI
     *  on big repos). [onDone] runs on the EDT after the tree has rebuilt. */
    fun reload(onDone: (() -> Unit)? = null) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val files = svc.load(); val todos = svc.todos(); val comments = svc.allComments()
            ApplicationManager.getApplication().invokeLater({ rebuild(files, todos, comments); onDone?.invoke() }, ModalityState.any())
        }
    }

    /** Typing path: re-group the existing files in-process (no git) so a typed file flips viewed↔unviewed instantly. */
    private fun regroup() {
        if (allFiles.isEmpty()) return
        rebuild(allFiles.map { it.copy(group = svc.groupFor(it.rel)) }, lastTodos, lastComments)
    }

    /** File leaf node; when a content search is active, its matches hang off it as child rows. */
    private fun fileNode(f: VFile): DefaultMutableTreeNode {
        val n = DefaultMutableTreeNode(f)
        searchMatches?.get(f.rel)?.forEach { n.add(DefaultMutableTreeNode(it)) }
        return n
    }

    private fun rebuild(files: List<VFile>, todos: List<Todo>, comments: List<VettyStateService.Comment>) {
        lastTodos = todos; lastComments = comments
        allFiles = files
        val shown = applyFilters(files)
        current = shown   // nav/advance/select stay within the filtered slice, like VS Code
        val root = DefaultMutableTreeNode()
        val groupNodes = HashMap<Group, DefaultMutableTreeNode>()
        // Always show all three groups (even at 0) so the layout is stable, like the VS Code version.
        for (grp in listOf(Group.UNVIEWED, Group.VIEWED, Group.UNTRACKED)) {
            val items = shown.filter { it.group == grp }
            val gn = DefaultMutableTreeNode(GroupNode(grp, items.size))
            if (svc.nested()) buildFolders(gn, items, "") else items.forEach { gn.add(fileNode(it)) }
            root.add(gn)
            groupNodes[grp] = gn
        }
        tree.model = DefaultTreeModel(root)
        // Restore expand state from our explicit map (survives empty groups gaining items).
        for ((grp, gn) in groupNodes) if (groupExpanded[grp] == true) {
            tree.expandPath(TreePath(gn.path))
            if (svc.nested()) expandFolders(gn)   // folders default expanded
        }
        // An active search auto-expands everything so the match rows are visible.
        if (searchMatches != null) { var i = 0; while (i < tree.rowCount) { tree.expandRow(i); i++ } }

        // Slice TODOs by the Review panel's active filters (scope/name/search), like VS Code.
        val shownRels = shown.map { it.rel }.toHashSet()
        val shownTodos = todos.filter { it.rel in shownRels }
        val todoRoot = DefaultMutableTreeNode()
        shownTodos.forEach { todoRoot.add(DefaultMutableTreeNode(it)) }
        todoTree.model = DefaultTreeModel(todoRoot)
        todoCount = shownTodos.size

        val commentRoot = DefaultMutableTreeNode()
        comments.forEach { commentRoot.add(DefaultMutableTreeNode(it)) }
        commentTree.model = DefaultTreeModel(commentRoot)
        commentCount = comments.size
        reviewCount = shown.size
        updateSectionTitles()

        val base = svc.base() ?: "(no branch)"
        val active = files.filter { it.group != Group.UNTRACKED }   // progress counts the FULL set, not the filtered slice
        val vw = active.count { it.group == Group.VIEWED }
        val progress = when {
            active.isEmpty() -> ""
            vw == active.size -> "✓ ${active.size}"
            else -> "$vw/${active.size}"
        }
        // Make active filtering visible — a filter can silently hide files.
        val filtered = if (shown.size < files.size) "⚠ filtered: ${shown.size} of ${files.size}" else ""
        val baseShort = if (base.length > 24) base.take(23) + "…" else base
        header.text = listOf("base: $baseShort", filtered, progress, svc.diffStatus())
            .filter { it.isNotEmpty() }.joinToString("  ·  ")
        header.toolTipText = "base: $base"   // full name on hover
        tree.emptyText.clear()
        if (files.isEmpty()) {
            if (!svc.welcomed()) {   // first-run welcome with a "choose base" link
                tree.emptyText.appendLine("Welcome to Vetty", SimpleTextAttributes.REGULAR_BOLD_ATTRIBUTES, null)
                tree.emptyText.appendLine("Vet the code you didn't write — review every changed file vs a base branch.",
                    SimpleTextAttributes.GRAYED_ATTRIBUTES, null)
                tree.emptyText.appendLine("Choose base branch", SimpleTextAttributes.LINK_PLAIN_ATTRIBUTES) { chooseBase(null) }
            } else {
                tree.emptyText.text = "No changes vs $base"
            }
        } else if (shown.isEmpty()) {
            tree.emptyText.text = "No files match the filter"
        }
    }

    /** Build a nested folder hierarchy for [files] under [parent], splitting rels on '/'. */
    private fun buildFolders(parent: DefaultMutableTreeNode, files: List<VFile>, prefix: String) {
        val folders = LinkedHashMap<String, MutableList<VFile>>()
        val leaves = ArrayList<VFile>()
        for (f in files) {
            val rest = f.rel.substring(prefix.length)
            val slash = rest.indexOf('/')
            if (slash < 0) leaves.add(f) else folders.getOrPut(rest.substring(0, slash)) { ArrayList() }.add(f)
        }
        for ((seg, fs) in folders) {
            val fn = DefaultMutableTreeNode(FolderNode(seg, prefix + seg + "/"))
            parent.add(fn)
            buildFolders(fn, fs, prefix + seg + "/")
        }
        leaves.forEach { parent.add(fileNode(it)) }
    }

    private fun expandFolders(node: DefaultMutableTreeNode) {
        for (i in 0 until node.childCount) {
            val c = node.getChildAt(i) as DefaultMutableTreeNode
            val fn = c.userObject as? FolderNode ?: continue
            if (fn.path !in collapsedFolders) { tree.expandPath(TreePath(c.path)); expandFolders(c) }  // default expanded
        }
    }

    /** Ancestry-labeled base picker (parent / ancestor / descendant / diverged), shown under [under] or the tree. */
    private fun chooseBase(under: java.awt.Component?) {
        val items = svc.rankedBranches()
        if (items.isEmpty()) return
        val group = DefaultActionGroup()
        for (bi in items) {
            val text = if (bi.label.isEmpty()) bi.branch else "${bi.branch}   —   ${bi.label}"
            group.add(object : ToggleAction(text) {
                override fun getActionUpdateThread() = ActionUpdateThread.EDT
                override fun isSelected(e: AnActionEvent) = svc.base() == bi.branch
                override fun setSelected(e: AnActionEvent, state: Boolean) { svc.setBase(bi.branch); svc.setWelcomed(); reload() }
            })
        }
        val popup = com.intellij.openapi.ui.popup.JBPopupFactory.getInstance().createActionGroupPopup(
            "Base Branch", group, com.intellij.ide.DataManager.getInstance().getDataContext(tree),
            com.intellij.openapi.ui.popup.JBPopupFactory.ActionSelectionAid.SPEEDSEARCH, false
        )
        if (under != null) popup.showUnderneathOf(under)
        else popup.showInBestPositionFor(com.intellij.ide.DataManager.getInstance().getDataContext(tree))
    }

    // ---- toolbar actions (inner: share svc + reload) ----

    private abstract inner class UiAction(text: String, desc: String, icon: javax.swing.Icon) :
        AnAction(text, desc, icon) {
        override fun getActionUpdateThread() = ActionUpdateThread.EDT
    }

    private inner class RefreshAction : UiAction("Refresh", "Reload changed files", AllIcons.Actions.Refresh) {
        override fun actionPerformed(e: AnActionEvent) = reload()
    }

    private inner class ChangeBaseAction : UiAction("Change Base", "Pick the base branch", AllIcons.Vcs.Branch) {
        override fun actionPerformed(e: AnActionEvent) = chooseBase(e.inputEvent?.component)
    }

    /** Tree (nested folders) ⇄ flat list. */
    private inner class NestedToggleAction : UiAction("View Mode", "Tree / flat", AllIcons.Actions.ListFiles) {
        override fun update(e: AnActionEvent) {
            e.presentation.icon = if (svc.nested()) AllIcons.Actions.ShowAsTree else AllIcons.Actions.ListFiles
            e.presentation.text = if (svc.nested()) "View: tree" else "View: flat"
        }
        override fun actionPerformed(e: AnActionEvent) { svc.toggleNested(); reload() }
    }

    private inner class ExpandAllAction : UiAction("Expand All", "Expand all folders", AllIcons.Actions.Expandall) {
        override fun update(e: AnActionEvent) { e.presentation.isEnabledAndVisible = svc.nested() }  // tree mode only
        override fun actionPerformed(e: AnActionEvent) { collapsedFolders.clear(); reload() }
    }

    private inner class CollapseAllAction : UiAction("Collapse All", "Collapse all folders", AllIcons.Actions.Collapseall) {
        override fun update(e: AnActionEvent) { e.presentation.isEnabledAndVisible = svc.nested() }  // tree mode only
        override fun actionPerformed(e: AnActionEvent) {
            // Collapse only folders, not the Unviewed/Viewed/Untracked group tabs.
            collectFolderPaths(tree.model.root as DefaultMutableTreeNode, collapsedFolders)
            reload()   // rebuild applies the collapsed state (persists across refreshes)
        }
        private fun collectFolderPaths(node: DefaultMutableTreeNode, out: MutableSet<String>) {
            for (i in 0 until node.childCount) {
                val c = node.getChildAt(i) as DefaultMutableTreeNode
                (c.userObject as? FolderNode)?.let { out.add(it.path) }
                collectFolderPaths(c, out)
            }
        }
    }

    /** Range toggle: whole branch (git-compare) ↔ uncommitted (git-commit), like VS Code. */
    private inner class RangeAction : UiAction("Range", "Whole branch vs uncommitted (vs HEAD)", AllIcons.Actions.Diff) {
        override fun update(e: AnActionEvent) {
            val commit = svc.isCommitRange()
            e.presentation.icon = if (commit) AllIcons.Vcs.CommitNode else AllIcons.Actions.Diff
            e.presentation.text = if (commit) "Range: uncommitted (vs HEAD)" else "Range: whole branch"
        }
        override fun actionPerformed(e: AnActionEvent) { svc.toggleRange(); reload() }
    }

    /** Hide files whose changes are whitespace-only (formatting noise). */
    private inner class WhitespaceAction :
        ToggleAction("Hide Whitespace-Only Changes", "Hide files whose changes vs the base are whitespace-only", AllIcons.Actions.ToggleVisibility) {
        override fun getActionUpdateThread() = ActionUpdateThread.EDT
        override fun isSelected(e: AnActionEvent) = svc.hideWhitespace()
        override fun setSelected(e: AnActionEvent, state: Boolean) { svc.toggleHideWhitespace(); reload() }
    }

    /** Compare overlay: unviewed files diff against their last-viewed snapshot vs the range base. */
    private inner class SinceReviewAction :
        UiAction("Compare", "Diff unviewed files vs their last-viewed snapshot, or the range base", AllIcons.Actions.Checked) {
        override fun update(e: AnActionEvent) {
            val on = svc.sinceReview()
            e.presentation.icon = if (on) AllIcons.Actions.Checked else AllIcons.Actions.Cancel
            e.presentation.text = if (on) "Compare: last viewed" else "Compare: base"
        }
        override fun actionPerformed(e: AnActionEvent) { svc.toggleSinceReview(); reload() }
    }

    private inner class ExportAction :
        UiAction("Export Comments", "Copy all comments as file:line — note", AllIcons.Actions.Copy) {
        override fun actionPerformed(e: AnActionEvent) {
            CopyPasteManager.getInstance().setContents(StringSelection(svc.exportComments()))
        }
    }

    private inner class ClearCommentsAction :
        UiAction("Clear Comments", "Delete all Vetty comments", AllIcons.Actions.GC) {
        override fun actionPerformed(e: AnActionEvent) {
            if (Messages.showYesNoDialog(project, "Delete all Vetty comments?", "Vetty", null) == Messages.YES) {
                svc.clearComments(); svc.refreshUiAndGutters()
            }
        }
    }

    /** Wraps the text renderer and appends clickable inline icons after a file row. */
    private inner class VettyCellRenderer : javax.swing.tree.TreeCellRenderer {
        private val text = VettyTextRenderer(svc) { rel -> searchMatches?.get(rel)?.size ?: 0 }
        override fun getTreeCellRendererComponent(
            tree: JTree, value: Any?, selected: Boolean, expanded: Boolean,
            leaf: Boolean, row: Int, hasFocus: Boolean
        ): java.awt.Component {
            val comp = text.getTreeCellRendererComponent(tree, value, selected, expanded, leaf, row, hasFocus)
            val vf = (value as? DefaultMutableTreeNode)?.userObject as? VFile ?: return comp
            val h = comp.preferredSize.height.coerceAtLeast(18)
            return JPanel(java.awt.FlowLayout(java.awt.FlowLayout.LEFT, 0, 0)).apply {
                isOpaque = false
                fileActions(vf).forEachIndexed { i, (icon, tip, _) ->
                    add(IconCell(icon, row == hoverRow && i == hoverIcon).apply {
                        toolTipText = tip
                        preferredSize = java.awt.Dimension(ROW_ICON, h)
                    })
                }
                add(comp)
            }
        }
    }
}

private const val ROW_ICON = 22

/** Icon label that paints Rider's rounded action-button hover background when hovered. */
private class IconCell(icon: javax.swing.Icon, private val hovered: Boolean) : JBLabel(icon) {
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
    f.status == "R" -> "R" to FileStatus.MODIFIED
    f.status == "C" -> "C" to FileStatus.MODIFIED
    else -> "M" to FileStatus.MODIFIED
}

private class VettyTextRenderer(
    private val svc: VettyService,
    private val matchCount: (String) -> Int,   // active-search hits for a file row ("N matches")
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
                    Group.UNVIEWED -> "Unviewed"; Group.VIEWED -> "Viewed"; Group.UNTRACKED -> "Untracked"
                }
                append("$label (${obj.count})", SimpleTextAttributes.REGULAR_BOLD_ATTRIBUTES)
            }
            is FolderNode -> {
                icon = AllIcons.Nodes.Folder
                append(obj.name)
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
                append("   ${obj.rel.substringAfterLast('/')}:${obj.line}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
            }
            is VettyStateService.Comment -> {
                icon = AllIcons.General.Balloon
                append(obj.body)
                val loc = if (obj.span > 0) "${obj.line + 1}-${obj.line + obj.span + 1}" else "${obj.line + 1}"
                append("   ${obj.file.substringAfterLast('/')}:$loc", SimpleTextAttributes.GRAYED_ATTRIBUTES)
            }
            is VFile -> {
                val name = obj.rel.substringAfterLast('/')
                val dir = obj.rel.substringBeforeLast('/', "")
                val (letter, status) = statusInfo(obj)
                val color = status.color
                icon = FileTypeManager.getInstance().getFileTypeByFileName(name).icon
                append("$letter  ", SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, color))
                append(name, SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, color))  // filename colored by status
                val extras = buildList {
                    val mc = matchCount(obj.rel)
                    if (mc > 0) add("$mc match${if (mc == 1) "" else "es"}")
                    if (obj.add > 0 || obj.del > 0) add("+${obj.add} −${obj.del}")
                    if (dir.isNotEmpty() && !svc.nested()) add(dir)   // folders show the path in tree mode
                }
                if (extras.isNotEmpty()) append("   ${extras.joinToString("  ·  ")}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                val n = svc.commentsFor(obj.rel).size
                if (n > 0) append("  💬$n", SimpleTextAttributes.GRAYED_ATTRIBUTES)
            }
        }
    }
}

// ---- inline comments: gutter icons -------------------------------------------------------

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
        for (c in svc.commentsFor(rel)) {
            val line = VettyParse.reanchor(lines, c.line, c.anchor)
            if (persist && line != c.line) c.line = line   // persist drift only from the real file
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
    override fun getIcon() = AllIcons.General.Balloon
    override fun getTooltipText() = c.body
    override fun isNavigateAction() = true
    override fun getClickAction(): AnAction = object : AnAction() {
        override fun actionPerformed(e: AnActionEvent) {
            val svc = project.service<VettyService>()
            val group = DefaultActionGroup().apply {
                add(object : AnAction("Edit") {
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
                    override fun actionPerformed(ev: AnActionEvent) { svc.deleteComment(c); svc.refreshUiAndGutters() }
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
