package dev.vetty

import org.junit.Assert.assertEquals
import org.junit.Test

class VettyParseTest {

    @Test fun nameStatus_parsesAndTakesRenameTarget() {
        val out = "M\tsrc/a.kt\nA\tsrc/b.kt\nR100\told/c.kt\tnew/c.kt\n"
        assertEquals(
            listOf("M" to "src/a.kt", "A" to "src/b.kt", "R" to "new/c.kt"),
            VettyParse.parseNameStatus(out)
        )
    }

    @Test fun numstat_parsesAndSkipsBinary() {
        val out = "12\t3\tsrc/a.kt\n-\t-\timg.png\n0\t5\tsrc/b.kt\n"
        val m = VettyParse.parseNumstat(out)
        assertEquals(12 to 3, m["src/a.kt"])
        assertEquals(0 to 5, m["src/b.kt"])
        assertEquals(null, m["img.png"])
    }

    @Test fun reanchor_keepsExactThenFindsByContentThenClamps() {
        val lines = listOf("alpha", "beta", "gamma")
        assertEquals(1, VettyParse.reanchor(lines, 1, "beta"))          // exact line still matches
        assertEquals(2, VettyParse.reanchor(lines, 0, "gamma"))         // moved: found by content (nearest)
        assertEquals(9, VettyParse.reanchor(lines, 9, "nope"))          // gone: keep raw stored line (no clamp)
    }

    @Test fun parseTodoHunks_findsMarkersOnAddedLinesWithLineNumbers() {
        val diff = """
            diff --git a/x.kt b/x.kt
            --- a/x.kt
            +++ b/x.kt
            @@ -0,0 +1,3 @@
            +val a = 1
            +// TODO fix this
            +val b = 2
        """.trimIndent()
        val todos = VettyParse.parseTodoHunks(diff, VettyService.TODO_RE)
        assertEquals(1, todos.size)
        assertEquals("x.kt", todos[0].first)
        assertEquals(2, todos[0].second)              // 2nd added line
        assertEquals("// TODO fix this", todos[0].third)
    }

    // Identifiers like %TEMP% / $env:TEMP / `TEMP` in prose flooded the TODO list (real false positives).
    @Test fun todoRe_needsCommentLeaderOrLabel() {
        for (s in listOf("%TEMP%\\logs\\x.log", "# Spelled the long way: \$env:TEMP is short", "\$env:TEMP = \$Shell",
            "shell whose `TEMP` is the 8.3 spelling", "# child: TEMP spelled as asked", "a * TEMP_FACTOR"))
            assertEquals(s, false, VettyParse.TODO_RE.containsMatchIn(s))
        for (s in listOf("// TODO fix", "# FIXME: x", "/* HACK */", " * NOTE: y", "<!-- WIP -->", "x(); // TODO(rob): later", "- NOTE: md"))
            assertEquals(s, true, VettyParse.TODO_RE.containsMatchIn(s))
        assertEquals(8, VettyParse.todoCol("x(); // TODO: y"))
    }

    // Claude review file: branch-scoped, repo→project prefix mapped, order dedup + notes, 1→0-based lines.
    @Test fun claudeReview_parsesAndDeletes() {
        val text = """{"branch":"feat","order":["sub/a.kt",{"file":"sub/b.kt","note":"callers"},"sub/a.kt","other/x.kt"],
            "comments":[{"file":"sub/a.kt","line":3,"endLine":5,"anchor":" val x = 1 ","body":"- why"},
                        {"file":"sub/a.kt","line":0,"body":"bad"}]}"""
        assertEquals(null, VettyParse.parseClaudeReview(text, "other", "sub/"))
        val r = VettyParse.parseClaudeReview(text, "feat", "sub/")!!
        assertEquals(mapOf("a.kt" to (0 to ""), "b.kt" to (1 to "callers")), r.order)   // other/ is outside the project
        assertEquals(1, r.comments.size)
        val c = r.comments[0]
        assertEquals(listOf("a.kt", 2, 2, "val x = 1", true), listOf(c.file, c.line, c.span, c.anchor, c.ai))
        val left = VettyParse.parseClaudeReview(VettyParse.removeClaudeComments(text, r.comments, "sub/"), "feat", "sub/")!!
        assertEquals(0, left.comments.size)
    }

    @Test fun exportComments_formatsFileLineBody() {
        val c = VettyStateService.Comment().apply { file = "src/a.kt"; line = 4; body = "fix this" }
        assertEquals("src/a.kt:5 — fix this", VettyParse.exportComments(listOf(c)))
    }

    @Test fun parseTodoHunks_stripsTrailingTabOnSpacedPaths() {
        // Git appends a trailing TAB to the +++ header when the path contains spaces.
        val diff = "+++ b/src/Back End/Foo.cs\t\n@@ -0,0 +1 @@\n+// TODO: scoped"
        val todos = VettyParse.parseTodoHunks(diff, VettyService.TODO_RE)
        assertEquals(1, todos.size)
        assertEquals("src/Back End/Foo.cs", todos[0].first)
    }

    // The branch swap-and-back bug: autocrlf rewrites files with flipped EOLs; a content hash built
    // on eolNormalize must treat CRLF/LF variants as identical, or every mark dies on checkout.
    @Test fun eolNormalize_crlfAndLfVariantsAreIdentical() {
        val lf = "const x = 1;\nconst y = 2;\n".toByteArray()
        val crlf = "const x = 1;\r\nconst y = 2;\r\n".toByteArray()
        assertEquals(String(VettyParse.eolNormalize(lf)), String(VettyParse.eolNormalize(crlf)))
        assertEquals("a\nb\n", String(VettyParse.eolNormalize("a\r\nb\r\n".toByteArray())))   // CRLF → LF
        assertEquals("a\nb", String(VettyParse.eolNormalize("a\rb".toByteArray())))           // lone CR → LF
        assertEquals("a\n\nb", String(VettyParse.eolNormalize("a\r\r\nb".toByteArray())))     // CR then CRLF
        assertEquals("a\nb\n", String(VettyParse.eolNormalize("a\nb\n".toByteArray())))       // LF untouched
    }

    @Test fun eolNormalize_preservesNonEolBytes() {
        val bytes = byteArrayOf(-1, 0, 0x0d, 0x0a, -16, -97, -114, -119)   // binary + UTF-8 emoji around a CRLF
        val expect = byteArrayOf(-1, 0, 0x0a, -16, -97, -114, -119)
        assertEquals(expect.toList(), VettyParse.eolNormalize(bytes).toList())
    }
}
