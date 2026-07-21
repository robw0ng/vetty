package dev.vetty

import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffManager
import com.intellij.diff.chains.SimpleDiffRequestChain
import com.intellij.diff.editor.ChainDiffVirtualFile
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.diff.util.DiffUserDataKeysEx
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.ToggleAction
import com.intellij.execution.util.ExecUtil
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.fileEditor.ex.FileEditorManagerEx
import com.intellij.openapi.fileEditor.impl.FileEditorOpenOptions
import com.intellij.openapi.application.EDT
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileTypes.FileTypeManager
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
                 val stageMark: String = "")    // "*" staged, "^" staged but edited since, "" unstaged

data class Todo(val rel: String, val line: Int, val text: String)

/** Git orchestration + review-state logic. Shells `git` directly, like the VS Code extension. */
@Service(Service.Level.PROJECT)
class VettyService(private val project: Project, private val cs: CoroutineScope) {

    companion object {
        val TODO_RE = Regex("""\b(TODO|FIXME|HACK|XXX|BUG|NOTE|OPTIMIZE|REVIEW|WIP|TEMP|REFACTOR|DEPRECATED)\b""")
        val TRUNKS = listOf("main", "master", "develop", "dev", "trunk")
        const val PARENT_MAX_AHEAD = 500   // beyond this an "ancestor" is an old merged branch, not a base
    }

    /** Set by the tool window so git/comment changes can refresh the tree (full reload). */
    var onChange: (() -> Unit)? = null

    /** Set by the tool window — fast in-process re-group on editor typing (no git, no full reload). */
    var onContentChange: (() -> Unit)? = null

    private val state get() = project.service<VettyStateService>().getState()

    // Crash-durability: PersistentStateComponent only flushes .idea/vetty.xml on the platform's own
    // schedule (autosave / focus-loss / close), so a hard crash can drop marks made since the last
    // save. After a data change (viewed / ignored / comments) we force a save, debounced ~0.8s so a
    // bulk "view all" coalesces into one write. Worst-case loss on crash ≈ the last second, like
    // VS Code's prompt-async Memento writes.
    private var saveJob: kotlinx.coroutines.Job? = null
    private fun scheduleSave() {
        saveJob?.cancel()
        saveJob = cs.launch {
            kotlinx.coroutines.delay(800)
            kotlinx.coroutines.withContext(Dispatchers.EDT) {
                @Suppress("DEPRECATION") project.save()   // serialize project components → .idea/vetty.xml
            }
        }
    }

    private fun repoRoot(): String? = project.basePath

    /** Run git in the repo root; returns stdout, or "" on any failure (caller-tolerant). */
    private fun git(vararg args: String): String {
        val root = repoRoot() ?: return ""
        // core.quotePath=false → paths with spaces/unicode come out raw (not "\303\266…"), so they resolve.
        val cmd = GeneralCommandLine(mutableListOf("git", "-c", "core.quotePath=false", *args))
            .withWorkDirectory(root)
            .withCharset(StandardCharsets.UTF_8)
        return try {
            val out = ExecUtil.execAndGetOutput(cmd)
            if (out.exitCode == 0) out.stdout else ""
        } catch (e: Exception) {
            ""
        }
    }

    /** Run git feeding [input] on stdin; returns stdout ("" on failure). Used for hash-object --stdin. */
    private fun gitInput(input: ByteArray, vararg args: String): String {
        val root = repoRoot() ?: return ""
        return try {
            // Discard stderr so a chatty git can't fill the pipe and deadlock the read below.
            val p = ProcessBuilder(listOf("git", *args))
                .directory(java.io.File(root))
                .redirectError(ProcessBuilder.Redirect.DISCARD)
                .start()
            p.outputStream.use { it.write(input) }
            val out = p.inputStream.readBytes().toString(Charsets.UTF_8)
            if (p.waitFor() == 0) out else ""
        } catch (e: Exception) { "" }
    }

    /** git blob id of the file's CURRENT in-memory content (unsaved-aware), to compare against a snapshot blob. */
    private fun documentBlob(rel: String): String? {
        val vf = LocalFileSystem.getInstance().findFileByPath("${repoRoot()}/$rel") ?: return null
        val bytes = com.intellij.openapi.application.ReadAction.compute<ByteArray?, RuntimeException> {
            FileDocumentManager.getInstance().getDocument(vf)?.text?.toByteArray(Charsets.UTF_8)
        } ?: return null
        return gitInput(bytes, "hash-object", "--stdin").trim().ifEmpty { null }
    }

    fun branches(): List<String> =
        git("for-each-ref", "--format=%(refname:short)", "refs/heads")
            .split("\n").map { it.trim() }.filter { it.isNotEmpty() }

    /** Resolved base for the current branch (mirror). Resolved on every load; resolve lazily if unset. */
    fun base(): String? {
        if (state.base == null) resolveBase()
        return state.base
    }

    /** Manual pick → remember it for the current branch. */
    fun setBase(b: String) {
        currentBranch()?.let { state.baseByBranch[it] = b }
        state.base = b
        scheduleSave()
    }

    /**
     * Per-branch base resolution. Runs on every load so a branch switch
     * restores that branch's base; an unset branch infers its closest ancestor. Never clobbers a manual pick.
     */
    private val validatedBase = HashSet<String>()  // "cur base" pairs already vetted this session

    private fun resolveBase() {
        val cur = currentBranch() ?: return
        curBranch = cur   // viewed/ignored keys hang off this
        if (!pruned) { pruned = true; pruneStale(branches()) }   // GC once per project open
        var b = state.baseByBranch[cur]
        // Validate a remembered LOCAL base once per session — the re-checks are 2 git spawns per reload.
        if (b != null && b != cur && !b.startsWith("origin/") && "$cur $b" !in validatedBase) {
            // Drop a remembered LOCAL base that's deleted, or absurdly far ahead (old merged branch from the prior bug).
            if (b !in branches()) b = null
            else aheadBehind(b)?.let { if (it.second > PARENT_MAX_AHEAD) b = null }
            if (b != null) validatedBase.add("$cur $b")
        }
        if (b == null) b = inferClosestAncestor(cur)
        state.baseByBranch[cur] = b
        state.base = b
    }

    /** Run [work] per item on the pooled executor and wait — parallel git spawns, not one-by-one. */
    private fun <T, R> parMap(items: List<T>, work: (T) -> R): List<R> {
        val app = com.intellij.openapi.application.ApplicationManager.getApplication()
        return items.map { i -> app.executeOnPooledThread<R> { work(i) } }.map { it.get() }
    }

    // GC: viewed/ignored entries and baseByBranch keys otherwise accumulate forever in vetty.xml as
    // branches are deleted. Drop entries whose branch no longer exists locally — this also gradually
    // clears legacy base-keyed entries (origin/* etc.).
    private var pruned = false
    private fun pruneStale(known: List<String>) {
        state.viewed.keys.removeAll { it.substringBefore('\t') !in known }
        state.ignored.removeAll { it.substringBefore('\t') !in known }
        state.baseByBranch.keys.removeAll { it !in known }
        state.mergeBaseByBranch.keys.removeAll { it !in known }
        state.comments.removeAll { it.branch !in known }   // also drops legacy branch="" comments once
    }

    /** When another branch's tip EQUALS this one's (fresh stacked branch, no commits yet), commit
     *  topology is symmetric — parent and child look identical. The reflog breaks the tie: its oldest
     *  entry is the branch's creation moment, and the branch created EARLIER is the parent. */
    private fun branchCreatedAt(branch: String): Long =
        // %gd + --date=unix = the reflog ENTRY time (%ct would be the commit time — identical for
        // same-tip branches, useless as a tie-break). Oldest entry = branch creation.
        git("reflog", "show", "--date=unix", "--format=%gd", branch).trim().split("\n")
            .lastOrNull { it.isNotBlank() }
            ?.let { Regex("""@\{(\d+)\}""").find(it)?.groupValues?.get(1)?.toLongOrNull() }
            ?: Long.MAX_VALUE   // no reflog → can't claim parenthood

    /** Same-tip parent → closest ancestor → conventional local → most-recent other local → current branch. */
    private fun inferClosestAncestor(cur: String): String {
        if (cur in TRUNKS) return cur   // a trunk has no parent; every merged branch is an "ancestor" → diff working changes
        val others = branches().filter { it != cur }
        var best: String? = null; var bestAhead = Int.MAX_VALUE
        val sameTip = ArrayList<String>()
        for ((b, ab) in parMap(others.take(50)) { it to aheadBehind(it) }) {   // parallel — 50 sequential spawns stall the load
            val (behind, ahead) = ab ?: continue
            if (behind == 0 && ahead == 0) sameTip.add(b)
            else if (behind == 0 && ahead in 1..PARENT_MAX_AHEAD && ahead < bestAhead) { best = b; bestAhead = ahead }
        }
        // Same-tip branch created before this one = the direct parent (this branch has no commits yet).
        if (sameTip.isNotEmpty()) {
            val curBorn = branchCreatedAt(cur)
            sameTip.map { it to branchCreatedAt(it) }
                .filter { it.second < curBorn }
                .maxByOrNull { it.second }?.let { return it.first }
        }
        if (best != null) return best
        for (c in TRUNKS) if (c in others) return c
        recentBranch(others)?.let { return it }
        return cur   // diff against self = uncommitted working changes only
    }

    private fun recentBranch(others: List<String>): String? =
        git("for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads")
            .split("\n").map { it.trim() }.firstOrNull { it in others }

    // --- branch ancestry (base picker) ------------------------------------------------------

    data class BranchItem(val branch: String, val label: String, val rank: Int, val ahead: Int)

    fun currentBranch(): String? = git("rev-parse", "--abbrev-ref", "HEAD").trim().ifEmpty { null }

    private fun aheadBehind(branch: String): Pair<Int, Int>? =
        VettyParse.parseAheadBehind(git("rev-list", "--left-right", "--count", "$branch...HEAD"))

    /** Local branches labeled by relation to HEAD: parent / ancestor / descendant / diverged, parent first. */
    fun rankedBranches(): List<BranchItem> {
        val cur = currentBranch()
        val others = branches().filter { it != cur }.take(50)
        val rels = parMap(others) { it to aheadBehind(it) }.toMap()   // parallel — picker opens in ~1 spawn, not 50
        // Same-tip tie-break (fresh stacked branch): created-earlier = parent, created-later = fresh child.
        val curBorn = if (cur != null && rels.values.any { it != null && it.first == 0 && it.second == 0 })
            branchCreatedAt(cur) else null
        val items = others.map { b ->
            val ab = rels[b]
            var label = ""; var rank = 5; var ahead = Int.MAX_VALUE
            if (ab != null) {
                val (behind, a) = ab; ahead = a
                when {
                    behind == 0 && a == 0 ->
                        if (curBorn != null && branchCreatedAt(b) < curBorn) { label = "parent · same commit"; rank = 0; ahead = 0 }
                        else { label = "same commit"; rank = 4 }
                    behind == 0 && a > 0 -> { label = "ancestor · $a ahead"; rank = 1 }
                    a == 0 && behind > 0 -> { label = "descendant · $behind behind"; rank = 4 }
                    a > 0 && behind > 0 -> { label = "↑$a ↓$behind"; rank = 3 }
                    else -> { label = "up to date"; rank = 2 }
                }
            }
            BranchItem(b, label, rank, ahead)
        }.toMutableList()
        // Direct parent = nearest ancestor (fewest commits ahead) — only within the cap; else leave it
        // "ancestor". A same-commit parent (rank 0 above) is closer than any strict ancestor → no promotion.
        if (items.none { it.rank == 0 }) items.filter { it.rank == 1 }.minByOrNull { it.ahead }?.let { p ->
            if (p.ahead <= PARENT_MAX_AHEAD) items[items.indexOf(p)] = p.copy(label = "parent · ${p.ahead} ahead", rank = 0)
        }
        items.sortWith(compareBy({ it.rank }, { it.ahead }))
        if (cur != null) items.add(BranchItem(cur, "current · working changes", 99, Int.MAX_VALUE))
        state.base?.let { last -> val i = items.indexOfFirst { it.branch == last }; if (i > 0) items.add(0, items.removeAt(i)) }
        return items
    }

    // --- view options -----------------------------------------------------------------------

    fun nested(): Boolean = state.nested
    fun toggleNested() { state.nested = !state.nested }
    fun hideWhitespace(): Boolean = state.hideWhitespace
    fun toggleHideWhitespace() { state.hideWhitespace = !state.hideWhitespace }
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
        return "range: $r · compare: ${if (sinceReview()) "last viewed" else "base"}"
    }

    private var baseRefCache: Pair<String, String>? = null  // base → merge-base ref; recomputed once per reload

    /** Merge-base of base…HEAD — the "whole branch" reference, like GitHub's files-changed (cached). */
    private fun baseRef(): String? {
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
    @Volatile private var curBranch: String? = null
    private fun key(rel: String) = "${curBranch ?: base()}\t$rel"

    /** Full changed-file model, grouped Unviewed / Viewed / Untracked(= user-marked noise). */
    fun load(): List<VFile> {
        baseRefCache = null   // recompute merge-base once per refresh (cheap reuse across diff clicks)
        resolveBase()         // per-branch base memory + ancestor inference; re-resolves on branch switch
        purgeOnMergeBaseChange()
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
        val files = ArrayList<VFile>()
        val seen = HashSet<String>()
        for ((status, rel) in VettyParse.parseNameStatus(outs[1])) {
            seen.add(rel)
            val (add, del) = nums[rel] ?: (0 to 0)
            files.add(VFile(rel, status, add, del, groupFor(rel),
                wsOnly = real != null && status != "U" && rel !in real, stageMark = mark(rel)))
        }
        // Git-untracked NEW files are regular changes (status "U"); only user-untracked files go to Untracked.
        for (rel in untrackedList) {
            if (rel in seen) continue
            files.add(VFile(rel, "U", untrackedLineCount(rel), 0, groupFor(rel)))
        }
        return files.sortedBy { it.rel }
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

    fun isIgnored(rel: String): Boolean = state.ignored.contains(key(rel))
    fun untrack(rel: String) { if (base() != null && !isIgnored(rel)) { state.ignored.add(key(rel)); scheduleSave() } }   // push to Untracked/noise
    fun track(rel: String) { if (state.ignored.remove(key(rel))) scheduleSave() }   // bring back

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

    private fun reviewedBlob(rel: String): String? =
        state.viewed[key(rel)]?.substringAfter('\t', "")?.ifEmpty { null }

    /** True when [rel] has a usable since-last-review snapshot (overlay on + blob present + changed since). */
    fun hasSinceReviewDiff(rel: String): Boolean = sinceReview() && reviewedBlob(rel) != null && !isViewed(rel)

    fun markViewed(rel: String) {
        if (base() == null) return   // no base yet → key would be "null\t…" garbage in vetty.xml
        val root = repoRoot()
        if (root != null && !java.io.File(root, rel).exists()) {
            // Deletion tombstone ('D' — not a valid sha1): viewed while the file stays gone,
            // re-flags unviewed if it comes back.
            state.viewed[key(rel)] = "D\t"; scheduleSave(); blobCheck.remove(key(rel)); return
        }
        val blob = git("hash-object", "-w", "--", rel).trim()   // snapshot blob for the since-review diff
        val h = fileHash(rel) ?: ""
        if (h.isNotEmpty() || blob.isNotEmpty()) { state.viewed[key(rel)] = "$h\t$blob"; scheduleSave() }
        blobCheck.remove(key(rel))
    }

    fun unmarkViewed(rel: String) { if (state.viewed.remove(key(rel)) != null) scheduleSave(); blobCheck.remove(key(rel)) }

    fun toggleViewed(rel: String) { if (isViewed(rel)) unmarkViewed(rel) else markViewed(rel) }

    // --- diff / open ------------------------------------------------------------------------

    fun relPath(vf: VirtualFile): String? {
        val root = repoRoot() ?: return null
        val p = vf.path
        return if (p.startsWith("$root/")) p.removePrefix("$root/") else null
    }

    private fun vfile(rel: String): VirtualFile? {
        val root = repoRoot() ?: return null
        val lfs = LocalFileSystem.getInstance()
        // findFileByPath is cached (no disk refresh) — much faster per diff; only refresh if it's unknown.
        return lfs.findFileByPath("$root/$rel") ?: lfs.refreshAndFindFileByPath("$root/$rel")
    }

    /** Open in a non-preview (pinned) tab — the "Open File" action. */
    fun openFile(rel: String) {
        vfile(rel)?.let { FileEditorManager.getInstance(project).openFile(it, true) }
    }

    /** The last file/diff opened by a single-click, so the next click can replace it (preview-tab feel). */
    private var lastPreview: VirtualFile? = null

    // Added/untracked files preview as a plain file tab (above); modified files preview in the diff
    // preview tab (VettyDiffPreview). Those are two separate surfaces, so switching between an added
    // and a modified file left BOTH open. The tool window wires this to close the diff preview when a
    // file preview opens; openFilePreview→file and diffPreview→file close each other for one preview.
    var closeDiffPreview: (() -> Unit)? = null

    /** Close the transient file-preview tab (called by the diff preview so only one preview shows). */
    fun closeFilePreview() {
        val prev = lastPreview ?: return
        lastPreview = null
        cs.launch(Dispatchers.EDT) {
            val fem = FileEditorManager.getInstance(project)
            if (fem.isFileOpen(prev)) fem.closeFile(prev)
        }
    }

    /**
     * Open a VirtualFile, replacing the previously single-clicked one (diff editors ignore the
     * preview-tab flag, so we close the prior tab ourselves to get the swap behavior).
     * openFile(...) is suspend in 2025.2 — launch on the scope (NOT runBlocking, which deadlocks the EDT).
     */
    /** Navigate to line/col and, for a search hit, select the matched text (like VS Code's openMatch). */
    private fun navigateAndSelect(file: VirtualFile, line: Int, col: Int, len: Int) {
        OpenFileDescriptor(project, file, line, col).navigateInEditor(project, true)
        if (len <= 0) return
        val ed = FileEditorManager.getInstance(project).selectedTextEditor ?: return
        val doc = ed.document
        if (line >= doc.lineCount) return
        val start = (doc.getLineStartOffset(line) + col).coerceAtMost(doc.getLineEndOffset(line))
        val end = (start + len).coerceAtMost(doc.getLineEndOffset(line))
        ed.selectionModel.setSelection(start, end)
    }

    private fun openPreview(file: VirtualFile, line: Int? = null, col: Int = 0, len: Int = 0) {
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
    private fun openPinned(file: VirtualFile, line: Int? = null, col: Int = 0, len: Int = 0) {
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
    private fun showBase(ref: String, rel: String): String {
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
    fun buildDiffRequest(rel: String): com.intellij.diff.requests.DiffRequest {
        val vf = vfile(rel)
        lastDiffRel = rel   // so commenting from a unified diff (synthetic doc) still knows the file
        val blob = reviewedBlob(rel)
        val hasReview = sinceReview() && blob != null && !isViewed(rel)  // overlay on + snapshot + changed since
        val (leftText, label) = when {
            hasReview -> git("cat-file", "-p", blob!!) to "last viewed"
            isCommitRange() -> showBase("HEAD", rel) to "uncommitted"
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
            req.putUserData(DiffUserDataKeysEx.CONTEXT_ACTIONS, listOf<AnAction>(object :
                ToggleAction("Viewed", "Mark this file viewed", AllIcons.Actions.Checked) {
                override fun getActionUpdateThread() = ActionUpdateThread.EDT
                override fun isSelected(e: AnActionEvent) = isViewed(rel)
                override fun setSelected(e: AnActionEvent, state: Boolean) {
                    com.intellij.openapi.application.ApplicationManager.getApplication().executeOnPooledThread {
                        if (state) markViewed(rel) else unmarkViewed(rel)
                        onChange?.invoke()
                    }
                }
            }))
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
        // Inline "Viewed" toggle in the diff toolbar (top-right), so you mark viewed while reviewing the file.
        req.putUserData(DiffUserDataKeysEx.CONTEXT_ACTIONS, listOf<AnAction>(object :
            ToggleAction("Viewed", "Mark this file viewed", AllIcons.Actions.Checked) {
            override fun getActionUpdateThread() = ActionUpdateThread.EDT
            override fun isSelected(e: AnActionEvent) = isViewed(rel)
            override fun setSelected(e: AnActionEvent, state: Boolean) {
                // markViewed spawns git (hash-object) — keep it off the EDT (Rider 2026+ hard-errors).
                com.intellij.openapi.application.ApplicationManager.getApplication().executeOnPooledThread {
                    if (state) markViewed(rel) else unmarkViewed(rel)
                    onChange?.invoke()
                }
            }
        }))
        return req
    }

    /** Double-click: open the file's diff in a permanent (pinned) tab. The request build spawns git,
     *  so it runs off the EDT (the preview path already does, via the diff processor). */
    fun openDiffPinned(f: VFile) {
        val rel = f.rel
        com.intellij.openapi.application.ApplicationManager.getApplication().executeOnPooledThread {
            val req = try { buildDiffRequest(rel) } catch (e: Exception) { return@executeOnPooledThread }
            com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
                val chainFile = try {
                    ChainDiffVirtualFile(SimpleDiffRequestChain(listOf(req)), rel.substringAfterLast('/'))
                } catch (e: Throwable) { null }
                if (chainFile != null) openPinned(chainFile) else DiffManager.getInstance().showDiff(project, req)
            }
        }
    }

    fun openTodo(rel: String, line: Int) = openTodoInternal(rel, line, false)
    fun openTodoPinned(rel: String, line: Int) = openTodoInternal(rel, line, true)

    /** Open a search hit with the matched text selected. */
    fun openMatch(rel: String, line: Int, col: Int, len: Int) {
        vfile(rel)?.let { openPreview(it, (line - 1).coerceAtLeast(0), col, len) }
    }
    fun openMatchPinned(rel: String, line: Int, col: Int, len: Int) {
        vfile(rel)?.let { openPinned(it, (line - 1).coerceAtLeast(0), col, len) }
    }

    private fun openTodoInternal(rel: String, line: Int, pinned: Boolean) {
        val vf = vfile(rel) ?: return
        val l = (line - 1).coerceAtLeast(0)
        val (col, len) = todoSpan(vf, l)   // select the marker → end of line, like a search hit
        if (pinned) openPinned(vf, l, col, len) else openPreview(vf, l, col, len)
    }

    /** Column + length to select on a TODO line: from the marker keyword to end of line (0,0 if none). */
    private fun todoSpan(vf: VirtualFile, line: Int): Pair<Int, Int> {
        val text = com.intellij.openapi.application.ReadAction.compute<String?, RuntimeException> {
            FileDocumentManager.getInstance().getDocument(vf)?.let { d ->
                if (line < d.lineCount) d.getText(com.intellij.openapi.util.TextRange(d.getLineStartOffset(line), d.getLineEndOffset(line))) else null
            }
        } ?: return 0 to 0
        val m = TODO_RE.find(text) ?: return 0 to 0
        return m.range.first to (text.length - m.range.first)
    }

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

    // --- comments ---------------------------------------------------------------------------

    /** rel of the most recently opened diff — fallback file when an editor's doc isn't a real file (unified diff). */
    private var lastDiffRel: String? = null

    /**
     * rel for an editor: its real file, or the currently-open diff's file when the doc is synthetic
     * (unified diff). Used by both commenting and gutter decoration so both work in any diff view.
     */
    fun relForEditor(editor: Editor): String? {
        val f = FileDocumentManager.getInstance().getFile(editor.document)
        return (f?.let { relPath(it) }) ?: lastDiffRel
    }

    /**
     * Add a comment on the caret line/selection of [editor].
     * Split diff (right side) / normal file → the editor doc maps to the real file → exact line.
     * Unified diff → synthetic doc, so fall back to the open diff's file; the line's text anchors it.
     */
    fun addCommentOn(editor: Editor): Boolean {
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
    private fun onBranch(c: VettyStateService.Comment) = c.branch == (curBranch ?: base())

    fun commentsFor(rel: String): List<VettyStateService.Comment> =
        state.comments.filter { it.file == rel && onBranch(it) }

    fun allComments(): List<VettyStateService.Comment> = state.comments.filter { onBranch(it) }

    fun addComment(rel: String, line: Int, span: Int, anchor: String, body: String) {
        state.comments.add(VettyStateService.Comment().apply {
            this.file = rel; this.line = line; this.span = span; this.anchor = anchor; this.body = body
            this.branch = curBranch ?: base() ?: ""
        })
        scheduleSave()
    }

    fun deleteComment(c: VettyStateService.Comment) { state.comments.remove(c); scheduleSave() }

    fun clearComments() { state.comments.removeAll { onBranch(it) }; scheduleSave() }   // current branch only

    /** Export this branch's comments paste-ready for an agent, like VS Code. */
    fun exportComments(): String {
        val mine = allComments()
        if (mine.isEmpty()) return ""
        val bullets = VettyParse.exportComments(mine).split("\n").joinToString("\n") { "- $it" }
        return "Address these review comments:\n\n$bullets\n"
    }

    /** Re-paint gutter icons in all open editors and refresh the tool window. */
    fun refreshUiAndGutters() {
        scheduleSave()   // catches comment body edits + line-drift persistence that don't go through add/delete
        VettyGutter.redecorateAll(project)
        onChange?.invoke()
    }
}
