package dev.vetty

/**
 * Pure helpers — no IntelliJ Platform dependency, so they're unit-testable with plain JUnit
 * (see VettyParseTest). Mirrors the role of lib.js in the VS Code extension.
 */
object VettyParse {

    /** Parse `git diff --name-status --diff-filter=d <base>` → list of (status, path). */
    fun parseNameStatus(out: String): List<Pair<String, String>> {
        val res = ArrayList<Pair<String, String>>()
        for (line in out.split("\n")) {
            if (line.isBlank()) continue
            val parts = line.split("\t")
            if (parts.size < 2) continue
            // Rename/copy lines are "R100\told\tnew" — the new path is last.
            res.add(parts[0].take(1) to parts.last())
        }
        return res
    }

    /** Parse `git diff --numstat <base>` → Map(path → add to del). Binary files ("-\t-\t…") skipped. */
    fun parseNumstat(out: String): Map<String, Pair<Int, Int>> {
        val m = HashMap<String, Pair<Int, Int>>()
        for (line in out.split("\n")) {
            val parts = line.split("\t")
            if (parts.size < 3) continue
            val add = parts[0].toIntOrNull() ?: continue
            val del = parts[1].toIntOrNull() ?: continue
            m[parts.last()] = add to del
        }
        return m
    }

    /** Parse `git rev-list --left-right --count B...HEAD` → (behind, ahead) relative to B. */
    fun parseAheadBehind(out: String): Pair<Int, Int>? {
        val p = out.trim().split(Regex("\\s+"))
        if (p.size < 2) return null
        val behind = p[0].toIntOrNull()
        val ahead = p[1].toIntOrNull()
        return if (behind != null && ahead != null) behind to ahead else null
    }

    /**
     * Re-anchor a comment to its line by content. If the stored line still matches the anchor
     * text, keep it; otherwise find the first line whose trimmed text equals the anchor; failing
     * that, keep the (clamped) stored line. `lines` is 0-based; returns a 0-based line index.
     */
    fun reanchor(lines: List<String>, storedLine: Int, anchor: String): Int {
        val a = anchor.trim()
        if (a.isEmpty()) return storedLine
        if (storedLine in lines.indices && lines[storedLine].trim() == a) return storedLine
        // Search outward from the stored line for the NEAREST matching line (like VS Code's relocateLine).
        var d = 1
        while (storedLine - d >= 0 || storedLine + d < lines.size) {
            val up = storedLine - d
            if (up in lines.indices && lines[up].trim() == a) return up
            val down = storedLine + d
            if (down in lines.indices && lines[down].trim() == a) return down
            d++
        }
        return storedLine   // anchor gone → keep the raw stored line (no clamp), like VS Code
    }

    /**
     * Parse `git diff -U0` output for marker matches on ADDED lines, tracking new-file line numbers.
     * Returns (rel, line, text) triples. Ported from lib.js parseTodoHunks.
     */
    fun parseTodoHunks(out: String, re: Regex): List<Triple<String, Int, String>> {
        val todos = ArrayList<Triple<String, Int, String>>()
        var rel: String? = null
        var newLine = 0
        val hunkRe = Regex("""^@@ -\d+(?:,\d+)? \+(\d+)""")
        for (line in out.split("\n")) {
            if (line.startsWith("+++ ")) { rel = line.substring(4).removePrefix("b/"); continue }
            if (line.startsWith("---")) continue
            val hunk = hunkRe.find(line)
            if (hunk != null) { newLine = hunk.groupValues[1].toInt(); continue }
            if (line.startsWith("+")) {
                val content = line.substring(1)
                if (rel != null && re.containsMatchIn(content)) todos.add(Triple(rel!!, newLine, content.trim()))
                newLine++ // added lines advance the new-file counter; '-' lines don't (and -U0 has no context)
            }
        }
        return todos
    }

    /** Render comments as `file:line — body` (or `file:start-end` for a range), one per line (1-based). */
    fun exportComments(comments: List<VettyStateService.Comment>): String =
        comments.joinToString("\n") {
            val loc = if (it.span > 0) "${it.line + 1}-${it.line + it.span + 1}" else "${it.line + 1}"
            "${it.file}:$loc — ${it.body}"
        }
}
