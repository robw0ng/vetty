plugins {
    kotlin("jvm") version "2.2.0"
    id("org.jetbrains.intellij.platform") version "2.1.0"
}

group = "dev.vetty"
// Single source of truth: track the VS Code extension's version (../package.json) so the Rider zip
// and the VSIX always share release numbers. Falls back to the gradle.properties pluginVersion.
version = Regex("\"version\"\\s*:\\s*\"([^\"]+)\"")
    .find(rootProject.file("../package.json").readText())?.groupValues?.get(1)
    ?: providers.gradleProperty("pluginVersion").get()

repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}

dependencies {
    intellijPlatform {
        // Build against Rider. To build against IntelliJ IDEA Community instead
        // (smaller download, plugin still loads in Rider), swap for:
        //   intellijIdeaCommunity(providers.gradleProperty("platformVersion").get())
        rider(providers.gradleProperty("platformVersion").get())
        bundledPlugin("Git4Idea")                          // git repo-change events for instant refresh
        bundledModule("intellij.platform.vcs.dvcs.impl")   // dvcs Repository supertype of GitRepository
    }
    testImplementation("junit:junit:4.13.2")
}

intellijPlatform {
    instrumentCode = false        // no GUI forms / @NotNull instrumentation needed
    buildSearchableOptions = false // no settings UI to index
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "233"           // 2023.3+
            untilBuild = provider { null } // no upper bound — loads in current + future IDEs (2026+ etc.)
        }
    }
}

kotlin {
    jvmToolchain(17)
}
