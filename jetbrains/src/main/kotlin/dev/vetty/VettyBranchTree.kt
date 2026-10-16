package dev.vetty

/**
 * Branch tree (port of the terminal picker's tree / parent / graph routines; mirrors lib.js).
 * Git stores no parent, so infer it: walk a branch's FIRST-parent history from its tip; the first
 * commit holding another branch's tip is the fork point. Same-tip ties (fresh stacked branch) go to
 * the branch created most recently BEFORE us (reflog birth). Platform-free.
 */
object VettyBranchTree {

    class BranchTips(val at: Map<String, List<String>>, val names: List<String>)   // sha → names (listing order)
    data class BranchRow(val name: String, val parent: String)                    // parent "" = root
    /** One text column of the graph: a node glyph (◉ ◯ ◈ ◇) or lines leaving the cell's centre. */
    data class GraphCell(val node: Char?, val up: Boolean, val down: Boolean, val left: Boolean, val right: Boolean)
    class BranchGraph(val lines: List<String>, val cells: List<List<GraphCell>>)

    /** `for-each-ref --format='%(objectname) %(refname:short)'` */
    fun parseBranchTips(text: String): BranchTips {
        val at = LinkedHashMap<String, MutableList<String>>()
        val names = ArrayList<String>()
        for (l in text.split("\n")) {
            val i = l.indexOf(' ')
            if (i < 1) continue
            val name = l.substring(i + 1).trim()
            if (name.isEmpty()) continue
            at.getOrPut(l.substring(0, i)) { ArrayList() }.add(name)
            names.add(name)
        }
        return BranchTips(at, names)
    }

    /** `log --first-parent --format='%H %P'` → sha → first parent (null at a root). */
    fun parseFirstParents(text: String): Map<String, String?> {
        val m = HashMap<String, String?>()
        for (l in text.split("\n")) {
            val p = l.trim().split(' ')
            if (p[0].isNotEmpty()) m[p[0]] = p.getOrNull(1)?.ifEmpty { null }
        }
        return m
    }

    fun findBranchParent(name: String, tip: String, next: Map<String, String?>, branchAt: Map<String, List<String>>,
                         birthOf: (String) -> Long, maxAhead: Int): String? {
        var c: String? = tip
        var d = 0
        while (c != null && d < maxAhead) {
            val here = branchAt[c]
            if (here != null) {
                val hit = here.filter { it != name }
                if (hit.size == 1 && d > 0) return hit[0]
                if (hit.isNotEmpty()) {
                    val mine = birthOf(name)
                    var best: String? = null; var bestBorn = Long.MIN_VALUE
                    for (b in hit) { val born = birthOf(b); if (born < mine && born > bestBorn) { bestBorn = born; best = b } }
                    if (best != null) return best
                    if (d > 0) return hit[0]
                }
            }
            c = next[c]; d++
        }
        return null
    }

    /** Rows depth-first, siblings newest-first; detached roots (no trunk in their history) before the
     *  trunk so a bottom-up list puts them under it. [birthOf] is memoized here. */
    fun branchTree(tips: BranchTips, firstParents: Map<String, String?>, trunks: List<String>,
                   birthOf: (String) -> Long, maxAhead: Int = 500): List<BranchRow> {
        val tipOf = LinkedHashMap<String, String>()
        for ((sha, ns) in tips.at) for (n in ns) tipOf[n] = sha
        val births = HashMap<String, Long>()
        val birth = { b: String -> births.getOrPut(b) { birthOf(b) } }
        // A trunk that moved on leaves no tip on a branch cut from it: fall back to the trunk — but
        // only one whose history the branch reaches, else it stays a (no trunk) root.
        val onTrunk = LinkedHashMap<String, Set<String>>()
        for (t in trunks) {
            val tip = tipOf[t] ?: continue
            val set = HashSet<String>(); var c: String? = tip
            while (c != null && set.add(c)) c = firstParents[c]
            onTrunk[t] = set
        }
        val kids = HashMap<String, MutableList<String>>()
        val roots = ArrayList<String>()
        for ((b, tip) in tipOf) {
            var par = findBranchParent(b, tip, firstParents, tips.at, birth, maxAhead)
            if (par == null && b !in trunks) {
                for ((t, set) in onTrunk) {
                    var c: String? = tip
                    while (c != null && c !in set) c = firstParents[c]
                    if (c != null) { par = t; break }
                }
            }
            if (par != null && par != b) kids.getOrPut(par) { ArrayList() }.add(b) else roots.add(b)
        }
        val order = tips.names.withIndex().associate { it.value to it.index }
        val rows = ArrayList<BranchRow>()
        fun emit(name: String, parent: String) {
            rows.add(BranchRow(name, parent))
            for (k in (kids[name] ?: emptyList()).sortedBy { order[it] ?: Int.MAX_VALUE }) emit(k, name)
        }
        for (r in roots.sortedWith(compareBy({ it in trunks }, { order[it] ?: Int.MAX_VALUE }))) emit(r, "")
        return rows
    }

    /** Lanes like `git log --graph`, rows top-down with every child above its parent: a branch with no
     *  lane heading to it opens the leftmost free one; on its parent's row every lane heading there
     *  joins it (┴, ┘ for the rightmost). Nodes ◉ current / ◯ other; a stack without a trunk root ◈ / ◇. */
    fun layoutBranchGraph(rows: List<BranchRow>, current: String?, trunks: List<String>): BranchGraph {
        val up = rows.filter { it.parent.isNotEmpty() }.associate { it.name to it.parent }
        val lanes = ArrayList<String?>()
        val lines = ArrayList<String>()
        val cells = ArrayList<List<GraphCell>>()
        for (r in rows) {
            var root = r.name; val seen = HashSet<String>()
            while (up[root] != null && seen.add(root)) root = up[root]!!
            val detached = trunks.isNotEmpty() && root !in trunks
            val node = if (detached) (if (r.name == current) '◈' else '◇') else (if (r.name == current) '◉' else '◯')
            val mine = lanes.indices.filter { lanes[it] == r.name }
            val col = if (mine.isNotEmpty()) mine[0] else lanes.indexOf(null).let { if (it < 0) { lanes.add(null); lanes.size - 1 } else it }
            val joins = mine.drop(1)
            val far = joins.lastOrNull() ?: col
            val sb = StringBuilder(); val row = ArrayList<GraphCell>()
            for (i in lanes.indices) {
                val g = when {
                    i == col -> node
                    i in joins -> if (i == far) '┘' else '┴'
                    i > col && i < far -> if (lanes[i] != null) '┼' else '─'
                    lanes[i] != null -> '│'
                    else -> ' '
                }
                val gap = i >= col && i < far
                sb.append(g).append(if (gap) '─' else ' ')
                row.add(when {
                    i == col -> GraphCell(node, mine.isNotEmpty(), r.parent.isNotEmpty(), false, col < far)
                    i in joins -> GraphCell(null, true, false, true, i != far)
                    i > col && i < far -> GraphCell(null, lanes[i] != null, lanes[i] != null, true, true)
                    else -> GraphCell(null, lanes[i] != null, lanes[i] != null, false, false)
                })
                row.add(GraphCell(null, false, false, gap, gap))
            }
            for (j in joins) lanes[j] = null
            lanes[col] = r.parent.ifEmpty { null }
            while (lanes.isNotEmpty() && lanes.last() == null) lanes.removeAt(lanes.size - 1)
            lines.add(sb.toString()); cells.add(row)
        }
        val w = lines.maxOfOrNull { it.length } ?: 0
        return BranchGraph(lines.map { it.padEnd(w) }, cells)
    }

    /** `git worktree list --porcelain` → branch → worktree folder name, excluding [cwd] itself. */
    fun parseWorktrees(text: String, cwd: String): Map<String, String> {
        val norm = { p: String -> p.replace('\\', '/').trimEnd('/').lowercase() }
        val map = LinkedHashMap<String, String>()
        var path = ""
        for (l in text.split("\n")) {
            if (l.startsWith("worktree ")) path = l.substring(9).trim()
            else if (l.startsWith("branch refs/heads/") && path.isNotEmpty() && norm(path) != norm(cwd))
                map[l.substring(18).trim()] = path.trimEnd('/', '\\').substringAfterLast('/').substringAfterLast('\\')
        }
        return map
    }

    /** HSL → RGB (0..255 ints). */
    fun hslToRgb(h: Double, s: Double, l: Double): IntArray {
        val c = (1 - Math.abs(2 * l - 1)) * s
        val hp = ((h % 360) + 360) % 360 / 60
        val x = c * (1 - Math.abs(hp % 2 - 1))
        val (r1, g1, b1) = when {
            hp < 1 -> Triple(c, x, 0.0); hp < 2 -> Triple(x, c, 0.0); hp < 3 -> Triple(0.0, c, x)
            hp < 4 -> Triple(0.0, x, c); hp < 5 -> Triple(x, 0.0, c); else -> Triple(c, 0.0, x)
        }
        val m = l - c / 2
        return intArrayOf(((r1 + m) * 255).toInt(), ((g1 + m) * 255).toInt(), ((b1 + m) * 255).toInt())
    }

    /** the terminal picker's palette: hues spread over the circle minus a band around the accent,
     *  visited with a stride coprime to n so neighbours differ. Returns hues, 0..360. */
    fun branchPalette(count: Int, accentHue: Double): List<Double> {
        val n = Math.max(count, 1); val band = 64.0; val step = (360.0 - band) / n; val start = (accentHue + band / 2) % 360
        val hues = (0 until n).map { (start + it * step) % 360 }
        var stride = Math.max(Math.floor(n / 2.2).toInt(), 1)
        fun gcd(a: Int, b: Int): Int = if (b == 0) a else gcd(b, a % b)
        while (stride > 1 && gcd(n, stride) != 1) stride--
        val out = ArrayList<Double>(); var idx = 0
        repeat(n) { out.add(hues[idx]); idx = (idx + stride) % n }
        return out
    }
}
