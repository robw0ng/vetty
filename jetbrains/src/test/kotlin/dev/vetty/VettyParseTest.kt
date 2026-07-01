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

    @Test fun exportComments_formatsFileLineBody() {
        val c = VettyStateService.Comment().apply { file = "src/a.kt"; line = 4; body = "fix this" }
        assertEquals("src/a.kt:5 — fix this", VettyParse.exportComments(listOf(c)))
    }
}
