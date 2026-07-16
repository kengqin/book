plugins {
    id("org.jetbrains.intellij.platform") version "2.5.0"
    kotlin("jvm") version "2.1.20"
}

group = "com.kengqin.novellibrary"
version = "0.4.0"

repositories { mavenCentral(); intellijPlatform { defaultRepositories() } }
dependencies { intellijPlatform { intellijIdeaCommunity("2024.1") } }

intellijPlatform { pluginConfiguration { ideaVersion { sinceBuild = "241" }; changeNotes = "Novel Library IDE reader and local Bridge sync." } }
