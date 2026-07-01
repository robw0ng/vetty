# Vetty for JetBrains (Rider)

Local code-review tool — a native port of the [Vetty VS Code extension](../README.md).
Pick a base branch; Vetty lists every changed file grouped Unviewed / Viewed / Untracked,
tracks what you've reviewed, shows only what's new since your last pass, and lets you leave
inline comments you can export back to an AI agent.

Works in Rider and every other JetBrains IDE (depends only on the platform, not Java/.NET modules).

## Features (v0.1)

- **Changed-files tool window** (right dock) — `git diff` vs the base branch + untracked files, with `+/-` counts.
- **Auto base branch** — defaults to `main`/`master`/`develop`; change via the branch button.
- **Viewed tracking** — mark a file viewed (snapshots a git blob); edit it and it re-flags unviewed automatically.
- **Two diff toggles** (see `../docs/DIFF_MODE_SPEC.md`): **Range** — whole branch (merge-base) ⇄ uncommitted (vs HEAD); **Compare** (last viewed / base) — unviewed files diff against their last-viewed snapshot instead of the range base.
- **Inline comments** — `Alt+Shift+C` (or right-click → Vetty: Add Comment) adds a gutter comment on the line/selection; click the gutter icon to edit/delete. Comments re-anchor by content when a file is rewritten. **Export Comments** copies all as `file:line — note`.
- **TODO scanner** — new TODO/FIXME/etc. introduced vs the base, in their own pane.
- **Track / Untrack** — push noise files (lockfiles, generated) into the Untracked section.
- **Auto-refresh** — the tree reloads on any file change, including out-of-editor agent edits; typing re-flags a viewed file unviewed instantly.

Keys in the tool window: `j`/`k` next/prev unviewed (opens diff), `v` toggle viewed, double-click opens a pinned diff.

Not ported: PR review (`gh`), in-panel text search, scope chips, hide-whitespace-only changes.

## Build & run

Requires JDK 17. Gradle comes via the wrapper (or use the one bundled in Rider).

```bash
cd jetbrains
gradle wrapper            # one-time: generates gradlew + the wrapper jar (skip if you'll use the IDE's Gradle)
./gradlew buildPlugin     # produces build/distributions/vetty-rider-0.1.0.zip
./gradlew runIde          # launch a sandbox IDE with the plugin
```

Install the built zip via **Settings ▸ Plugins ▸ ⚙ ▸ Install Plugin from Disk**, or unzip it into
`%APPDATA%\JetBrains\Rider<version>\plugins\` and restart.

Built & verified against **Rider 2025.2 (RD-252)** with Gradle 8.10.2 and Kotlin 2.2.0. The
platform is compiled with Kotlin metadata 2.2 — the build Kotlin version must match (2.2.x).
`instrumentCode` and `buildSearchableOptions` are disabled (unused, and the latter is flaky headless).

If the `platformVersion` in `gradle.properties` isn't downloadable, bump it to an available build,
or switch the dependency in `build.gradle.kts` to `intellijIdeaCommunity(...)` (smaller download;
still loads in Rider).

### Tests

`gradle test` currently trips a bug in IntelliJ Platform Gradle Plugin 2.1.0's Rider test launcher
(`Index: 1, Size: 1`). The pure-logic tests still compile and pass — run them directly:

```bash
./gradlew compileTestKotlin
java -cp "build/classes/kotlin/main;build/classes/kotlin/test;<junit>;<hamcrest>;<kotlin-stdlib>;<rider-lib>/*" \
     org.junit.runner.JUnitCore dev.vetty.VettyParseTest   # → OK (5 tests)
```

## How it maps to the VS Code version

| VS Code | JetBrains |
| --- | --- |
| Tree view + webview | `ToolWindow` + Swing `Tree` |
| Comments API | editor gutter `RangeHighlighter` + `GutterIconRenderer` |
| `globalState`/`workspaceState` | `PersistentStateComponent` (`.idea/vetty.xml`) |
| `vscode.diff` | `DiffManager.showDiff` |
| `git` via child_process | `git` via `GeneralCommandLine` + `ExecUtil` |
| `lib.js` pure helpers | `VettyParse` (unit-tested in `VettyParseTest`) |
