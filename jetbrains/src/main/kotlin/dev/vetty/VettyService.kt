package dev.vetty

import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.application.EDT
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.project.Project
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
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

    // Viewed-state caches (VettyViewed.kt). hashCache: content hash by stamp (doc modificationStamp
    // catches unsaved edits; VFS stamp otherwise) — without it every reload AND every 60ms typing
    // regroup re-reads + re-SHA1s each marked file. blobCheck: key(rel) → (contentHash, verdict) for
    // the `git hash-object` fallback, so a regroup never re-spawns git per edited-since-viewed file.
    internal val hashCache = java.util.concurrent.ConcurrentHashMap<String, Pair<Long, String>>()
    internal val blobCheck = HashMap<String, Pair<String, Boolean>>()

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

    /** The last file/diff opened by a single-click, so the next click can replace it (preview-tab feel). */
    internal var lastPreview: VirtualFile? = null

    // File previews and the diff preview (VettyDiffPreview) are two tab surfaces, so switching between
    // an added and a modified file left both open. The tool window wires this so each closes the other.
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
