package dev.vetty

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.editor.event.EditorFactoryEvent
import com.intellij.openapi.editor.event.EditorFactoryListener
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import com.intellij.util.Alarm
import git4idea.repo.GitRepository
import git4idea.repo.GitRepositoryChangeListener

/** Wires up gutter decoration on every editor (incl. diff viewers) + auto-refresh on any file/git change. */
class VettyStartup : ProjectActivity {
    override suspend fun execute(project: Project) {
        val conn = project.messageBus.connect()

        // Decorate any editor as it's created — covers normal tabs AND the editors inside diff viewers.
        EditorFactory.getInstance().addEditorFactoryListener(object : EditorFactoryListener {
            override fun editorCreated(event: EditorFactoryEvent) {
                val ed = event.editor
                if (ed.project == null || ed.project == project) VettyGutter.decorate(project, ed)
            }
        }, project)

        // Decorate already-open editors (plugin loaded after files were opened).
        ApplicationManager.getApplication().invokeLater { VettyGutter.redecorateAll(project) }

        // Auto-refresh the tree on any file change (incl. out-of-editor AI edits). Debounced.
        // ponytail: 150ms coalescing Alarm — bump if a busy repo feels chatty.
        val base = project.basePath
        val alarm = Alarm(Alarm.ThreadToUse.SWING_THREAD, project)
        conn.subscribe(VirtualFileManager.VFS_CHANGES, object : BulkFileListener {
            override fun after(events: List<out VFileEvent>) {
                // VFS events are application-wide — only refresh for changes inside THIS project.
                if (base == null || events.none { it.path.startsWith("$base/") }) return
                alarm.cancelAllRequests()
                alarm.addRequest({ project.service<VettyService>().onChange?.invoke() }, 150)
            }
        })

        // Instant refresh on git state changes (checkout/pull/commit/stage), incl. from an external terminal.
        conn.subscribe(GitRepository.GIT_REPO_CHANGE, GitRepositoryChangeListener {
            project.service<VettyService>().onChange?.invoke()
        })

        // Re-flag a viewed file as unviewed while you type — fast in-process re-group (no git), short debounce.
        val typeAlarm = Alarm(Alarm.ThreadToUse.SWING_THREAD, project)
        EditorFactory.getInstance().eventMulticaster.addDocumentListener(object : DocumentListener {
            override fun documentChanged(event: DocumentEvent) {
                val vf = FileDocumentManager.getInstance().getFile(event.document) ?: return
                if (base != null && vf.path.startsWith("$base/")) {
                    typeAlarm.cancelAllRequests()
                    typeAlarm.addRequest({ project.service<VettyService>().onContentChange?.invoke() }, 60)
                }
            }
        }, project)
    }
}
