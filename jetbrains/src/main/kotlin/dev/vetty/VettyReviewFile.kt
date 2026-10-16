package dev.vetty

/**
 * Claude review file (<git-dir>/vetty/claude-review.json; mirrors lib.js): parse / remove notes,
 * plus the note-rendering helpers (ago, markdown → tooltip HTML). Platform-free.
 * { branch?, order: [ "path" | { file, note } ], comments: [ { file, line, endLine?, anchor?, body } ] }
 * Paths are repo-root-relative; [prefix] (git rev-parse --show-prefix) maps them to project-relative.
 */
object VettyReviewFile {

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
}
