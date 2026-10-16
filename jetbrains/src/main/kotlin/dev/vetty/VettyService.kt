package dev.vetty

import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.application.EDT
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.project.Project
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import java.nio.charset.StandardCharsets

enum class Group { UNVIEWED, VIEWED, UNTRACKED }

data class VFile(val rel: String, val status: String, val add: Int, val del: Int, val group: Group,
                 val wsOnly: Boolean = false,   // whitespace-only change (set while the hide-whitespace toggle is on)
                 val stageMark: String = "",    // "*" staged, "^" staged but edited since, "" unstaged
                 val clean: Boolean = false,    // no uncommitted changes (committed) — Stage/&-Stage/Revert Changes are no-ops
                 val wtOnly: Boolean = false)   // branch range: not in the branch diff, only vs HEAD (committed, then undone)

data class Todo(val rel: String, val line: Int, val text: String)

/** Git orchestration + review-state logic. Shells `git` directly, like the VS Code extension. */
@Service(Service.Level.PROJECT)
class VettyService(internal val project: Project, internal val cs: CoroutineScope) {

    companion object {
        val TODO_RE = VettyParse.TODO_RE   // comment-leader / `LABEL:` only — see VettyParse

        // Churn hunting: enable via Help ▸ Diagnostic Tools ▸ Debug Log Settings → add `#dev.vetty`,
        // then watch idea.log for git spawn timings and load summaries.
        private val LOG = com.intellij.openapi.diagnostic.Logger.getInstance("#dev.vetty")
        fun dbg(msg: () -> String) { if (LOG.isDebugEnabled) LOG.debug(msg()) }
    }

    /** Set by the tool window so git/comment changes can refresh the tree (full reload). */
    var onChange: (() -> Unit)? = null

    /** Set by the tool window — fast in-process re-group on editor typing (no git, no full reload). */
    var onContentChange: (() -> Unit)? = null

    internal val state get() = project.service<VettyStateService>().getState()

    // Crash-durability: PersistentStateComponent only flushes .idea/vetty.xml on the platform's own
    // schedule (autosave / focus-loss / close), so a hard crash can drop marks made since the last
    // save. After a data change (viewed / ignored / comments) we force a save, debounced ~0.8s so a
    // bulk "view all" coalesces into one write. Worst-case loss on crash ≈ the last second, like
    // VS Code's prompt-async Memento writes.
    private var saveJob: kotlinx.coroutines.Job? = null
    internal fun scheduleSave() {
        saveJob?.cancel()
        saveJob = cs.launch {
            kotlinx.coroutines.delay(800)
            kotlinx.coroutines.withContext(Dispatchers.EDT) {
                @Suppress("DEPRECATION") project.save()   // serialize project components → .idea/vetty.xml
            }
        }
    }

    internal fun repoRoot(): String? = project.basePath

    internal val git = VettyGit { repoRoot() }

    /** Run [work] per item on the pooled executor and wait — parallel git spawns, not one-by-one. */
    internal fun <T, R> parMap(items: List<T>, work: (T) -> R): List<R> {
        val app = com.intellij.openapi.application.ApplicationManager.getApplication()
        return items.map { i -> app.executeOnPooledThread<R> { work(i) } }.map { it.get() }
    }

    /** git blob id of the file's CURRENT in-memory content (unsaved-aware), to compare against a snapshot blob. */
    private fun documentBlob(rel: String): String? {
        val vf = LocalFileSystem.getInstance().findFileByPath("${repoRoot()}/$rel") ?: return null
        val bytes = com.intellij.openapi.application.ReadAction.compute<ByteArray?, RuntimeException> {
            FileDocumentManager.getInstance().getDocument(vf)?.text?.toByteArray(Charsets.UTF_8)
        } ?: return null
        return git.withInput(bytes, "hash-object", "--stdin").trim().ifEmpty { null }
    }

    // --- view options -----------------------------------------------------------------------

    fun nested(): Boolean = state.nested
    fun toggleNested() { state.nested = !state.nested }
    fun hideWhitespace(): Boolean = state.hideWhitespace
    fun toggleHideWhitespace() { state.hideWhitespace = !state.hideWhitespace }
    fun stageOnView(): Boolean = state.stageOnView
    fun toggleStageOnView() { state.stageOnView = !state.stageOnView; scheduleSave() }
    fun welcomed(): Boolean = state.welcomed
    fun setWelcomed() { state.welcomed = true }

    // --- diff controls: two independent toggles ----------------------

    /** Range: "branch" (vs merge-base) or "commit" (uncommitted, vs HEAD). */
    fun range(): String = if (state.diffRange == "commit") "commit" else "branch"
    fun toggleRange() { state.diffRange = if (range() == "commit") "branch" else "commit" }
    fun isCommitRange() = range() == "commit"

    /** Overlay: diff unviewed files against their last-reviewed snapshot. */
    fun sinceReview(): Boolean = state.sinceReview
    fun toggleSinceReview() { state.sinceReview = !state.sinceReview }

    /** Compact status text, e.g. "range: whole branch · compare: last viewed". */
    fun diffStatus(): String {
        val r = if (isCommitRange()) "uncommitted" else "whole branch"
        return "range: $r · compare: ${if (sinceReview()) "last viewed" else "base"}${guidedSummary()}"
    }

    fun currentBranchName(): String? = curBranch

    private var baseRefCache: Pair<String, String>? = null  // base → merge-base ref; recomputed once per reload

    /** Merge-base of base…HEAD — the "whole branch" reference, like GitHub's files-changed (cached). */
    internal fun baseRef(): String? {
        val b = base() ?: return null
        baseRefCache?.let { if (it.first == b) return it.second }
        val mb = git("merge-base", b, "HEAD").trim()
        val ref = if (mb.isNotEmpty()) mb else b
        baseRefCache = b to ref
        return ref
    }

    /** The ref the file list diffs against: HEAD in commit range (uncommitted only), else the merge-base. */
    private fun listRef(): String? = if (isCommitRange()) "HEAD" else baseRef()

    /** The merge-base moved (base was rebased/merged into the branch) → fully unview marks whose file
     *  content changed: their since-review snapshots predate the rebase, so the overlay would present
     *  the BASE's incoming changes as reviewable work. Untouched files keep their marks. */
    private fun purgeOnMergeBaseChange() {
        val mb = baseRef() ?: return
        val br = curBranch ?: return
        val prev = state.mergeBaseByBranch[br]
        if (prev == mb) return
        if (prev != null) {
            val stale = state.viewed.keys.filter { it.substringBefore('\t') == br && !isViewed(it.substringAfter('\t')) }
            if (stale.isNotEmpty()) { state.viewed.keys.removeAll(stale.toSet()); scheduleSave() }
        }
        state.mergeBaseByBranch[br] = mb
        scheduleSave()
    }

    // Keyed by CURRENT BRANCH, not base: base-keyed marks were shared across sibling branches, so
    // marking on one clobbered the other's — and the since-review overlay then diffed against a
    // snapshot taken on the sibling. Falls back to base() before the first resolve.
    @Volatile internal var curBranch: String? = null
    internal fun key(rel: String) = "${curBranch ?: base()}\t$rel"

    // Base resolution (VettyBase.kt) session state: vetted "cur base" pairs, and whether stale marks were GC'd.
    internal val validatedBase = HashSet<String>()
    internal var pruned = false

    // Guided review (VettyGuided.kt) state: where Claude's review file lives (resolved off-EDT in load()),
    // the repo-root → project path prefix (--show-prefix), the parsed-review cache, the files in the
    // current review (set by load()), the last scope.json written, and commits since the review's HEAD.
    @Volatile internal var gitDirCache: String? = null
    @Volatile internal var prefixCache: String = ""
    internal var claudeKey: String? = null
    internal var claudeVal: VettyReviewFile.ClaudeReview? = null
    @Volatile internal var reviewRels: Set<String> = emptySet()
    internal var lastScope: String? = null
    @Volatile internal var guidedBehind: Int? = null

    /** rel of the most recently opened diff — fallback file when an editor's doc isn't a real file (unified diff). */
    internal var lastDiffRel: String? = null

    /** Branch range: files changed vs HEAD but not vs the merge-base (committed, then undone). Set by load(). */
    @Volatile internal var wtOnlySet: Set<String> = emptySet()

    /** Full changed-file model, grouped Unviewed / Viewed / Untracked(= user-marked noise). */
    fun load(): List<VFile> {
        val t0 = System.currentTimeMillis()
        baseRefCache = null   // recompute merge-base once per refresh (cheap reuse across diff clicks)
        resolveBase()         // per-branch base memory + ancestor inference; re-resolves on branch switch
        purgeOnMergeBaseChange()
        if (gitDirCache == null) {   // once: where Claude's review file lives + repo→project path prefix
            prefixCache = git("rev-parse", "--show-prefix").trim()
            gitDirCache = git("rev-parse", "--absolute-git-dir").trim().ifEmpty { null }
        }
        val ref = listRef() ?: return emptyList()
        // All five git reads are independent — run them concurrently (sequential spawns made every
        // refresh, and the stage markers with it, noticeably slow). --relative scopes to the opened
        // solution dir (cwd) and yields cwd-relative paths.
        val outs = parMap(listOf(
            listOf("diff", "--relative", "--numstat", ref),
            listOf("diff", "--relative", "--name-status", ref),
            listOf("ls-files", "--others", "--exclude-standard"),
            // Staged markers: `*` = in the index, `^` = staged but edited since (index ≠ working tree).
            listOf("diff", "--relative", "--cached", "--name-only"),
            listOf("diff", "--relative", "--name-only"),
            // Whitespace-only modified files: present in the full diff but absent from `git diff -w`.
            // Use -w --numstat, NOT --name-only: `--name-only -w` still LISTS trailing-whitespace /
            // final-newline / CRLF-only files, but --numstat emits no row for them. Binary files
            // (`-\t-\tpath`) stay "real" so hide-whitespace never swallows an image. Toggle-gated.
            if (state.hideWhitespace) listOf("diff", "--relative", "-w", "--numstat", ref) else null,
        ).filterNotNull()) { git(*it.toTypedArray()) }
        val nums = VettyParse.parseNumstat(outs[0])
        val untrackedList = outs[2].split("\n").map { it.trim() }.filter { it.isNotEmpty() }
        val stagedSet = outs[3].split("\n").map { it.trim() }.filter { it.isNotEmpty() }.toHashSet()
        val dirtySet = outs[4].split("\n").map { it.trim() }.filter { it.isNotEmpty() }.toHashSet()
        val real = if (state.hideWhitespace)
            outs[5].split("\n").mapNotNull { it.split("\t").getOrNull(2)?.trim()?.ifEmpty { null } }.toHashSet()
        else null
        fun mark(rel: String) = if (rel in stagedSet) (if (rel in dirtySet) "^" else "*") else ""
        val nameStatus = VettyParse.parseNameStatus(outs[1])
        // Branch range: a change committed and then undone in the working tree nets to zero vs the
        // merge-base, so the branch diff drops the file — while the commit pane still lists it (it
        // differs from HEAD). List those too, flagged uncommitted-only; their diff opens vs HEAD.
        val inBranch = nameStatus.mapTo(HashSet()) { it.second }.apply { addAll(untrackedList) }
        val wtCands = if (isCommitRange()) emptySet() else (stagedSet + dirtySet).filterTo(HashSet()) { it !in inBranch }
        val headNs = if (wtCands.isEmpty()) emptyList()
            else VettyParse.parseNameStatus(git("diff", "--relative", "--name-status", "HEAD")).filter { it.second in wtCands }
        val headNums = if (headNs.isEmpty()) emptyMap() else VettyParse.parseNumstat(git("diff", "--relative", "--numstat", "HEAD"))
        wtOnlySet = headNs.mapTo(HashSet()) { it.second }
        // Stage-on-view sync: staging outside vetty (commit pane) counts as a review too. Only
        // clean staged files (index == working tree) qualify — a stale-staged file's working
        // copy holds unreviewed edits.
        if (state.stageOnView) {
            for (rel in stagedSet) if (rel !in dirtySet && !isViewed(rel) && !isIgnored(rel)) markViewed(rel)
            // Commit self-heal: format-on-commit hooks (lint-staged etc.) rewrite reviewed files during
            // the commit, so their hash-bound marks go stale even though the new content is exactly what
            // got committed. Commit ⊇ staging ⇒ view: a file that ALREADY holds a mark and is now clean
            // vs HEAD re-heals instead of dropping to Unviewed. Never creates marks.
            for ((status, rel) in nameStatus)
                if (status != "D" && rel !in stagedSet && rel !in dirtySet &&
                    state.viewed.containsKey(key(rel)) && !isViewed(rel) && !isIgnored(rel)) markViewed(rel)
        }
        val files = ArrayList<VFile>()
        val seen = HashSet<String>()
        for ((status, rel) in nameStatus) {
            seen.add(rel)
            val (add, del) = nums[rel] ?: (0 to 0)
            files.add(VFile(rel, status, add, del, groupFor(rel),
                wsOnly = real != null && status != "U" && rel !in real, stageMark = mark(rel),
                clean = status != "U" && rel !in stagedSet && rel !in dirtySet))
        }
        for ((status, rel) in headNs) {
            seen.add(rel)
            val (add, del) = headNums[rel] ?: (0 to 0)
            files.add(VFile(rel, status, add, del, groupFor(rel), stageMark = mark(rel), wtOnly = true))
        }
        // Git-untracked NEW files are regular changes (status "U"); only user-untracked files go to Untracked.
        for (rel in untrackedList) {
            if (rel in seen) continue
            files.add(VFile(rel, "U", untrackedLineCount(rel), 0, groupFor(rel)))
        }
        dbg { "load done — ${System.currentTimeMillis() - t0}ms, ${files.size} files (base ${state.base})" }
        val result = files.sortedBy { it.rel }
        reviewRels = result.filter { it.group != Group.UNTRACKED }.mapTo(HashSet()) { it.rel }
        writeScope(result)
        refreshGuidedBehind()
        return result
    }

    // Line counts for untracked files (absent from `git diff --numstat`), cached by (mtime, size) so
    // refreshes don't re-read every untracked file. 0 = huge/binary/unreadable (renderer hides 0/0).
    private val lineCountCache = java.util.concurrent.ConcurrentHashMap<String, Pair<Long, Int>>()
    private fun untrackedLineCount(rel: String): Int {
        val root = repoRoot() ?: return 0
        return try {
            val f = java.io.File(root, rel)
            val stamp = f.lastModified() xor f.length()
            lineCountCache[rel]?.let { (s, n) -> if (s == stamp) return n }
            var n = 0
            if (f.length() in 1..(1024 * 1024)) {
                val b = f.readBytes()
                if (!b.contains(0)) {
                    n = b.count { it == '\n'.code.toByte() }
                    if (b.last() != '\n'.code.toByte()) n++   // last line without trailing newline
                }
            }
            lineCountCache[rel] = stamp to n
            n
        } catch (e: Exception) { 0 }
    }

    fun groupFor(rel: String): Group = when {
        isIgnored(rel) -> Group.UNTRACKED       // user marked it noise
        isViewed(rel) -> Group.VIEWED
        else -> Group.UNVIEWED
    }

    // --- track / untrack (noise files) ------------------------------------------------------

    fun isIgnored(rel: String): Boolean = state.ignored.contains(key(rel)) || ignoredByGlob(rel)
    fun untrack(rel: String) { if (base() != null && !isIgnored(rel)) { state.ignored.add(key(rel)); scheduleSave() } }   // push to Untracked/noise
    fun track(rel: String) {   // bring back
        if (state.ignored.remove(key(rel))) scheduleSave()
        if (ignoredByGlob(rel)) com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
            com.intellij.openapi.ui.Messages.showInfoMessage(
                project, "\"$rel\" matches a Vetty ignore pattern — edit Ignore Patterns (toolbar) to track it.", "Vetty")
        }
    }

    // Ignore patterns: settings-level globs — matches land in Untracked (a layer on top of .gitignore).
    // `**` crosses slashes, `*`/`?` don't; a pattern with `/` anchors to the repo-relative path,
    // without one it matches any path segment. Compiled regexes cached until the pattern list changes.
    @Volatile private var ignoreRegexCache: Pair<List<String>, List<Regex>>? = null
    fun ignoredByGlob(rel: String): Boolean {
        val pats = state.ignoreGlobs.mapNotNull { p -> p.trim().ifEmpty { null } }
        if (pats.isEmpty()) return false
        val cached = ignoreRegexCache
        val rx = if (cached != null && cached.first == pats) cached.second else pats.mapNotNull { p ->
            val ds = 1.toChar().toString()   // placeholder so `**` survives the `*` rewrite
            val src = p.replace(Regex("[.+^\${}()|\\[\\]\\\\]")) { "\\" + it.value }
                .replace("**", ds).replace("*", "[^/]*").replace("?", "[^/]").replace(ds, ".*")
            try { Regex(if ('/' in p) "^$src\$" else "(^|/)$src(/|\$)") } catch (e: Exception) { null }
        }.also { ignoreRegexCache = pats to it }
        return rx.any { it.containsMatchIn(rel) }
    }

    fun ignoreGlobs(): List<String> = state.ignoreGlobs
    fun setIgnoreGlobs(globs: List<String>) {
        state.ignoreGlobs = globs.mapNotNull { g -> g.trim().ifEmpty { null } }.toMutableList()
        ignoreRegexCache = null
        scheduleSave()
    }

    private fun untracked(): List<String> =
        git("ls-files", "--others", "--exclude-standard").split("\n").map { it.trim() }.filter { it.isNotEmpty() }

    // --- viewed state -----------------------------------------------------------------------

    /**
     * In-process content hash — fast viewed-check with no git process per file.
     * Always hashes the in-memory document (LF) for text files so mark-viewed and the check use the SAME
     * source — otherwise a doc-vs-disk (LF/CRLF) mismatch means a reverted file never re-counts as viewed.
     * Also catches unsaved edits → re-flags instantly.
     */
    // Hash memoized by content stamp (doc modificationStamp catches unsaved edits; VFS stamp otherwise).
    // Without this every reload AND every 60ms typing regroup re-reads + re-SHA1s each marked file.
    private val hashCache = java.util.concurrent.ConcurrentHashMap<String, Pair<Long, String>>()

    private fun sha1(bytes: ByteArray) =
        java.security.MessageDigest.getInstance("SHA-1").digest(bytes).joinToString("") { "%02x".format(it) }

    /** EOL-normalize (CRLF/CR → LF) so autocrlf checkout round-trips don't flip the hash. The Document
     *  path is already LF; this makes the docless/disk fallbacks agree with it. */
    private fun sha1Normalized(bytes: ByteArray) = sha1(VettyParse.eolNormalize(bytes))

    private fun fileHash(rel: String): String? {
        val root = repoRoot() ?: return null
        val k = key(rel)
        return try {
            val vf = LocalFileSystem.getInstance().findFileByPath("$root/$rel")
            if (vf != null) {
                com.intellij.openapi.application.ReadAction.compute<String, RuntimeException> {
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
    // Fallback verdicts memoized by content hash: without this, every regroup/reload re-spawns a
    // `git hash-object` process per edited-since-viewed file (worst case: while typing, on the EDT).
    private val blobCheck = HashMap<String, Pair<String, Boolean>>()  // key(rel) → (contentHash, verdict)

    fun isViewed(rel: String): Boolean {
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

    internal fun reviewedBlob(rel: String): String? =
        state.viewed[key(rel)]?.substringAfter('\t', "")?.ifEmpty { null }

    /** True when [rel] has a usable since-last-review snapshot (overlay on + blob present + changed since). */
    fun hasSinceReviewDiff(rel: String): Boolean = sinceReview() && reviewedBlob(rel) != null && !isViewed(rel)

    /** True when [rel] has a last-viewed snapshot blob (gates the Revert-to-Last-Viewed button). */
    fun hasSnapshot(rel: String): Boolean = reviewedBlob(rel) != null

    fun markViewed(rel: String) {
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
    private fun notifyNotStaged(rel: String) =
        com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
            com.intellij.openapi.wm.WindowManager.getInstance().getStatusBar(project)?.info =
                "Vetty: ${rel.substringAfterLast('/')} viewed but NOT staged — open comments (💬)"
        }

    fun unmarkViewed(rel: String) {
        if (state.viewed.remove(key(rel)) != null) scheduleSave()
        blobCheck.remove(key(rel))
        if (state.stageOnView) git("restore", "--staged", "--", rel)   // symmetric: unview ⇒ unstage
    }

    /** Stage the file's current content (right-click Stage — no viewed-mark side effects). */
    fun stageFile(rel: String) { git("add", "--", rel) }

    /** Take the file out of the index (right-click Unstage — no viewed-mark side effects). */
    fun unstageFile(rel: String) { git("restore", "--staged", "--", rel) }

    /** Discard a file's changes — restore to HEAD; untracked files are deleted. Caller confirms first. */
    fun revertFile(rel: String) {
        val root = repoRoot() ?: return
        val f = java.io.File(root, rel)
        val tracked = git("ls-files", "--", rel).trim().isNotEmpty()
        if (tracked) git("restore", "--source=HEAD", "--staged", "--worktree", "--", rel)
        else if (f.exists()) f.delete()
    }

    /** Restore [rel] to its last-viewed snapshot. The restored content hashes back to the mark, so
     *  the file flips back to Viewed automatically. Returns false when no snapshot exists. */
    fun revertToLastViewed(rel: String): Boolean {
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

    fun toggleViewed(rel: String) { if (isViewed(rel)) unmarkViewed(rel) else markViewed(rel) }

    /** The last file/diff opened by a single-click, so the next click can replace it (preview-tab feel). */
    internal var lastPreview: VirtualFile? = null

    // Added/untracked files preview as a plain file tab (above); modified files preview in the diff
    // preview tab (VettyDiffPreview). Those are two separate surfaces, so switching between an added
    // and a modified file left BOTH open. The tool window wires this to close the diff preview when a
    // file preview opens; openFilePreview→file and diffPreview→file close each other for one preview.
    var closeDiffPreview: (() -> Unit)? = null

    // --- TODO scanner -----------------------------------------------------------------------

    /** TODO/FIXME markers on added diff lines vs the active ref + every line of untracked files. */
    fun todos(): List<Todo> {
        val ref = listRef() ?: return emptyList()
        val list = VettyParse.parseTodoHunks(git("diff", "--relative", "-U0", "--diff-filter=d", ref), TODO_RE)
            .map { Todo(it.first, it.second, it.third) }
            .toMutableList()
        for (u in untracked()) {
            val vf = vfile(u) ?: continue
            if (vf.length > 1024 * 1024) continue   // huge file — not review material, skip the read
            try {
                val text = String(vf.contentsToByteArray(), StandardCharsets.UTF_8)
                if ('\u0000' in text) continue   // binary
                text.split("\n").forEachIndexed { i, l ->
                    if (TODO_RE.containsMatchIn(l)) list.add(Todo(u, i + 1, l.trim()))
                }
            } catch (e: Exception) { /* unreadable — skip */ }
        }
        return list
    }

    /** Re-paint gutter icons in all open editors and refresh the tool window. */
    fun refreshUiAndGutters() {
        scheduleSave()   // catches comment body edits + line-drift persistence that don't go through add/delete
        VettyGutter.redecorateAll(project)
        onChange?.invoke()
    }
}
