package dev.vetty

import com.google.gson.GsonBuilder
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Guided review: any Claude session (vetty-review skill) writes a review order and context notes to
 * <git-dir>/vetty/claude-review.json; Vetty publishes its review set to <git-dir>/vetty/scope.json.
 * Both editors share the files. Extension functions on VettyService.
 */

/** " · guided · 2h ago · 3 commits behind · 2 unannotated" ("" when off / none). */
fun VettyService.guidedSummary(): String {
    if (!state.guidedReview) return ""
    val review = claudeReview() ?: return ""
    val steps = steps()
    if (steps.isEmpty()) return ""
    val missing = reviewRels.count { it !in steps && !isIgnored(it) }
    val behind = guidedBehind
    return listOf(
        " · guided",
        VettyReviewFile.ago(review.writtenAt),
        if (behind != null && behind > 0) "$behind commit${if (behind == 1) "" else "s"} behind" else "",
        if (missing > 0) "$missing unannotated" else "",
    ).filter { it.isNotEmpty() }.joinToString(" · ")
}

/** Commits since the review's recorded HEAD (null = unknown / none). One rev-list per load, only while on. */
internal fun VettyService.refreshGuidedBehind() {
    val head = (if (state.guidedReview) claudeReview()?.head else null) ?: run { guidedBehind = null; return }
    guidedBehind = git("rev-list", "--count", "$head..HEAD").trim().toIntOrNull()
}

/** Branch named inside the review file, whatever branch we're on (for the "annotated for X" message). */
fun VettyService.claudeReviewFileBranch(): String = try {
    JsonParser.parseString(claudeFile()!!.readText()).asJsonObject.get("branch")?.asString ?: ""
} catch (e: Exception) { "" }

internal fun VettyService.claudeFile(): java.io.File? = gitDirCache?.let { java.io.File(it, "vetty/claude-review.json") }

/** Parsed review for the current branch (re-read only when the file or branch changes). */
fun VettyService.claudeReview(): VettyReviewFile.ClaudeReview? = synchronized(this) {
    val f = claudeFile()
    val key = if (f != null && f.isFile) "${f.lastModified()}:${f.length()}:$curBranch" else null
    if (key != claudeKey) {
        claudeVal = if (key == null) null
            else try { VettyReviewFile.parseClaudeReview(f!!.readText(), curBranch, prefixCache) } catch (e: Exception) { null }
        claudeKey = key
    }
    return claudeVal
}

/** Claude context notes — read-only context, NOT change requests (never gate stage-on-view). Hidden
 *  while Guided Review is off, and only on files in this review: a note on a file Vetty doesn't list
 *  has no row to belong to. */
fun VettyService.aiComments(): List<VettyStateService.Comment> =
    if (!state.guidedReview) emptyList() else claudeReview()?.comments?.filter { it.file in reviewRels } ?: emptyList()
fun VettyService.aiCommentsFor(rel: String) = aiComments().filter { it.file == rel }

/** Delete comments of either kind: Claude notes leave the shared review file; local ones leave state. */
fun VettyService.deleteAnyComments(list: List<VettyStateService.Comment>) {
    val (ai, local) = list.partition { it.ai }
    local.forEach { deleteComment(it) }
    val f = claudeFile()
    if (ai.isEmpty() || f == null) return
    try { f.writeText(VettyReviewFile.removeClaudeComments(f.readText(), ai, prefixCache)) }
    catch (e: Exception) { Logger.getInstance("#dev.vetty").warn("could not update ${f.path}", e) }
}

/** Delete the guided review file (Claude's order + all its notes) — shared, so both editors clear.
 *  false = nothing to clear. */
fun VettyService.clearGuidedReview(): Boolean {
    val f = claudeFile() ?: return false
    return f.isFile && f.delete()
}

fun VettyService.guidedReview(): Boolean = state.guidedReview
fun VettyService.toggleGuidedReview() { state.guidedReview = !state.guidedReview; scheduleSave() }
fun VettyService.hasReviewOrder(): Boolean = claudeReview()?.order?.keys?.any { it in reviewRels } == true
/** (index, note) while the sort toggle is on and Claude listed [rel]; else null. */
fun VettyService.orderStep(rel: String): Pair<Int, String>? = steps()[rel]

/** Guided Review steps: Claude's order restricted to files in this review (out-of-diff and Untracked
 *  entries dropped), renumbered 1..n so the #s have no gaps. rel → (n, note). ponytail: recomputed
 *  per call — the order list is short. */
fun VettyService.steps(): Map<String, Pair<Int, String>> {
    if (!state.guidedReview) return emptyMap()
    val order = claudeReview()?.order ?: return emptyMap()
    val m = LinkedHashMap<String, Pair<Int, String>>()
    for ((rel, e) in order) if (rel in reviewRels && !isIgnored(rel)) m[rel] = (m.size + 1) to e.second
    return m
}

/** Publish Vetty's exact review set to <git-dir>/vetty/scope.json so a Claude session annotates what
 *  Vetty lists, not its own guess at the diff. Repo-root-relative paths; written only on change. */
internal fun VettyService.writeScope(files: List<VFile>) {
    val dir = gitDirCache ?: return
    val j = JsonObject().apply {
        addProperty("note", "Written by Vetty: the files it lists for review. Annotate only these.")
        addProperty("branch", curBranch)
        addProperty("base", state.base)
        addProperty("mergeBase", baseRef())
        addProperty("range", range())
        add("files", JsonArray().also { a ->
            files.filter { it.group != Group.UNTRACKED }.forEach { f ->
                a.add(JsonObject().apply { addProperty("file", prefixCache + f.rel); addProperty("status", f.status) })
            }
        })
    }
    val text = GsonBuilder().setPrettyPrinting().create().toJson(j) + "\n"
    if (text == lastScope) return
    try {
        java.io.File(dir, "vetty").mkdirs()
        java.io.File(dir, "vetty/scope.json").writeText(text)
        lastScope = text
    } catch (e: Exception) { VettyService.dbg { "scope write failed: ${e.message}" } }
}

/** Poll the review file — external writes under .git get no VFS event. ponytail: 1.5s stat, cheap. */
fun VettyService.startClaudeWatch() {
    cs.launch {
        var last: String? = null
        while (true) {
            delay(1500)
            val f = claudeFile() ?: continue
            val stamp = if (f.isFile) "${f.lastModified()}:${f.length()}" else ""
            if (last != null && stamp != last) {
                ApplicationManager.getApplication().invokeLater { onChange?.invoke() }
                if (stamp.isNotEmpty()) announceGuided()   // a (re)annotation is easy to miss with the toggle off
            }
            last = stamp
        }
    }
}

/** Toggle off → balloon with a "Turn on" action (silent for another branch's file); on → quiet status line. */
private fun VettyService.announceGuided() {
    val forBranch = claudeReviewFileBranch()
    val group = NotificationGroupManager.getInstance().getNotificationGroup("Vetty")
    if (!state.guidedReview) {
        if (forBranch.isNotEmpty() && forBranch != curBranch) return
        val n = group.createNotification("Guided review ready for ${forBranch.ifEmpty { "this branch" }}",
            NotificationType.INFORMATION)
        n.addAction(NotificationAction.createSimpleExpiring("Turn on") {
            toggleGuidedReview(); refreshUiAndGutters()
        })
        n.notify(project)
    } else {
        val r = claudeReview() ?: return
        val n = steps().size
        group.createNotification("Guided review updated: $n file${if (n == 1) "" else "s"}, ${r.comments.size} notes",
            NotificationType.INFORMATION).notify(project)
    }
}
