import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("org.jetbrains.intellij.platform") version "2.5.0"
    kotlin("jvm") version "2.1.20"
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_17
    }
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

group = "com.kengqin.novellibrary"
version = "0.4.15"

repositories {
    maven("https://packages.jetbrains.team/maven/p/ij/intellij-dependencies")
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}
dependencies {
    implementation("com.google.code.gson:gson:2.11.0")
    intellijPlatform { intellijIdeaCommunity("2024.1") }
}

intellijPlatform {
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "241"
            untilBuild = provider { null }
        }
        changeNotes = "修复切换小说或重新打开插件后从头开始的问题；进度写入改为串行，并在切书时刷新桌面端的最新章节与行位置。"
    }
}
