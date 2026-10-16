package dev.vetty

/**
 * Base branch: per-branch memory, closest-ancestor inference via the branch tree, and the rows the
 * base picker shows. Extension functions on VettyService.
 */

internal val TRUNKS = listOf("main", "master", "develop", "dev", "trunk")
internal const val PARENT_MAX_AHEAD = 500   // beyond this an "ancestor" is an old merged branch, not a base

fun VettyService.branches(): List<String> =
    git("for-each-ref", "--format=%(refname:short)", "refs/heads")
        .split("\n").map { it.trim() }.filter { it.isNotEmpty() }

/** Resolved base for the current branch (mirror). Resolved on every load; resolve lazily if unset. */
fun VettyService.base(): String? {
    if (state.base == null) resolveBase()
    return state.base
}

/** Manual pick → remember it for the current branch. */
fun VettyService.setBase(b: String) {
    currentBranch()?.let { state.baseByBranch[it] = b }
    state.base = b
    scheduleSave()
}

/**
 * Per-branch base resolution. Runs on every load so a branch switch
 * restores that branch's base; an unset branch infers its closest ancestor. Never clobbers a manual pick.
 */
internal fun VettyService.resolveBase() {
    val cur = currentBranch() ?: return
    if (cur != curBranch) inheritBranchState(cur)   // checkout -b continuation: child inherits marks
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

/** checkout -b continuation: marks are branch-keyed, so a new child branch starts empty even
 *  though its content is identical to what was just reviewed. On switching to [cur]: find the
 *  branch we came from in the HEAD reflog (restart-safe), and if [cur] descends from its tip
 *  (merge-base == tip — exactly what checkout -b produces) and has no marks of its own yet,
 *  copy the parent's review state over. Hash-gating keeps it honest; never fires INTO a trunk
 *  (feature→master after a merge would pollute it); never overwrites existing marks. */
private fun VettyService.inheritBranchState(cur: String) {
    try {
        if (cur in TRUNKS) return
        val curHas = state.viewed.keys.any { it.startsWith("$cur\t") } ||
            state.ignored.any { it.startsWith("$cur\t") } ||
            state.comments.any { it.branch == cur }
        if (curHas) return   // never overwrite existing state
        // Newest "checkout: moving from A to B" in the reflog tells us the parent candidate.
        val re = Regex("^checkout: moving from (\\S+) to (\\S+)")
        val m = git("reflog", "HEAD", "-n", "30", "--format=%gs").split("\n")
            .firstNotNullOfOrNull { re.find(it) } ?: return
        val (prev, to) = m.destructured
        if (to != cur || prev == cur) return
        val prevViewed = state.viewed.filterKeys { it.startsWith("$prev\t") }
        if (prevViewed.isEmpty()) return
        val prevTip = git("rev-parse", "--verify", prev).trim()
        if (prevTip.isEmpty() || git("merge-base", prev, cur).trim() != prevTip) return
        for ((k, v) in prevViewed) state.viewed["$cur\t${k.substringAfter('\t')}"] = v
        state.ignored.filter { it.startsWith("$prev\t") }
            .forEach { state.ignored.add("$cur\t${it.substringAfter('\t')}") }
        state.comments.filter { it.branch == prev }.forEach { c ->
            state.comments.add(VettyStateService.Comment().apply {
                file = c.file; line = c.line; span = c.span; anchor = c.anchor; body = c.body; branch = cur
            })
        }
        scheduleSave()
        VettyService.dbg { "inherited review state $prev → $cur" }
    } catch (e: Exception) {
        VettyService.dbg { "inherit skipped: ${e.message}" }
    }
}

// GC: viewed/ignored entries and baseByBranch keys otherwise accumulate forever in vetty.xml as
// branches are deleted. Drop entries whose branch no longer exists locally — this also gradually
// clears legacy base-keyed entries (origin/* etc.).
private fun VettyService.pruneStale(known: List<String>) {
    state.viewed.keys.removeAll { it.substringBefore('\t') !in known }
    state.ignored.removeAll { it.substringBefore('\t') !in known }
    state.baseByBranch.keys.removeAll { it !in known }
    state.mergeBaseByBranch.keys.removeAll { it !in known }
    state.comments.removeAll { it.branch !in known }   // also drops legacy branch="" comments once
}

/** When another branch's tip EQUALS this one's (fresh stacked branch, no commits yet), commit
 *  topology is symmetric — parent and child look identical. The reflog breaks the tie: its oldest
 *  entry is the branch's creation moment, and the branch created EARLIER is the parent. */
private fun VettyService.branchCreatedAt(branch: String): Long =
    // %gd + --date=unix = the reflog ENTRY time (%ct would be the commit time — identical for
    // same-tip branches, useless as a tie-break). Oldest entry = branch creation.
    git("reflog", "show", "--date=unix", "--format=%gd", branch).trim().split("\n")
        .lastOrNull { it.isNotBlank() }
        ?.let { Regex("""@\{(\d+)\}""").find(it)?.groupValues?.get(1)?.toLongOrNull() }
        ?: Long.MAX_VALUE   // no reflog → can't claim parenthood

/** Tree parent (the terminal picker rule, see VettyBranchTree.branchTree) → conventional local → most-recent
 *  other local → current branch. Two git calls for every branch instead of one per branch, and the
 *  picker's BASE chip and the inferred base can't disagree (the old ahead/behind scan could root a
 *  stacked branch on develop). */
private fun VettyService.inferClosestAncestor(cur: String): String {
    if (cur in TRUNKS) return cur   // a trunk has no parent; every merged branch is an "ancestor" → diff working changes
    val others = branches().filter { it != cur }
    branchTreeData().rows.firstOrNull { it.name == cur }?.parent?.ifEmpty { null }?.let { return it }
    for (c in TRUNKS) if (c in others) return c
    recentBranch(others)?.let { return it }
    return cur   // diff against self = uncommitted working changes only
}

class BranchTreeData(val rows: List<VettyBranchTree.BranchRow>, val worktrees: Map<String, String>)

/** Every local branch as a tree + which branch is checked out in which other worktree. Two git
 *  calls plus one worktree list; reflog births only for same-tip ties. Feeds the picker and the base. */
fun VettyService.branchTreeData(): BranchTreeData {
    val outs = parMap(listOf(
        listOf("for-each-ref", "--format=%(objectname) %(refname:short)", "--sort=-committerdate", "refs/heads"),
        // --branches, not --all: remotes/tags would spend the walk budget and re-root stacked branches.
        listOf("log", "--branches", "--first-parent", "--format=%H %P", "-n", "4000"),
        listOf("worktree", "list", "--porcelain"),
    )) { git(*it.toTypedArray()) }
    val rows = VettyBranchTree.branchTree(VettyBranchTree.parseBranchTips(outs[0]), VettyBranchTree.parseFirstParents(outs[1]),
        TRUNKS, { branchCreatedAt(it) }, PARENT_MAX_AHEAD)
    return BranchTreeData(rows, VettyBranchTree.parseWorktrees(outs[2], repoRoot() ?: ""))
}

/** One picker row, bottom-up order (trunk at the foot). BASE = the base in use now. */
class PickRow(val name: String, val cells: List<VettyBranchTree.GraphCell>, val noTrunk: Boolean, val current: Boolean,
              val base: Boolean, val trunk: Boolean, val worktree: String)

fun VettyService.basePickerRows(): List<PickRow> {
    val cur = currentBranch()
    val tree = branchTreeData()
    val rows = tree.rows.reversed()
    val g = VettyBranchTree.layoutBranchGraph(rows, cur, TRUNKS)
    val using = base()
    return rows.mapIndexed { i, r ->
        PickRow(r.name, g.cells[i], noTrunk = g.lines[i].any { it == '◇' || it == '◈' } && r.parent.isEmpty(),
            current = r.name == cur, base = r.name == using && r.name != cur, trunk = r.name in TRUNKS,
            worktree = if (r.name != cur) tree.worktrees[r.name] ?: "" else "")
    }
}

private fun VettyService.recentBranch(others: List<String>): String? =
    git("for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads")
        .split("\n").map { it.trim() }.firstOrNull { it in others }

data class BranchItem(val branch: String, val label: String, val rank: Int, val ahead: Int)

fun VettyService.currentBranch(): String? = git("rev-parse", "--abbrev-ref", "HEAD").trim().ifEmpty { null }

private fun VettyService.aheadBehind(branch: String): Pair<Int, Int>? =
    VettyParse.parseAheadBehind(git("rev-list", "--left-right", "--count", "$branch...HEAD"))

/** Local branches labeled by relation to HEAD: parent / ancestor / descendant / diverged, parent first. */
fun VettyService.rankedBranches(): List<BranchItem> {
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
