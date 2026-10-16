package dev.vetty

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.wm.WindowManager

/** Viewed marks: content hashing, mark / unmark (with stage-on-view), stage / unstage / revert. Extension functions on VettyService. */

private fun sha1(bytes: ByteArray) =
    java.security.MessageDigest.getInstance("SHA-1").digest(bytes).joinToString("") { "%02x".format(it) }

/** EOL-normalize (CRLF/CR → LF) so autocrlf checkout round-trips don't flip the hash. The Document
 *  path is already LF; this makes the docless/disk fallbacks agree with it. */
private fun sha1Normalized(bytes: ByteArray) = sha1(VettyParse.eolNormalize(bytes))

/**
 * In-process content hash — fast viewed-check with no git process per file.
 * Always hashes the in-memory document (LF) for text files so mark-viewed and the check use the SAME
 * source — otherwise a doc-vs-disk (LF/CRLF) mismatch means a reverted file never re-counts as viewed.
 * Also catches unsaved edits → re-flags instantly.
 */
private fun VettyService.fileHash(rel: String): String? {
    val root = repoRoot() ?: return null
    val k = key(rel)
    return try {
        val vf = LocalFileSystem.getInstance().findFileByPath("$root/$rel")
        if (vf != null) {
            ReadAction.compute<String, RuntimeException> {
                val doc = FileDocumentManager.getInstance().getDocument(vf)
                val stamp = doc?.modificationStamp ?: (vf.timeStamp xor vf.length)
                hashCache[k]?.let { (s, h) -> if (s == stamp) return@compute h }
                val h = doc?.text?.toByteArray(Charsets.UTF_8)?.let { sha1(it) }   // doc text is already LF
                    ?: sha1Normalized(vf.contentsToByteArray())
                hashCache[k] = stamp to h
                h
            }
        } else {
            val f = java.io.File(root, rel)
            val stamp = f.lastModified() xor f.length()
            hashCache[k]?.let { (s, h) -> if (s == stamp) return h }
            val h = sha1Normalized(f.readBytes())
            hashCache[k] = stamp to h
            h
        }
    } catch (e: Exception) { null }
}

/**
 * Stored value is "contentHash\tblobId". Viewed = the file's CURRENT content (in-memory document,
 * so unsaved edits count) still hashes to what it was when marked viewed. Typing re-flags it unviewed
 * instantly; reverting back re-views it. No git, no disk read — keeps it fast and edit-accurate.
 */
fun VettyService.isViewed(rel: String): Boolean {
    val entry = state.viewed[key(rel)] ?: return false
    val storedHash = entry.substringBefore('\t')
    if (storedHash == "D") {   // deletion tombstone: viewed while the file is still gone
        val root = repoRoot() ?: return false
        return !java.io.File(root, rel).exists()
    }
    val cur = fileHash(rel)
    if (storedHash.isNotEmpty() && cur != null && storedHash == cur) return true   // fast path
    // Fallback: does the current (in-memory) content git-hash to the stored snapshot blob?
    // Exact + unsaved-aware; covers marks whose fast-hash drifted across plugin builds.
    val blob = entry.substringAfter('\t', "").ifEmpty { return false }
    blobCheck[key(rel)]?.let { (h, ok) -> if (cur != null && h == cur) return ok }
    val ok = documentBlob(rel) == blob
    if (cur != null) blobCheck[key(rel)] = cur to ok
    if (ok && cur != null) state.viewed[key(rel)] = "$cur\t$blob"   // self-heal so the fast path hits next time
    return ok
}

internal fun VettyService.reviewedBlob(rel: String): String? =
    state.viewed[key(rel)]?.substringAfter('\t', "")?.ifEmpty { null }

/** True when [rel] has a usable since-last-review snapshot (overlay on + blob present + changed since). */
fun VettyService.hasSinceReviewDiff(rel: String): Boolean = sinceReview() && reviewedBlob(rel) != null && !isViewed(rel)

/** True when [rel] has a last-viewed snapshot blob (gates the Revert-to-Last-Viewed button). */
fun VettyService.hasSnapshot(rel: String): Boolean = reviewedBlob(rel) != null

fun VettyService.markViewed(rel: String) {
    if (base() == null) return   // no base yet → key would be "null\t…" garbage in vetty.xml
    val root = repoRoot()
    if (root != null && !java.io.File(root, rel).exists()) {
        // Deletion tombstone ('D' — not a valid sha1): viewed while the file stays gone,
        // re-flags unviewed if it comes back.
        state.viewed[key(rel)] = "D\t"; scheduleSave(); blobCheck.remove(key(rel))
        if (state.stageOnView) {
            if (commentsFor(rel).isEmpty()) git("add", "--", rel)   // stages the deletion too
            else notifyNotStaged(rel)
        }
        return
    }
    val blob = git("hash-object", "-w", "--", rel).trim()   // snapshot blob for the since-review diff
    val h = fileHash(rel) ?: ""
    if (h.isNotEmpty() || blob.isNotEmpty()) { state.viewed[key(rel)] = "$h\t$blob"; scheduleSave() }
    blobCheck.remove(key(rel))
    // Opt-in: reviewed ⇒ staged — but a file with open comments is "changes requested", so it
    // stays unstaged (staged = viewed ∧ no open comments). All markViewed callers already run
    // off the EDT, so the extra git spawn is safe here.
    if (state.stageOnView) {
        if (commentsFor(rel).isEmpty()) git("add", "--", rel)
        else notifyNotStaged(rel)
    }
}

/** Stage-on-view skipped a commented file — say so, or the missing `*` reads as a bug. */
private fun VettyService.notifyNotStaged(rel: String) =
    ApplicationManager.getApplication().invokeLater {
        WindowManager.getInstance().getStatusBar(project)?.info =
            "Vetty: ${rel.substringAfterLast('/')} viewed but NOT staged — open comments (💬)"
    }

fun VettyService.unmarkViewed(rel: String) {
    if (state.viewed.remove(key(rel)) != null) scheduleSave()
    blobCheck.remove(key(rel))
    if (state.stageOnView) git("restore", "--staged", "--", rel)   // symmetric: unview ⇒ unstage
}

/** Stage the file's current content (right-click Stage — no viewed-mark side effects). */
fun VettyService.stageFile(rel: String) { git("add", "--", rel) }

/** Take the file out of the index (right-click Unstage — no viewed-mark side effects). */
fun VettyService.unstageFile(rel: String) { git("restore", "--staged", "--", rel) }

/** Discard a file's changes — restore to HEAD; untracked files are deleted. Caller confirms first. */
fun VettyService.revertFile(rel: String) {
    val root = repoRoot() ?: return
    val f = java.io.File(root, rel)
    val tracked = git("ls-files", "--", rel).trim().isNotEmpty()
    if (tracked) git("restore", "--source=HEAD", "--staged", "--worktree", "--", rel)
    else if (f.exists()) f.delete()
}

/** Restore [rel] to its last-viewed snapshot. The restored content hashes back to the mark, so
 *  the file flips back to Viewed automatically. Returns false when no snapshot exists. */
fun VettyService.revertToLastViewed(rel: String): Boolean {
    val blob = reviewedBlob(rel) ?: return false
    val root = repoRoot() ?: return false
    val bytes = git.blobBytes(blob) ?: return false
    java.io.File(root, rel).writeBytes(bytes)
    // Sync the index: a staged copy of the pre-revert content would keep the commit pane
    // showing phantom changes after the restore.
    if (state.stageOnView || git("diff", "--relative", "--cached", "--name-only", "--", rel).trim().isNotEmpty())
        git("add", "--", rel)
    LocalFileSystem.getInstance().refreshAndFindFileByPath("$root/$rel")?.refresh(false, false)
    return true
}

fun VettyService.toggleViewed(rel: String) { if (isViewed(rel)) unmarkViewed(rel) else markViewed(rel) }

/** git blob id of the file's CURRENT in-memory content (unsaved-aware), to compare against a snapshot blob. */
private fun VettyService.documentBlob(rel: String): String? {
    val vf = LocalFileSystem.getInstance().findFileByPath("${repoRoot()}/$rel") ?: return null
    val bytes = ReadAction.compute<ByteArray?, RuntimeException> {
        FileDocumentManager.getInstance().getDocument(vf)?.text?.toByteArray(Charsets.UTF_8)
    } ?: return null
    return git.withInput(bytes, "hash-object", "--stdin").trim().ifEmpty { null }
}
