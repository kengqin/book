import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType

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
version = "0.5.2"

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
        changeNotes = "新增无需桌面端的本地 Runtime 模式、自定义数据目录、安全书库迁移、后台导入任务和崩溃自动恢复。"
    }
    pluginVerification {
        ides {
            ide(IntelliJPlatformType.IntellijIdeaCommunity, "2024.1")
        }
    }
}
