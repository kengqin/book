import org.gradle.api.initialization.resolve.RepositoriesMode

pluginManagement { repositories { gradlePluginPortal(); mavenCentral() } }
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        mavenCentral()
        intellijPlatform { defaultRepositories() }
    }
}
rootProject.name = "novel-library-intellij"
