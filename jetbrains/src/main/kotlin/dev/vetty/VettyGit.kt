package dev.vetty

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.util.ExecUtil
import java.nio.charset.StandardCharsets

/** Runs `git` in the repo root ([root] = null → every call returns ""). Failures return "" / null: callers tolerate them. */
internal class VettyGit(private val root: () -> String?) {

    /** `git(args)` → stdout, or "" on any failure. */
    operator fun invoke(vararg args: String): String {
        val dir = root() ?: return ""
        // core.quotePath=false → paths with spaces/unicode come out raw (not "Ã¶…"), so they resolve.
        val cmd = GeneralCommandLine(mutableListOf("git", "-c", "core.quotePath=false", *args))
            .withWorkDirectory(dir)
            .withCharset(StandardCharsets.UTF_8)
        val t0 = System.currentTimeMillis()
        return try {
            val out = ExecUtil.execAndGetOutput(cmd)
            VettyService.dbg { "git ${args.take(4).joinToString(" ")}${if (args.size > 4) " …" else ""} — ${System.currentTimeMillis() - t0}ms" }
            if (out.exitCode == 0) out.stdout else ""
        } catch (e: Exception) {
            ""
        }
    }

    /** Run git feeding [input] on stdin (hash-object --stdin). */
    fun withInput(input: ByteArray, vararg args: String): String {
        val p = start(args) ?: return ""
        return try {
            p.outputStream.use { it.write(input) }
            val out = p.inputStream.readBytes().toString(Charsets.UTF_8)
            if (p.waitFor() == 0) out else ""
        } catch (e: Exception) { "" }
    }

    /** Raw bytes of [blob] — binary-safe, unlike ExecUtil's string stdout. */
    fun blobBytes(blob: String): ByteArray? {
        val p = start(arrayOf("cat-file", "blob", blob)) ?: return null
        return try {
            val out = p.inputStream.readBytes()
            if (p.waitFor() == 0) out else null
        } catch (e: Exception) { null }
    }

    // stderr is discarded so a chatty git can't fill the pipe and deadlock the stdout read.
    private fun start(args: Array<out String>): Process? {
        val dir = root() ?: return null
        return try {
            ProcessBuilder(listOf("git", *args))
                .directory(java.io.File(dir))
                .redirectError(ProcessBuilder.Redirect.DISCARD)
                .start()
        } catch (e: Exception) { null }
    }
}
