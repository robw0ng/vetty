package dev.vetty

import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage

/**
 * Persisted per-project state: chosen base branch, diff mode, viewed snapshots, comments.
 * Stored in .idea/vetty.xml via XmlSerializer — beans are plain mutable classes with defaults.
 */
@State(name = "Vetty", storages = [Storage("vetty.xml")])
@Service(Service.Level.PROJECT)
class VettyStateService : PersistentStateComponent<VettyStateService.S> {

    class Comment {
        var file: String = ""
        var line: Int = 0          // 0-based start line
        var span: Int = 0          // extra lines beyond start (0 = single line); end = line + span
        var anchor: String = ""    // trimmed text of the start line, for content re-anchoring
        var body: String = ""
    }

    class S {
        var base: String? = null                                   // mirror of the resolved base (sync reader)
        var baseByBranch: MutableMap<String, String> = LinkedHashMap()  // per-branch remembered base
        var diffRange: String = "branch"  // "branch" (merge-base) | "commit" (vs HEAD)
        var sinceReview: Boolean = true   // overlay: unviewed files diff against their last-reviewed snapshot
        var nested: Boolean = false       // tree (nested folders) vs flat list
        var hideWhitespace: Boolean = false  // hide files whose changes are whitespace-only
        var welcomed: Boolean = false     // first-run welcome dismissed
        // ponytail: viewed key is "base\trel" → git blob id. Flat Map<String,String> serializes
        // reliably (nested maps don't). The blob id IS the content hash and the since-review snapshot.
        var viewed: MutableMap<String, String> = LinkedHashMap()
        // Files the user "untracked" as noise (lockfiles, generated) → shown in the Untracked section. Keys: "base\trel".
        var ignored: MutableList<String> = ArrayList()
        var comments: MutableList<Comment> = ArrayList()
    }

    private var s = S()
    override fun getState(): S = s
    override fun loadState(state: S) { s = state }
}
