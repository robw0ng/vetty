plugins {
    // Auto-provisions a JDK 17 toolchain if the build JVM differs.
    id("org.gradle.toolchains.foojay-resolver-convention") version "0.8.0"
}

rootProject.name = "vetty-rider"
