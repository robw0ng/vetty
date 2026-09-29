package dev.vetty

/**
 * Pure helpers — no IntelliJ Platform dependency, so they're unit-testable with plain JUnit
 * (see VettyParseTest). Mirrors the role of lib.js in the VS Code extension.
 */
object VettyParse {

    // TODO markers (mirrors lib.js TODO_RE). A bare uppercase word isn't enough — `%TEMP%`,
    // `$env:TEMP`, `` `TEMP` `` are identifiers. A marker counts only (1) right after a comment
    // leader (`// TODO`, `# FIXME`, `/* HACK`, a block-comment `* NOTE` line, `<!-- WIP`, `-- XXX`,
    // `; BUG`), or (2) as a `TODO:` / `TODO(me):` label not glued to a path/variable. Group 1|2 = marker.
    private const val TODO_WORDS = "TODO|FIXME|HACK|XXX|BUG|NOTE|OPTIMIZE|REVIEW|WIP|TEMP|REFACTOR|DEPRECATED"
    val TODO_RE = Regex(
        """(?:(?:^|\s)(?://+|#+|/\*+|<!--|--|;+)\s*|^\s*\*+\s*)($TODO_WORDS)\b""" +
            """|(?<![\w${'$'}%.:\\/-])($TODO_WORDS)(?:\([^)]*\))?:"""
    )

    // --- Claude review file (<git-dir>/vetty/claude-review.json; mirrors lib.js) ---------------
    // { branch?, order: [ "path" | { file, note } ], comments: [ { file, line, endLine?, anchor?, body } ] }
    // Paths are repo-root-relative; [prefix] (git rev-parse --show-prefix) maps them to project-relative.

    /** order: rel → (index, note); comments: ai-flagged Comments (0-based line). */
    data class ClaudeReview(val order: Map<String, Pair<Int, String>>, val comments: List<VettyStateService.Comment>,
                            val head: String = "", val writtenAt: Long = 0)   // staleness (skill writes both; optional)

    private fun claudeRel(f: String?, prefix: String): String? {
        val r = f?.replace('\\', '/')?.removePrefix("./") ?: return null
        return if (r.isNotEmpty() && r.startsWith(prefix)) r.removePrefix(prefix) else null
    }

    /** Parse the review file; null when unparseable or written for a different branch. */
    fun parseClaudeReview(text: String, branch: String?, prefix: String = ""): ClaudeReview? {
        val j = try { com.google.gson.JsonParser.parseString(text).asJsonObject } catch (e: Exception) { return null }
        val b = j.get("branch")?.takeIf { it.isJsonPrimitive }?.asString
        if (!b.isNullOrEmpty() && !branch.isNullOrEmpty() && b != branch) return null
        val order = LinkedHashMap<String, Pair<Int, String>>()
        (j.get("order") as? com.google.gson.JsonArray)?.forEach { e ->
            val o = e as? com.google.gson.JsonObject
            val f = if (o != null) o.get("file")?.takeIf { it.isJsonPrimitive }?.asString
                    else e.takeIf { it.isJsonPrimitive }?.asString
            val r = claudeRel(f, prefix) ?: return@forEach
            if (r !in order) order[r] = order.size to (o?.get("note")?.takeIf { it.isJsonPrimitive }?.asString ?: "")
        }
        val comments = ArrayList<VettyStateService.Comment>()
        (j.get("comments") as? com.google.gson.JsonArray)?.forEach { e ->
            val o = e as? com.google.gson.JsonObject ?: return@forEach
            fun str(k: String) = o.get(k)?.takeIf { it.isJsonPrimitive }?.asString
            val r = claudeRel(str("file"), prefix) ?: return@forEach
            val line = str("line")?.toIntOrNull()?.takeIf { it >= 1 } ?: return@forEach
            val text1 = str("body")?.takeIf { it.isNotEmpty() } ?: return@forEach
            val end = maxOf(line, str("endLine")?.toIntOrNull() ?: line)
            comments.add(VettyStateService.Comment().apply {
                file = r; this.line = line - 1; span = end - line; anchor = str("anchor")?.trim() ?: ""; body = text1; ai = true
                big = str("kind") == "big-picture"
            })
        }
        val head = j.get("head")?.takeIf { it.isJsonPrimitive }?.asString?.trim() ?: ""
        val writtenAt = j.get("writtenAt")?.takeIf { it.isJsonPrimitive }?.asString
            ?.let { try { java.time.Instant.parse(it).toEpochMilli() } catch (e: Exception) { 0L } } ?: 0L
        return ClaudeReview(order, comments, head, writtenAt)
    }

    /** Review-file text with [gone] removed (matched by file + line + body). */
    fun removeClaudeComments(text: String, gone: List<VettyStateService.Comment>, prefix: String = ""): String {
        val j = com.google.gson.JsonParser.parseString(text).asJsonObject
        val drop = gone.map { "${prefix + it.file}\n${it.line + 1}\n${it.body}" }.toHashSet()
        val kept = com.google.gson.JsonArray()
        (j.get("comments") as? com.google.gson.JsonArray)?.forEach { e ->
            val o = e as? com.google.gson.JsonObject
            fun str(k: String) = o?.get(k)?.takeIf { it.isJsonPrimitive }?.asString
            val key = "${str("file")?.replace('\\', '/')?.removePrefix("./")}\n${str("line")?.toIntOrNull()}\n${str("body")}"
            if (key !in drop) kept.add(e)
        }
        j.add("comments", kept)
        return com.google.gson.GsonBuilder().setPrettyPrinting().create().toJson(j) + "\n"
    }

    /** "just now" / "12m ago" / "3h ago" / "2d ago"; "" for 0 (mirrors lib.js ago). */
    fun ago(ms: Long, now: Long = System.currentTimeMillis()): String {
        if (ms == 0L) return ""
        val m = Math.round((now - ms) / 60000.0)
        return when {
            m < 1 -> "just now"
            m < 60 -> "${m}m ago"
            m < 24 * 60 -> "${Math.round(m / 60.0)}h ago"
            else -> "${Math.round(m / 1440.0)}d ago"
        }
    }

    /** Minimal markdown → HTML for a Swing tooltip: bullets, **bold**, `code`, tables (as an aligned
     *  <pre> grid), paragraphs. ponytail: no nesting, no links — notes are short. */
    fun mdToHtml(md: String): String {
        val esc = { s: String -> s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;") }   // keep this object platform-free
        val inline = { s: String ->
            esc(s).replace(Regex("\\*\\*(.+?)\\*\\*"), "<b>$1</b>").replace(Regex("`([^`]+)`"), "<code>$1</code>")
        }
        val out = StringBuilder()
        var inList = false
        var pre: MutableList<String>? = null   // collecting a table block (already aligned lines)
        fun closeList() { if (inList) { out.append("</ul>"); inList = false } }
        for (line in alignTables(md).split("\n")) {
            val t = line.trimEnd()
            if (t.startsWith("┌") || pre != null) {   // grid rows come from alignTables
                (pre ?: ArrayList<String>().also { pre = it }).add(esc(t))
                if (t.startsWith("└")) { closeList(); out.append("<pre>${pre!!.joinToString("\n")}</pre>"); pre = null }
                continue
            }
            val bullet = Regex("^\\s*[-*+]\\s+(.*)$").find(t)
            when {
                bullet != null -> { if (!inList) { out.append("<ul>"); inList = true }; out.append("<li>${inline(bullet.groupValues[1])}</li>") }
                t.isBlank() -> closeList()
                else -> { closeList(); out.append("<p>${inline(t)}</p>") }
            }
        }
        closeList()
        return out.toString()
    }

    /** Markdown tables → aligned plain columns (mirrors lib.js tablesToText, minus the code fence —
     *  the Rider tooltip is already monospace). Inline `code` and ** marks are dropped inside cells. */
    fun alignTables(md: String): String {
        val lines = md.split("\n")
        val isRow = Regex("""^\s*\|.*\|\s*$""")
        val isSep = Regex("""^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$""")
        val out = ArrayList<String>()
        var i = 0
        while (i < lines.size) {
            if (!(isRow.matches(lines[i]) && i + 1 < lines.size && isSep.matches(lines[i + 1]) && '-' in lines[i + 1])) {
                out.add(lines[i]); i++; continue
            }
            val rows = arrayListOf(lines[i])
            var j = i + 2
            while (j < lines.size && isRow.matches(lines[j])) rows.add(lines[j++])
            val cells = rows.map { r -> r.trim().removePrefix("|").removeSuffix("|").split("|").map { it.trim().replace("**", "").replace("`", "") } }
            val w = (0 until cells.maxOf { it.size }).map { k -> cells.maxOf { it.getOrElse(k) { "" }.length } }
            // Box-drawn grid (mirrors lib.js gridLines): borders on every cell, a rule between every
            // row, a double rule under the header — rows and columns both easy to tell apart.
            fun rule(l: String, m: String, r: String, h: String = "─") = l + w.joinToString(m) { h.repeat(it + 2) } + r
            fun row(r: List<String>) = "│" + w.indices.joinToString("│") { k -> " ${r.getOrElse(k) { "" }.padEnd(w[k])} " } + "│"
            out.add(rule("┌", "┬", "┐"))
            cells.forEachIndexed { n, r ->
                if (n == 1) out.add(rule("╞", "╪", "╡", "═")) else if (n > 1) out.add(rule("├", "┼", "┤"))
                out.add(row(r))
            }
            out.add(rule("└", "┴", "┘"))
            i = j
        }
        return out.joinToString("\n")
    }

    /** Column of the marker keyword in [text], or -1 if the line holds no marker. */
    fun todoCol(text: String): Int {
        val m = TODO_RE.find(text) ?: return -1
        return (m.groups[1] ?: m.groups[2])!!.range.first
    }

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
            // Git appends a trailing TAB to the header when the path contains spaces (GNU patch
            // compat) — without stripping it, the recorded path never matches the review set.
            if (line.startsWith("+++ ")) { rel = line.substring(4).removePrefix("b/").trimEnd('\t', '\r'); continue }
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

    /** EOL-normalize (CRLF / lone CR → LF), byte-lossless otherwise. Content hashes built on this
     *  survive autocrlf checkout round-trips that flip a file's line endings. */
    fun eolNormalize(bytes: ByteArray): ByteArray {
        val out = java.io.ByteArrayOutputStream(bytes.size)
        var i = 0
        while (i < bytes.size) {
            if (bytes[i] == '\r'.code.toByte()) {
                out.write('\n'.code)
                if (i + 1 < bytes.size && bytes[i + 1] == '\n'.code.toByte()) i++
            } else out.write(bytes[i].toInt())
            i++
        }
        return out.toByteArray()
    }

    /** Render comments as `file:line — body` (or `file:start-end` for a range), one per line (1-based). */
    fun exportComments(comments: List<VettyStateService.Comment>): String =
        comments.joinToString("\n") {
            val loc = if (it.span > 0) "${it.line + 1}-${it.line + it.span + 1}" else "${it.line + 1}"
            "${it.file}:$loc — ${it.body}"
        }
}
