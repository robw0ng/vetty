plugins {
    kotlin("jvm") version "2.2.0"
    id("org.jetbrains.intellij.platform") version "2.1.0"
}

group = "dev.vetty"
version = providers.gradleProperty("pluginVersion").get()

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
            sinceBuild = "233"   // 2023.3+
            untilBuild = "252.*"
        }
    }
}

kotlin {
    jvmToolchain(17)
}
