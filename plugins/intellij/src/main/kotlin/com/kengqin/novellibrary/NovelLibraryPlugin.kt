package com.kengqin.novellibrary

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorCustomElementRenderer
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.Inlay
import com.intellij.openapi.editor.event.CaretEvent
import com.intellij.openapi.editor.event.CaretListener
import com.intellij.openapi.editor.event.EditorFactoryEvent
import com.intellij.openapi.editor.event.EditorFactoryListener
import com.intellij.openapi.editor.ex.util.EditorUtil
import com.intellij.openapi.editor.markup.TextAttributes
import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.keymap.KeymapManager
import com.intellij.openapi.keymap.KeymapUtil
import com.intellij.openapi.keymap.impl.ui.KeymapPanel
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.content.ContentFactory
import java.awt.BorderLayout
import java.awt.AWTEvent
import java.awt.Container
import java.awt.Dimension
import java.awt.Font
import java.awt.FlowLayout
import java.awt.Graphics
import java.awt.Rectangle
import java.awt.Toolkit
import java.awt.event.AWTEventListener
import java.awt.event.MouseEvent
import java.awt.event.MouseWheelEvent
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Duration
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.WeakHashMap
import javax.swing.BorderFactory
import javax.swing.JButton
import javax.swing.JCheckBox
import javax.swing.JComboBox
import javax.swing.JFileChooser
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JScrollPane
import javax.swing.JTextArea
import javax.swing.JTextField
import javax.swing.BoxLayout
import javax.swing.SwingUtilities
import javax.swing.filechooser.FileNameExtensionFilter
import kotlin.math.roundToInt

private const val INLINE_CHAPTER_CONTROLS_ENABLED = false

data class BridgeConfig(val port: Int, val token: String, val providerType: String = "desktop", val storageId: String? = null, val sessionId: String? = null)
data class BookOption(val id: String, val title: String, val currentChapter: Int?, val chapterProgress: Double, val revision: Long = 0) { override fun toString() = title }
data class PendingProgressRecord(val key: String, val route: String, val payload: String)
class BridgeRequestException(val code: String?, message: String) : RuntimeException(message)
data class ChapterOption(val number: Int, val title: String, val kind: String?, val ordinal: Int = 0) {
    override fun toString() = if (ordinal > 0) "第 $ordinal 章 · $title" else title
}
data class ChapterContent(val number: Int, val title: String, val text: String)

class WrapLayout(align: Int, hgap: Int, vgap: Int) : FlowLayout(align, hgap, vgap) {
    override fun preferredLayoutSize(target: Container): Dimension = layoutSize(target, true)

    override fun minimumLayoutSize(target: Container): Dimension = layoutSize(target, false).apply {
        width -= hgap + 1
    }

    private fun layoutSize(target: Container, preferred: Boolean): Dimension = synchronized(target.treeLock) {
        val insets = target.insets
        val horizontalInsets = insets.left + insets.right + hgap * 2
        val availableWidth = if (target.width > 0) target.width - horizontalInsets else Int.MAX_VALUE
        val result = Dimension(0, 0)
        var rowWidth = 0
        var rowHeight = 0

        target.components.filter { it.isVisible }.forEach { component ->
            val size = if (preferred) component.preferredSize else component.minimumSize
            if (rowWidth > 0 && rowWidth + hgap + size.width > availableWidth) {
                result.width = maxOf(result.width, rowWidth)
                result.height += rowHeight + vgap
                rowWidth = 0
                rowHeight = 0
            }
            if (rowWidth > 0) rowWidth += hgap
            rowWidth += size.width
            rowHeight = maxOf(rowHeight, size.height)
        }

        result.width = maxOf(result.width, rowWidth) + horizontalInsets
        result.height += rowHeight + insets.top + insets.bottom + vgap * 2
        result
    }
}

fun readerTextWidth(editor: Editor, text: String): Int = text.sumOf { char ->
    EditorUtil.fontForChar(char, Font.PLAIN, editor).charWidth(char.code)
}

fun drawReaderText(editor: Editor, graphics: Graphics, text: String, x: Int, baseline: Int) {
    var currentX = x
    text.forEach { char ->
        val font = EditorUtil.fontForChar(char, Font.PLAIN, editor)
        graphics.font = font.font
        graphics.drawString(char.toString(), currentX, baseline)
        currentX += font.charWidth(char.code)
    }
}

fun displayLines(text: String): List<String> {
    val result = mutableListOf<String>()
    text.replace("\r", "").split(Regex("\n+")).forEach { paragraph ->
        val line = StringBuilder()
        paragraph.trim().forEach { char ->
            line.append(char)
            if (line.length >= 42 || (line.length >= 18 && char in "，。！？；：、,.!?;:")) {
                result.add(line.toString())
                line.clear()
            }
        }
        if (line.isNotEmpty()) result.add(line.toString())
    }
    return result.filter(String::isNotBlank)
}

fun lineStartFromProgress(lineCount: Int, progress: Double): Int {
    val maximumStart = maxOf(0, lineCount - 5)
    return (maximumStart * progress.coerceIn(0.0, 100.0) / 100.0)
        .roundToInt()
        .coerceIn(0, maximumStart)
}

object LibraryModeSettings {
    private const val USE_DESKTOP = "novelLibrary.useDesktopLibrary"
    private const val LOCAL_DIRECTORY = "novelLibrary.localDataDirectory"
    private const val LOG_LEVEL = "novelLibrary.logLevel"
    private const val RETAIN_MANAGED_SOURCE = "novelLibrary.retainManagedSource"
    private const val PENDING_PROGRESS = "novelLibrary.pendingProgress.v1"
    private const val DESKTOP_STORAGE_ID = "novelLibrary.desktopStorageId"
    private const val LOCAL_STORAGE_IDS = "novelLibrary.localStorageIds.v1"
    private val progressClientId = "jetbrains-${UUID.randomUUID()}"
    private val progressSequence = AtomicLong()

    private fun settings() = PropertiesComponent.getInstance()

    fun useDesktopLibrary(): Boolean = System.getenv("NOVEL_LIBRARY_USE_DESKTOP_LIBRARY")
        ?.trim()?.lowercase()?.let { value ->
            when (value) {
                "1", "true", "yes" -> true
                "0", "false", "no" -> false
                else -> null
            }
        } ?: settings().getBoolean(USE_DESKTOP, true)

    fun setUseDesktopLibrary(value: Boolean) = settings().setValue(USE_DESKTOP, value, true)

    fun logLevel(): String = System.getenv("NOVEL_LIBRARY_LOG_LEVEL")
        ?.trim()?.lowercase()?.takeIf { it in setOf("error", "warn", "info", "debug") }
        ?: settings().getValue(LOG_LEVEL, "info")

    fun setLogLevel(value: String) {
        val normalized = value.trim().lowercase().ifEmpty { "info" }
        require(normalized in setOf("error", "warn", "info", "debug")) { "日志级别必须是 error、warn、info 或 debug" }
        settings().setValue(LOG_LEVEL, normalized, "info")
    }

    fun retainManagedSource(): Boolean = System.getenv("NOVEL_LIBRARY_RETAIN_MANAGED_SOURCE")
        ?.trim()?.lowercase()?.let { it !in setOf("0", "false", "no") }
        ?: settings().getBoolean(RETAIN_MANAGED_SOURCE, true)

    fun setRetainManagedSource(value: Boolean) = settings().setValue(RETAIN_MANAGED_SOURCE, value, true)

    fun defaultLocalDirectory(): Path {
        val root = System.getenv("LOCALAPPDATA") ?: System.getenv("APPDATA") ?: System.getProperty("user.home")
        return Path.of(root, "NovelLibrary", "local-data")
    }

    fun localDirectory(): Path = System.getenv("NOVEL_LIBRARY_DATA_DIRECTORY")
        ?.trim()?.takeIf { it.isNotEmpty() }?.let(Path::of)
        ?: settings().getValue(LOCAL_DIRECTORY)?.trim()?.takeIf { it.isNotEmpty() }?.let { Path.of(it) }
        ?: defaultLocalDirectory()

    fun progressIdentity(): Pair<String, Long> = progressClientId to progressSequence.incrementAndGet()

    private fun localLocator(): String = localDirectory().toAbsolutePath().normalize().toString().lowercase()

    private fun legacyProgressProviderKey(): String = if (useDesktopLibrary()) "desktop" else "local:${localLocator()}"

    @Synchronized
    fun rememberProgressStorageId(providerType: String, storageId: String) {
        if (storageId.isBlank()) return
        if (providerType == "desktop") {
            settings().setValue(DESKTOP_STORAGE_ID, storageId)
            return
        }
        if (providerType == "local") {
            val root = runCatching { JsonParser.parseString(settings().getValue(LOCAL_STORAGE_IDS, "{}")).asJsonObject }
                .getOrElse { JsonObject() }
            root.addProperty(localLocator(), storageId)
            settings().setValue(LOCAL_STORAGE_IDS, root.toString(), "{}")
        }
    }

    fun progressProviderKey(): String = if (useDesktopLibrary()) {
        "desktop:${settings().getValue(DESKTOP_STORAGE_ID)?.takeIf { it.isNotBlank() } ?: "unresolved"}"
    } else {
        val discoveryStorageId = runCatching {
            val discovery = localDirectory().resolve("local-runtime.json")
            JsonParser.parseString(Files.readString(discovery)).asJsonObject.get("storageId")?.asString
        }.getOrNull()?.takeIf { it.isNotBlank() }
        val rememberedStorageId = runCatching {
            JsonParser.parseString(settings().getValue(LOCAL_STORAGE_IDS, "{}")).asJsonObject
                .get(localLocator())?.asString
        }.getOrNull()?.takeIf { it.isNotBlank() }
        "local:${discoveryStorageId ?: rememberedStorageId ?: "unresolved"}"
    }

    @Synchronized
    fun pendingProgress(): List<PendingProgressRecord> = runCatching {
        val root = JsonParser.parseString(settings().getValue(PENDING_PROGRESS, "{}")).asJsonObject
        val prefix = "${progressProviderKey()}::"
        val legacyKey = legacyProgressProviderKey()
        root.entrySet().mapNotNull { (key, element) ->
            if ((!key.startsWith(prefix) && key != legacyKey) || !element.isJsonObject) return@mapNotNull null
            val value = element.asJsonObject
            PendingProgressRecord(
                key,
                value.get("route")?.asString ?: return@mapNotNull null,
                value.get("payload")?.asString ?: return@mapNotNull null
            )
        }
    }.getOrDefault(emptyList())

    @Synchronized
    fun savePendingProgress(bookId: String, route: String, payload: String) {
        val root = runCatching { JsonParser.parseString(settings().getValue(PENDING_PROGRESS, "{}")).asJsonObject }
            .getOrElse { JsonObject() }
        root.add("${progressProviderKey()}::$bookId", JsonObject().apply {
            addProperty("route", route)
            addProperty("payload", payload)
            addProperty("savedAt", System.currentTimeMillis())
        })
        val trimmed = JsonObject()
        root.entrySet()
            .sortedByDescending { (_, value) -> runCatching { value.asJsonObject.get("savedAt")?.asLong ?: 0L }.getOrDefault(0L) }
            .take(100)
            .forEach { (key, value) -> trimmed.add(key, value) }
        settings().setValue(PENDING_PROGRESS, trimmed.toString(), "{}")
    }

    @Synchronized
    fun clearPendingProgress(key: String) {
        val root = runCatching { JsonParser.parseString(settings().getValue(PENDING_PROGRESS, "{}")).asJsonObject }
            .getOrElse { JsonObject() }
        root.remove(key)
        settings().setValue(PENDING_PROGRESS, root.toString(), "{}")
    }

    @Synchronized
    fun clearPendingProgressForBook(bookId: String) {
        val root = runCatching { JsonParser.parseString(settings().getValue(PENDING_PROGRESS, "{}")).asJsonObject }
            .getOrElse { JsonObject() }
        root.remove("${progressProviderKey()}::$bookId")
        root.remove(legacyProgressProviderKey())
        settings().setValue(PENDING_PROGRESS, root.toString(), "{}")
    }

    fun beginMigration(directory: Path = localDirectory()): Path {
        val root = directory.toAbsolutePath().normalize()
        Files.createDirectories(root)
        val lock = root.resolve("migration.lock")
        if (Files.exists(lock)) {
            val age = System.currentTimeMillis() - Files.getLastModifiedTime(lock).toMillis()
            if (age < 10 * 60 * 1000) error("本地书库正在被其他客户端迁移")
            Files.deleteIfExists(lock)
        }
        Files.writeString(lock, "${ProcessHandle.current().pid()}:${System.currentTimeMillis()}", java.nio.file.StandardOpenOption.CREATE_NEW)
        return lock
    }

    fun endMigration(lock: Path?) {
        if (lock != null) Files.deleteIfExists(lock)
    }

    fun setLocalDirectory(directory: Path, copyFrom: Path? = null): Path {
        val target = directory.toAbsolutePath().normalize()
        val sourceRoot = copyFrom?.toAbsolutePath()?.normalize()
        if (sourceRoot != null && sourceRoot != target && (sourceRoot.startsWith(target) || target.startsWith(sourceRoot))) {
            throw IllegalArgumentException("本地书库目录不能是源目录或其子目录")
        }
        Files.createDirectories(target)
        if (sourceRoot != null && Files.isRegularFile(sourceRoot.resolve("library.db")) && !Files.exists(target.resolve("library.db"))) {
            val ignored = setOf("runtime.lock", "migration.lock", "local-runtime.json", "local-runtime.json.tmp")
            Files.walk(sourceRoot).use { paths ->
                paths.forEach { source ->
                    if (source.fileName.toString() in ignored) return@forEach
                    val relative = sourceRoot.relativize(source)
                    val destination = target.resolve(relative)
                    if (Files.isDirectory(source)) Files.createDirectories(destination)
                    else Files.copy(source, destination)
                }
            }
        }
        settings().setValue(LOCAL_DIRECTORY, target.toString())
        return target
    }
}

class NovelLibraryApplicationConfigurable : Configurable {
    private var panel: JPanel? = null
    private var useDesktop: JCheckBox? = null
    private var localDirectory: JTextField? = null
    private var logLevel: JComboBox<String>? = null
    private var retainManagedSource: JCheckBox? = null

    override fun getDisplayName() = "小说书库"

    override fun createComponent(): JPanel {
        useDesktop = JCheckBox("使用桌面端书库")
        localDirectory = JTextField()
        logLevel = JComboBox(arrayOf("error", "warn", "info", "debug"))
        retainManagedSource = JCheckBox("导入时保留受管源文件（用于重新解析）")
        panel = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            add(useDesktop)
            add(JLabel("本地书库数据目录"))
            add(localDirectory)
            add(JLabel("Runtime 日志级别"))
            add(logLevel)
            add(retainManagedSource)
        }
        reset()
        return panel!!
    }

    override fun isModified(): Boolean =
        useDesktop?.isSelected != LibraryModeSettings.useDesktopLibrary() ||
            localDirectory?.text?.trim() != LibraryModeSettings.localDirectory().toString() ||
            logLevel?.selectedItem?.toString() != LibraryModeSettings.logLevel() ||
            retainManagedSource?.isSelected != LibraryModeSettings.retainManagedSource()

    override fun apply() {
        val current = LibraryModeSettings.localDirectory().toAbsolutePath().normalize()
        val requested = Path.of(localDirectory?.text?.trim().orEmpty()).toAbsolutePath().normalize()
        if (requested != current) {
            val lock = LibraryModeSettings.beginMigration(current)
            try {
                BridgeClient.shutdownLocalRuntime()
                LibraryModeSettings.setLocalDirectory(requested, current)
            } finally {
                LibraryModeSettings.endMigration(lock)
            }
        }
        LibraryModeSettings.setUseDesktopLibrary(useDesktop?.isSelected ?: true)
        LibraryModeSettings.setLogLevel(logLevel?.selectedItem?.toString().orEmpty())
        LibraryModeSettings.setRetainManagedSource(retainManagedSource?.isSelected ?: true)
    }

    override fun reset() {
        useDesktop?.isSelected = LibraryModeSettings.useDesktopLibrary()
        localDirectory?.text = LibraryModeSettings.localDirectory().toString()
        logLevel?.selectedItem = LibraryModeSettings.logLevel()
        retainManagedSource?.isSelected = LibraryModeSettings.retainManagedSource()
    }

    override fun disposeUIResources() {
        panel = null
        useDesktop = null
        localDirectory = null
        logLevel = null
        retainManagedSource = null
    }
}

object BridgeClient {
    private const val BUNDLED_RUNTIME_VERSION = "1.0.1"
    private const val CLIENT_PROTOCOL_VERSION = 2
    private val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build()
    private var cachedInstalledBridge: java.nio.file.Path? = null
    private var localProcess: Process? = null
    private var validatedLocalKey: String? = null
    private var validatedDesktopKey: String? = null

    fun stopLocalRuntime() {
        localProcess?.takeIf { it.isAlive }?.let { process ->
            process.destroy()
            runCatching { process.waitFor(2, TimeUnit.SECONDS) }
        }
        localProcess = null
        validatedLocalKey = null
    }

    fun shutdownLocalRuntime() {
        val discovery = localDiscovery()
        runCatching {
            val config = readLocalConfig()
            val request = HttpRequest.newBuilder(URI("http://127.0.0.1:${config.port}/v2/runtime/restart"))
                .timeout(Duration.ofSeconds(2))
                .header("Authorization", "Bearer ${config.token}")
                .POST(HttpRequest.BodyPublishers.noBody())
                .build()
            client.send(request, HttpResponse.BodyHandlers.discarding())
            repeat(40) {
                if (!Files.exists(discovery)) return@runCatching
                Thread.sleep(50)
            }
        }
        stopLocalRuntime()
        val active = runCatching { readLocalConfig() }.getOrNull()
        if (active != null && validateLocalConfig(active)) error("本地 Runtime 仍在运行，无法安全迁移数据目录")
    }

    private fun installedBridge(): java.nio.file.Path? {
        cachedInstalledBridge?.takeIf(java.nio.file.Files::isRegularFile)?.let { return it }
        cachedInstalledBridge = ProcessHandle.allProcesses().iterator().asSequence()
            .mapNotNull { it.info().command().orElse(null) }
            .firstOrNull { command ->
                val name = java.nio.file.Path.of(command).fileName.toString().lowercase()
                name == "novel-library-desktop.exe" || name == "novellibrary.exe"
            }
            ?.let { command -> java.nio.file.Path.of(command).resolveSibling("bridge.json") }
            ?.takeIf(java.nio.file.Files::isRegularFile)
        return cachedInstalledBridge
    }

    private fun localDiscovery(): Path = LibraryModeSettings.localDirectory().resolve("local-runtime.json")

    private fun runtimeSha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes).joinToString("") { "%02x".format(it) }

    private fun reportedRuntimeVersion(executable: Path): String? = runCatching {
        val process = ProcessBuilder(executable.toString(), "version").redirectErrorStream(true).start()
        if (!process.waitFor(3, TimeUnit.SECONDS)) {
            process.destroyForcibly()
            return@runCatching null
        }
        if (process.exitValue() != 0) null else process.inputStream.bufferedReader().use { it.readText().trim() }
    }.getOrNull()

    private fun validateRuntimeExecutable(executable: Path, version: String, hash: String): Boolean = runCatching {
        Files.isRegularFile(executable) && runtimeSha256(Files.readAllBytes(executable)) == hash && reportedRuntimeVersion(executable) == version
    }.getOrDefault(false)

    private fun compareRuntimeVersions(left: String, right: String): Int {
        val a = left.substringBefore('+').substringBefore('-').split('.').map { it.toIntOrNull() ?: 0 }
        val b = right.substringBefore('+').substringBefore('-').split('.').map { it.toIntOrNull() ?: 0 }
        repeat(3) { index ->
            val comparison = (a.getOrElse(index) { 0 }).compareTo(b.getOrElse(index) { 0 })
            if (comparison != 0) return comparison
        }
        return 0
    }

    private fun sharedRuntimeRoot(): Path = (System.getenv("LOCALAPPDATA")?.let(Path::of)
        ?: Path.of(System.getProperty("user.home"), "AppData", "Local"))
        .resolve("NovelLibrary/runtime")

    private fun readActiveRuntime(root: Path): Pair<JsonObject, Path>? = runCatching {
        val active = JsonParser.parseString(Files.readString(root.resolve("active.json"))).asJsonObject
        val version = active.get("runtimeVersion")?.asString ?: return@runCatching null
        val hash = active.get("sha256")?.asString?.lowercase() ?: return@runCatching null
        if (!version.matches(Regex("\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?")) || !hash.matches(Regex("[a-f0-9]{64}"))) return@runCatching null
        val expected = root.resolve("versions").resolve(version).resolve("novel-library-runtime.exe").toAbsolutePath().normalize()
        val declared = Path.of(active.get("executable")?.asString ?: return@runCatching null).toAbsolutePath().normalize()
        if (declared != expected || !validateRuntimeExecutable(expected, version, hash)) return@runCatching null
        active to expected
    }.getOrNull()

    private fun isRuntimeCompatible(manifest: JsonObject): Boolean {
        val protocolVersion = manifest.get("protocolVersion")?.asInt ?: return false
        val minimumClient = manifest.get("minimumClientProtocolVersion")?.asInt ?: 1
        return protocolVersion >= CLIENT_PROTOCOL_VERSION && minimumClient <= CLIENT_PROTOCOL_VERSION
    }

    private fun acquireRuntimeInstallLock(root: Path): Path {
        Files.createDirectories(root)
        val lock = root.resolve("install.lock")
        repeat(100) {
            try {
                Files.writeString(lock, "${ProcessHandle.current().pid()}:${System.currentTimeMillis()}", StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)
                return lock
            } catch (error: java.nio.file.FileAlreadyExistsException) {
                runCatching {
                    if (System.currentTimeMillis() - Files.getLastModifiedTime(lock).toMillis() > 120_000) Files.deleteIfExists(lock)
                }
                Thread.sleep(50)
            }
        }
        error("等待共享 Runtime 安装锁超时")
    }

    private fun writeActiveRuntime(root: Path, payload: JsonObject) {
        val target = root.resolve("active.json")
        val temporary = root.resolve("active.json.${ProcessHandle.current().pid()}.${UUID.randomUUID()}.tmp")
        Files.writeString(temporary, payload.toString(), StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)
        try {
            Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (_: Exception) {
            Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING)
        }
    }

    private fun localRuntimeExecutable(): Path {
        val operatingSystem = System.getProperty("os.name").lowercase()
        val architecture = System.getProperty("os.arch").lowercase()
        if (!operatingSystem.contains("windows") || architecture !in setOf("amd64", "x86_64")) {
            error("本地 Runtime 当前支持 Windows x64；当前平台为 $operatingSystem-$architecture")
        }
        System.getenv("NOVEL_LIBRARY_RUNTIME")?.let(Path::of)?.takeIf(Files::isRegularFile)?.let { return it }
        val loader = BridgeClient::class.java.classLoader
        val runtimeBytes = loader.getResourceAsStream("runtime/win32-x64/novel-library-runtime.exe")
            ?.use { it.readBytes() } ?: error("插件内 Runtime 缺失，请重新安装插件")
        val sidecarHash = loader.getResourceAsStream("runtime/win32-x64/novel-library-runtime.exe.sha256")
            ?.bufferedReader()?.use { it.readText().trim().split(Regex("\\s+"))[0].lowercase() }
            ?: error("插件内 Runtime 缺少 SHA-256")
        val manifestText = loader.getResourceAsStream("runtime-manifest.json")
            ?.bufferedReader()?.use { it.readText() } ?: error("插件内 Runtime 缺少 manifest")
        val manifest = JsonParser.parseString(manifestText).asJsonObject
        val manifestHash = manifest.getAsJsonArray("artifacts")
            ?.firstOrNull { it.asJsonObject.get("platform")?.asString == "win32" && it.asJsonObject.get("arch")?.asString == "x64" }
            ?.asJsonObject?.get("sha256")?.asString?.lowercase() ?: error("Runtime manifest 缺少 Windows x64")
        val protocolVersion = manifest.get("protocolVersion")?.asInt ?: error("Runtime manifest 缺少协议版本")
        val minimumProtocolVersion = manifest.get("minimumProtocolVersion")?.asInt ?: 1
        val actualHash = runtimeSha256(runtimeBytes)
        if (manifest.get("runtimeVersion")?.asString != BUNDLED_RUNTIME_VERSION ||
            protocolVersion < CLIENT_PROTOCOL_VERSION || minimumProtocolVersion > CLIENT_PROTOCOL_VERSION ||
            minimumProtocolVersion > protocolVersion || actualHash != sidecarHash || actualHash != manifestHash) {
            error("插件内 Runtime 完整性校验失败")
        }
        val root = sharedRuntimeRoot()
        var lock: Path? = null
        try {
            lock = acquireRuntimeInstallLock(root)
            val active = readActiveRuntime(root)
            if (active != null && compareRuntimeVersions(active.first.get("runtimeVersion").asString, BUNDLED_RUNTIME_VERSION) > 0) {
                if (isRuntimeCompatible(active.first)) return active.second
                error("已安装的共享 Runtime 需要更新版插件，当前插件不会覆盖或终止它")
            }
            val versionDirectory = root.resolve("versions").resolve(BUNDLED_RUNTIME_VERSION)
            val target = versionDirectory.resolve("novel-library-runtime.exe")
            if (!validateRuntimeExecutable(target, BUNDLED_RUNTIME_VERSION, actualHash)) {
                val temporaryDirectory = root.resolve("versions").resolve(".$BUNDLED_RUNTIME_VERSION.${ProcessHandle.current().pid()}.${UUID.randomUUID()}.tmp")
                Files.createDirectories(temporaryDirectory)
                val temporaryRuntime = temporaryDirectory.resolve("novel-library-runtime.exe")
                Files.write(temporaryRuntime, runtimeBytes)
                Files.writeString(temporaryRuntime.resolveSibling("novel-library-runtime.exe.sha256"), "$actualHash  novel-library-runtime.exe\n")
                Files.writeString(temporaryDirectory.resolve("runtime-manifest.json"), manifestText)
                if (!validateRuntimeExecutable(temporaryRuntime, BUNDLED_RUNTIME_VERSION, actualHash)) error("共享 Runtime 临时制品校验失败")
                if (Files.exists(versionDirectory)) Files.move(versionDirectory, versionDirectory.resolveSibling("$BUNDLED_RUNTIME_VERSION.invalid.${System.currentTimeMillis()}"))
                try {
                    Files.move(temporaryDirectory, versionDirectory, StandardCopyOption.ATOMIC_MOVE)
                } catch (_: Exception) {
                    Files.move(temporaryDirectory, versionDirectory)
                }
            }
            val payload = JsonObject().apply {
                addProperty("schemaVersion", 1)
                addProperty("runtimeVersion", BUNDLED_RUNTIME_VERSION)
                addProperty("protocolVersion", protocolVersion)
                addProperty("minimumClientProtocolVersion", minimumProtocolVersion)
                addProperty("executable", target.toAbsolutePath().normalize().toString())
                addProperty("sha256", actualHash)
                active?.first?.get("runtimeVersion")?.asString?.takeIf { it != BUNDLED_RUNTIME_VERSION }
                    ?.let { addProperty("previousVersion", it) }
                    ?: active?.first?.get("previousVersion")?.asString?.let { addProperty("previousVersion", it) }
                addProperty("updatedAt", System.currentTimeMillis())
            }
            writeActiveRuntime(root, payload)
            return target
        } catch (error: Exception) {
            readActiveRuntime(root)?.takeIf { isRuntimeCompatible(it.first) }?.let { return it.second }
            throw error
        } finally {
            lock?.let { runCatching { Files.deleteIfExists(it) } }
        }
    }

    private fun readLocalConfig(): BridgeConfig {
        Files.createDirectories(LibraryModeSettings.localDirectory())
        val text = Files.readString(localDiscovery())
        val port = Regex(""""port"\s*:\s*(\d+)""").find(text)?.groupValues?.get(1)?.toInt() ?: error("Local Runtime port missing")
        val token = Regex(""""token"\s*:\s*"([^"]+)"""").find(text)?.groupValues?.get(1) ?: error("Local Runtime token missing")
        val storageId = Regex(""""storageId"\s*:\s*"([^"]+)"""").find(text)?.groupValues?.get(1)
        val sessionId = Regex(""""sessionId"\s*:\s*"([^"]+)"""").find(text)?.groupValues?.get(1)
        return BridgeConfig(port, token, "local", storageId, sessionId)
    }

    private fun validateLocalConfig(config: BridgeConfig): Boolean {
        val key = "${config.port}:${config.token}:${config.storageId.orEmpty()}:${LibraryModeSettings.localDirectory().toAbsolutePath().normalize()}"
        if (validatedLocalKey == key) return true
        val valid = runCatching {
        val headers = arrayOf("Authorization", "Bearer ${config.token}")
        val manifestRequest = HttpRequest.newBuilder(URI("http://127.0.0.1:${config.port}/v2/manifest"))
            .timeout(Duration.ofSeconds(2))
            .header(headers[0], headers[1])
            .GET()
            .build()
        val manifest = client.send(manifestRequest, HttpResponse.BodyHandlers.ofString())
        if (manifest.statusCode() !in 200..299) return@runCatching false
        val manifestJson = JsonParser.parseString(manifest.body()).asJsonObject
        if (manifestJson.get("providerType")?.asString != "local") return@runCatching false
        val protocolVersion = manifestJson.get("protocolVersion")?.asInt ?: return@runCatching false
        val minimumClient = manifestJson.get("minimumClientProtocolVersion")?.asInt ?: 1
        if (protocolVersion < CLIENT_PROTOCOL_VERSION || minimumClient > CLIENT_PROTOCOL_VERSION) return@runCatching false
        val manifestStorage = manifestJson.get("storageId")?.asString ?: return@runCatching false
        if (config.storageId != manifestStorage) return@runCatching false
        val capabilities = manifestJson.getAsJsonArray("capabilities")?.map { it.asString }?.toSet() ?: return@runCatching false
        if (!capabilities.containsAll(setOf("books.read", "chapters.read", "progress.v2", "import.jobs", "import.idempotency", "backup.transfer", "runtime.diagnostics", "runtime.check-database", "epub.structure.v2"))) return@runCatching false

        val statusRequest = HttpRequest.newBuilder(URI("http://127.0.0.1:${config.port}/v2/runtime/status"))
            .timeout(Duration.ofSeconds(2))
            .header(headers[0], headers[1])
            .GET()
            .build()
        val status = client.send(statusRequest, HttpResponse.BodyHandlers.ofString())
        if (status.statusCode() !in 200..299) return@runCatching false
        val statusJson = JsonParser.parseString(status.body()).asJsonObject
        val directory = statusJson.get("dataDirectory")?.asString ?: return@runCatching false
        if (statusJson.get("storageId")?.asString != manifestStorage || statusJson.get("protocolVersion")?.asInt != protocolVersion) return@runCatching false
        val matchesDirectory = Path.of(directory).toAbsolutePath().normalize() == LibraryModeSettings.localDirectory().toAbsolutePath().normalize()
        if (matchesDirectory) LibraryModeSettings.rememberProgressStorageId("local", manifestStorage)
        matchesDirectory
        }.getOrDefault(false)
        if (valid) validatedLocalKey = key
        return valid
    }

    private fun validateDesktopConfig(config: BridgeConfig): Boolean {
        val key = "${config.port}:${config.sessionId.orEmpty()}:${config.storageId.orEmpty()}:${config.token}"
        if (validatedDesktopKey == key) return true
        val valid = runCatching {
            val request = HttpRequest.newBuilder(URI("http://127.0.0.1:${config.port}/v1/manifest"))
                .timeout(Duration.ofSeconds(2))
                .header("Authorization", "Bearer ${config.token}")
                .GET()
                .build()
            val response = client.send(request, HttpResponse.BodyHandlers.ofString())
            if (response.statusCode() !in 200..299) return@runCatching false
            val manifest = JsonParser.parseString(response.body()).asJsonObject
            val providerType = manifest.get("providerType")?.takeUnless { it.isJsonNull }?.asString
            val protocolVersion = manifest.get("protocolVersion")?.asInt ?: return@runCatching false
            val minimumClient = manifest.get("minimumClientProtocolVersion")?.takeUnless { it.isJsonNull }?.asInt ?: 1
            val manifestSession = manifest.get("sessionId")?.takeUnless { it.isJsonNull }?.asString
            val manifestStorage = manifest.get("storageId")?.takeUnless { it.isJsonNull }?.asString ?: config.storageId
            val capabilities = manifest.getAsJsonArray("capabilities")?.map { it.asString }?.toSet() ?: return@runCatching false
            val validManifest = (providerType == null || providerType == "desktop") &&
                protocolVersion >= 1 && minimumClient <= CLIENT_PROTOCOL_VERSION &&
                capabilities.containsAll(setOf("books", "chapters", "progress")) &&
                (config.storageId == null || manifestStorage == null || config.storageId == manifestStorage) &&
                (config.sessionId == null || manifestSession == null || config.sessionId == manifestSession)
            if (validManifest && manifestStorage != null) LibraryModeSettings.rememberProgressStorageId("desktop", manifestStorage)
            validManifest
        }.getOrDefault(false)
        if (valid) validatedDesktopKey = key
        return valid
    }

    private fun ensureLocalRuntime() {
        val existing = runCatching { readLocalConfig() }.getOrNull()
        if (existing != null && validateLocalConfig(existing)) return
        if (existing != null && localRuntimeRequiresNewerClient(existing)) {
            error("本地 Runtime 需要更新版插件，当前插件不会覆盖或终止它")
        }
        if (existing != null) runCatching { shutdownLocalRuntime() }
        runCatching { Files.deleteIfExists(localDiscovery()) }
        stopLocalRuntime()
        if (localProcess?.isAlive != true) {
            val executable = localRuntimeExecutable()
            localProcess = ProcessBuilder(executable.toString(), "serve", "--data-dir", LibraryModeSettings.localDirectory().toString(), "--port", "0", "--log-level", LibraryModeSettings.logLevel())
                .redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                .start()
            localProcess?.inputStream?.close()
        }
        repeat(30) {
            val config = runCatching { readLocalConfig() }.getOrNull()
            if (config != null && validateLocalConfig(config)) return
            Thread.sleep(100)
        }
        error("本地书库 Runtime 启动超时：${LibraryModeSettings.localDirectory()}")
    }

    private fun localRuntimeRequiresNewerClient(config: BridgeConfig): Boolean = runCatching {
        val request = HttpRequest.newBuilder(URI("http://127.0.0.1:${config.port}/v2/manifest"))
            .timeout(Duration.ofSeconds(2))
            .header("Authorization", "Bearer ${config.token}")
            .GET()
            .build()
        val response = client.send(request, HttpResponse.BodyHandlers.ofString())
        if (response.statusCode() !in 200..299) return@runCatching false
        val manifest = JsonParser.parseString(response.body()).asJsonObject
        (manifest.get("minimumClientProtocolVersion")?.asInt ?: 1) > CLIENT_PROTOCOL_VERSION
    }.getOrDefault(false)

    private fun config(): BridgeConfig {
        if (!LibraryModeSettings.useDesktopLibrary()) {
            ensureLocalRuntime()
            return readLocalConfig()
        }
        val root = System.getenv("APPDATA") ?: error("APPDATA is not available")
        val legacyDirectory = java.nio.file.Path.of(root, "NovelLibrary")
        val legacyBridge = legacyDirectory.resolve("bridge.json")
        val bridgePath = installedBridge() ?: legacyBridge
        val text = java.nio.file.Files.readString(bridgePath)
        val port = Regex(""""port"\s*:\s*(\d+)""").find(text)?.groupValues?.get(1)?.toInt()
            ?: error("Bridge port missing")
        val token = Regex(""""token"\s*:\s*"([^"]+)"""").find(text)?.groupValues?.get(1)
            ?: error("Bridge token missing")
        val storageId = Regex(""""storageId"\s*:\s*"([^"]+)"""").find(text)?.groupValues?.get(1)
        val sessionId = Regex(""""sessionId"\s*:\s*"([^"]+)"""").find(text)?.groupValues?.get(1)
        val config = BridgeConfig(port, token, "desktop", storageId, sessionId)
        if (!validateDesktopConfig(config)) error("桌面端 Bridge 协议不兼容或会话已失效，请更新桌面端后重试")
        return config
    }

    private fun send(path: String, body: String? = null, method: String = if (body == null) "GET" else "POST"): String {
        var lastError = "Bridge request failed"
        var lastCode: String? = null
        val attempts = if (method == "GET") 3 else 1
        repeat(attempts) { attempt ->
            val config = config()
            val builder = HttpRequest.newBuilder(URI("http://127.0.0.1:${config.port}$path"))
                .timeout(Duration.ofSeconds(5))
                .header("Authorization", "Bearer ${config.token}")
            when (method) {
                "GET" -> builder.GET()
                "DELETE" -> builder.DELETE()
                else -> builder.header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body.orEmpty()))
            }
            val response = client.send(builder.build(), HttpResponse.BodyHandlers.ofString())
            if (response.statusCode() in 200..299) return response.body()
            val errorObject = runCatching {
                val error = JsonParser.parseString(response.body()).asJsonObject.get("error")
                if (error?.isJsonObject == true) error.asJsonObject else null
            }.getOrNull()
            lastCode = errorObject?.get("code")?.takeUnless { it.isJsonNull }?.asString
            val detail = errorObject?.get("message")?.takeUnless { it.isJsonNull }?.asString
                ?: runCatching { JsonParser.parseString(response.body()).asJsonObject.get("error")?.asString }.getOrNull()
            lastError = "Bridge request failed: ${response.statusCode()}${detail?.let { " · $it" }.orEmpty()}"
            if (attempt < attempts - 1) Thread.sleep(200)
        }
        throw BridgeRequestException(lastCode, lastError)
    }

    private fun bookOption(value: JsonObject) = BookOption(
        value["id"].asString,
        value["title"].asString,
        value.get("currentChapter")?.takeUnless { it.isJsonNull }?.asInt,
        value.get("chapterProgress")?.takeUnless { it.isJsonNull }?.asDouble ?: 0.0,
        value.get("revision")?.takeUnless { it.isJsonNull }?.asLong ?: 0L
    )

    private fun replayPendingProgress() {
        LibraryModeSettings.pendingProgress().forEach { pending ->
            try {
                send(pending.route, pending.payload)
                LibraryModeSettings.clearPendingProgress(pending.key)
            } catch (error: BridgeRequestException) {
                if (error.code == "PROGRESS_CONFLICT") LibraryModeSettings.clearPendingProgress(pending.key)
            } catch (_: Exception) {
                // Keep the record for the next replay attempt.
            }
        }
    }

    fun books(): List<BookOption> {
        replayPendingProgress()
        return JsonParser.parseString(send("/v1/books")).asJsonArray
            .map { item -> bookOption(item.asJsonObject) }
    }

    fun book(bookId: String): BookOption? {
        val id = URLEncoder.encode(bookId, StandardCharsets.UTF_8).replace("+", "%20")
        val value = JsonParser.parseString(send("/v1/books/$id"))
        return if (value.isJsonNull) null else bookOption(value.asJsonObject)
    }

    fun chapters(bookId: String): List<ChapterOption> {
        val id = URLEncoder.encode(bookId, StandardCharsets.UTF_8).replace("+", "%20")
        return JsonParser.parseString(send("/v1/books/$id/chapters")).asJsonArray.map { item ->
            val value = item.asJsonObject
            ChapterOption(
                value["number"].asInt,
                value["title"].asString,
                value.get("kind")?.takeUnless { it.isJsonNull }?.asString
            )
        }
    }

    fun chapter(bookId: String, number: Int): ChapterContent {
        val id = URLEncoder.encode(bookId, StandardCharsets.UTF_8).replace("+", "%20")
        val value = JsonParser.parseString(send("/v1/books/$id/chapters/$number")).asJsonObject
        val text = value.get("contentText")?.takeUnless { it.isJsonNull }?.asString
            ?: value.get("content")?.takeUnless { it.isJsonNull }?.asString.orEmpty()
        return ChapterContent(value["number"].asInt, value["title"].asString, text)
    }

    fun saveProgress(book: BookOption, chapterNumber: Int, chapterProgress: Double, lineIndex: Int): Long? {
        val payload = JsonObject().apply {
            addProperty("bookId", book.id)
            addProperty("chapterNumber", chapterNumber)
            addProperty("chapterProgress", chapterProgress)
        }
        val route = if (LibraryModeSettings.useDesktopLibrary()) "/v1/progress" else "/v2/progress"
        if (!LibraryModeSettings.useDesktopLibrary()) {
            val (clientId, sequence) = LibraryModeSettings.progressIdentity()
            payload.addProperty("baseRevision", book.revision)
            payload.addProperty("clientId", clientId)
            payload.addProperty("sequence", sequence)
            payload.addProperty("lineIndex", lineIndex)
        }
        replayPendingProgress()
        return try {
            val response = JsonParser.parseString(send(route, payload.toString())).asJsonObject
            LibraryModeSettings.clearPendingProgressForBook(book.id)
            response.get("revision")?.takeUnless { it.isJsonNull }?.asLong
        } catch (error: BridgeRequestException) {
            if (error.code == "PROGRESS_CONFLICT") {
                LibraryModeSettings.clearPendingProgressForBook(book.id)
                return book(book.id)?.revision ?: book.revision
            }
            LibraryModeSettings.savePendingProgress(book.id, route, payload.toString())
            throw error
        } catch (error: Exception) {
            LibraryModeSettings.savePendingProgress(book.id, route, payload.toString())
            throw error
        }
    }

    fun importFile(path: String): Boolean {
        if (LibraryModeSettings.useDesktopLibrary()) {
            send("/v1/import", JsonObject().apply { addProperty("path", path) }.toString())
            return false
        }
        val queued = JsonParser.parseString(send("/v2/import-jobs", JsonObject().apply {
            addProperty("path", path)
            addProperty("idempotencyKey", "jetbrains-${UUID.randomUUID()}")
            addProperty("retainSource", LibraryModeSettings.retainManagedSource())
        }.toString())).asJsonObject
        val jobId = queued.get("id")?.asString ?: error("导入任务编号缺失")
        waitForImportJob(jobId)
        return true
    }

    private fun waitForImportJob(jobId: String) {
        repeat(1500) {
            val job = JsonParser.parseString(send("/v2/import-jobs/${URLEncoder.encode(jobId, StandardCharsets.UTF_8)}")).asJsonObject
            when (job.get("state")?.asString) {
                "completed" -> return
                "failed", "cancelled" -> error(job.get("message")?.asString ?: "导入失败")
            }
            Thread.sleep(200)
        }
        error("导入任务等待超时")
    }

    fun deleteBook(bookId: String) {
        check(!LibraryModeSettings.useDesktopLibrary()) { "删除书籍仅适用于本地书库" }
        send("/v2/books/${URLEncoder.encode(bookId, StandardCharsets.UTF_8)}", method = "DELETE")
    }

    fun reparseBook(bookId: String) {
        check(!LibraryModeSettings.useDesktopLibrary()) { "重新解析仅适用于本地书库" }
        val queued = JsonParser.parseString(send("/v2/books/${URLEncoder.encode(bookId, StandardCharsets.UTF_8)}/reparse", "{}")).asJsonObject
        val jobId = queued.get("id")?.asString ?: error("重新解析任务编号缺失")
        waitForImportJob(jobId)
    }

    fun exportLibrary(path: String): JsonObject = JsonParser.parseString(send(
        "/v2/transfers/export",
        JsonObject().apply { addProperty("path", path) }.toString()
    )).asJsonObject

    fun importLibrary(path: String, strategy: String = "merge") {
        send("/v2/transfers/import", JsonObject().apply {
            addProperty("path", path)
            addProperty("strategy", strategy)
        }.toString())
    }

    fun diagnostics(): String {
        check(!LibraryModeSettings.useDesktopLibrary()) { "Runtime 诊断仅适用于本地书库" }
        return send("/v2/runtime/diagnostics")
    }
}

object ReaderPanels {
    private val panels = WeakHashMap<Project, NovelReaderPanel>()
    @Synchronized fun put(project: Project, panel: NovelReaderPanel) { panels[project] = panel }
    @Synchronized fun get(project: Project) = panels[project]

    fun show(project: Project, action: ((NovelReaderPanel) -> Unit)? = null) {
        ToolWindowManager.getInstance(project).getToolWindow("小说书库")?.show {
            get(project)?.let { panel -> action?.invoke(panel) }
        }
    }

}

class NovelLineInlayRenderer(private val line: String) : EditorCustomElementRenderer {
    private val display = "  // $line"

    override fun calcWidthInPixels(inlay: Inlay<*>): Int {
        return readerTextWidth(inlay.editor, display)
    }

    override fun paint(inlay: Inlay<*>, graphics: Graphics, targetRegion: Rectangle, textAttributes: TextAttributes) {
        val editor = inlay.editor
        graphics.color = com.intellij.ui.JBColor(0x6B7280, 0x8B949E)
        drawReaderText(editor, graphics, display, targetRegion.x, targetRegion.y + editor.ascent)
    }
}

enum class ReaderDisplayMode { PARAGRAPH, LINE_END }

object ReaderDisplaySettings {
    private const val KEY = "novelLibrary.displayMode"

    fun get(project: Project): ReaderDisplayMode =
        if (PropertiesComponent.getInstance(project).getValue(KEY, "paragraph") == "lineEnd") {
            ReaderDisplayMode.LINE_END
        } else {
            ReaderDisplayMode.PARAGRAPH
        }

    fun toggle(project: Project): ReaderDisplayMode {
        val next = if (get(project) == ReaderDisplayMode.PARAGRAPH) {
            ReaderDisplayMode.LINE_END
        } else {
            ReaderDisplayMode.PARAGRAPH
        }
        PropertiesComponent.getInstance(project).setValue(
            KEY,
            if (next == ReaderDisplayMode.PARAGRAPH) "paragraph" else "lineEnd"
        )
        return next
    }

    fun label(mode: ReaderDisplayMode) = if (mode == ReaderDisplayMode.PARAGRAPH) "段落模式" else "行尾模式"
}

object ReaderVisibilitySettings {
    private const val KEY = "novelLibrary.readerVisible"

    fun isVisible(project: Project): Boolean = PropertiesComponent.getInstance(project).getBoolean(KEY, true)

    fun toggle(project: Project): Boolean {
        val visible = !isVisible(project)
        PropertiesComponent.getInstance(project).setValue(KEY, visible, true)
        return visible
    }

    fun label(project: Project) = if (isVisible(project)) "关闭阅读" else "开启阅读"
}

class NovelParagraphInlayRenderer(private val line: String) : EditorCustomElementRenderer {
    override fun calcWidthInPixels(inlay: Inlay<*>): Int {
        val editor = inlay.editor
        val natural = readerTextWidth(editor, line) + 28
        val available = maxOf(180, editor.scrollingModel.visibleArea.width - 48)
        val preferred = (editor.scrollingModel.visibleArea.width * 0.7).toInt()
        return maxOf(natural, preferred).coerceAtMost(available)
    }

    override fun paint(inlay: Inlay<*>, graphics: Graphics, targetRegion: Rectangle, textAttributes: TextAttributes) {
        val editor = inlay.editor
        graphics.color = editor.colorsScheme.defaultBackground
        graphics.fillRect(targetRegion.x, targetRegion.y, targetRegion.width, targetRegion.height)
        graphics.color = editor.colorsScheme.defaultForeground
        drawReaderText(editor, graphics, line, targetRegion.x + 12, targetRegion.y + editor.ascent)
    }
}

class NovelHeaderInlayRenderer(
    private val header: String,
    private val mode: ReaderDisplayMode,
    private val hasPrevious: Boolean,
    private val hasNext: Boolean
) : EditorCustomElementRenderer {
    private val prefix get() = if (mode == ReaderDisplayMode.LINE_END) "  // " else ""
    private val previousButton = "[上一章]"
    private val nextButton = "[下一章]"

    private fun displayText() = if (INLINE_CHAPTER_CONTROLS_ENABLED) {
        "$prefix$header   $previousButton  $nextButton"
    } else {
        "$prefix$header"
    }

    override fun calcWidthInPixels(inlay: Inlay<*>): Int {
        val editor = inlay.editor
        val natural = readerTextWidth(editor, displayText()) + if (mode == ReaderDisplayMode.PARAGRAPH) 28 else 0
        if (mode == ReaderDisplayMode.LINE_END) return natural
        val available = maxOf(180, editor.scrollingModel.visibleArea.width - 48)
        val preferred = (editor.scrollingModel.visibleArea.width * 0.7).toInt()
        return maxOf(natural, preferred).coerceAtMost(available)
    }

    override fun paint(inlay: Inlay<*>, graphics: Graphics, targetRegion: Rectangle, textAttributes: TextAttributes) {
        val editor = inlay.editor
        if (mode == ReaderDisplayMode.PARAGRAPH) {
            graphics.color = editor.colorsScheme.defaultBackground
            graphics.fillRect(targetRegion.x, targetRegion.y, targetRegion.width, targetRegion.height)
        }
        val baseline = targetRegion.y + editor.ascent
        var x = targetRegion.x + if (mode == ReaderDisplayMode.PARAGRAPH) 12 else 0
        val heading = if (INLINE_CHAPTER_CONTROLS_ENABLED) "$prefix$header   " else "$prefix$header"
        graphics.color = if (mode == ReaderDisplayMode.LINE_END) {
            com.intellij.ui.JBColor(0x6B7280, 0x8B949E)
        } else editor.colorsScheme.defaultForeground
        drawReaderText(editor, graphics, heading, x, baseline)
        if (!INLINE_CHAPTER_CONTROLS_ENABLED) return
        x += readerTextWidth(editor, heading)
        graphics.color = navigationColor(hasPrevious)
        drawReaderText(editor, graphics, previousButton, x, baseline)
        x += readerTextWidth(editor, "$previousButton  ")
        graphics.color = navigationColor(hasNext)
        drawReaderText(editor, graphics, nextButton, x, baseline)
    }

    fun actionAt(editor: Editor, targetRegion: Rectangle, x: Int): Int? {
        if (!INLINE_CHAPTER_CONTROLS_ENABLED) return null
        val start = targetRegion.x + if (mode == ReaderDisplayMode.PARAGRAPH) 12 else 0
        val previousStart = start + readerTextWidth(editor, "$prefix$header   ")
        val previousEnd = previousStart + readerTextWidth(editor, previousButton)
        val nextStart = previousEnd + readerTextWidth(editor, "  ")
        val nextEnd = nextStart + readerTextWidth(editor, nextButton)
        return when {
            hasPrevious && x in previousStart until previousEnd -> -1
            hasNext && x in nextStart until nextEnd -> 1
            else -> null
        }
    }

    private fun navigationColor(enabled: Boolean) = if (enabled) {
        com.intellij.ui.JBColor(0x2563EB, 0x58A6FF)
    } else {
        com.intellij.ui.JBColor(0x9CA3AF, 0x6E7681)
    }
}

object NovelEditorOverlay {
    private val inlays = WeakHashMap<Editor, MutableList<Inlay<*>>>()
    private val headerInlays = WeakHashMap<Editor, Inlay<*>>()
    private val wheelListeners = WeakHashMap<Project, AWTEventListener>()
    private val clickListeners = WeakHashMap<Project, AWTEventListener>()
    private val visibleLines = WeakHashMap<Project, List<String>>()
    private val navigationState = WeakHashMap<Project, Pair<Boolean, Boolean>>()
    private val started = WeakHashMap<Project, Boolean>()

    @Synchronized
    fun start(project: Project) {
        if (started.put(project, true) == true) return
        EditorFactory.getInstance().eventMulticaster.addCaretListener(object : CaretListener {
            override fun caretPositionChanged(event: CaretEvent) {
                if (event.editor.project == project) refresh(project)
            }
        }, project)
        EditorFactory.getInstance().addEditorFactoryListener(object : EditorFactoryListener {
            override fun editorCreated(event: EditorFactoryEvent) {
                if (event.editor.project == project) refresh(project)
            }
        }, project)
        installWheelNavigation(project)
        if (INLINE_CHAPTER_CONTROLS_ENABLED) installHeaderNavigation(project)
    }

    @Synchronized
    fun show(project: Project, header: String, lines: List<String>, hasPrevious: Boolean, hasNext: Boolean) {
        visibleLines[project] = listOf(header) + lines.take(5)
        navigationState[project] = hasPrevious to hasNext
        refresh(project)
    }

    @Synchronized
    fun clear(project: Project) {
        visibleLines.remove(project)
        navigationState.remove(project)
        refresh(project)
    }

    fun toggleDisplayMode(project: Project): ReaderDisplayMode {
        val mode = ReaderDisplaySettings.toggle(project)
        refresh(project)
        return mode
    }

    fun toggleVisibility(project: Project): Boolean {
        val visible = ReaderVisibilitySettings.toggle(project)
        refresh(project)
        return visible
    }

    private fun installWheelNavigation(project: Project) {
        synchronized(this) { if (wheelListeners.containsKey(project)) return }
        val listener = AWTEventListener { rawEvent ->
            val event = rawEvent as? MouseWheelEvent ?: return@AWTEventListener
            val hasModifier = event.isControlDown || event.isAltDown || event.isShiftDown || event.isMetaDown
            if (event.wheelRotation != 0 && !hasModifier && ReaderVisibilitySettings.isVisible(project)) {
                val editor = EditorFactory.getInstance().allEditors.firstOrNull {
                    it.project == project && SwingUtilities.isDescendingFrom(event.component, it.component)
                } ?: return@AWTEventListener
                val point = SwingUtilities.convertPoint(event.component, event.point, editor.contentComponent)
                val overReader = synchronized(this) {
                    inlays[editor].orEmpty().any { it.bounds?.contains(point) == true }
                }
                if (overReader) {
                    event.consume()
                    ReaderSessions.get(project).moveLine(if (event.wheelRotation > 0) 1 else -1)
                }
            }
        }
        synchronized(this) { wheelListeners[project] = listener }
        Toolkit.getDefaultToolkit().addAWTEventListener(listener, AWTEvent.MOUSE_WHEEL_EVENT_MASK)
        Disposer.register(project) {
            Toolkit.getDefaultToolkit().removeAWTEventListener(listener)
            synchronized(this) { wheelListeners.remove(project) }
        }
    }

    private fun installHeaderNavigation(project: Project) {
        synchronized(this) { if (clickListeners.containsKey(project)) return }
        val listener = AWTEventListener { rawEvent ->
            val event = rawEvent as? MouseEvent ?: return@AWTEventListener
            if (event.id != MouseEvent.MOUSE_PRESSED || event.button != MouseEvent.BUTTON1) {
                return@AWTEventListener
            }
            val editor = EditorFactory.getInstance().allEditors.firstOrNull {
                it.project == project && SwingUtilities.isDescendingFrom(event.component, it.component)
            } ?: return@AWTEventListener
            val point = SwingUtilities.convertPoint(event.component, event.point, editor.contentComponent)
            val inlay = synchronized(this) { headerInlays[editor] } ?: return@AWTEventListener
            val bounds = inlay.bounds ?: return@AWTEventListener
            if (!bounds.contains(point)) return@AWTEventListener
            val renderer = inlay.renderer as? NovelHeaderInlayRenderer ?: return@AWTEventListener
            val direction = renderer.actionAt(editor, bounds, point.x) ?: return@AWTEventListener
            event.consume()
            ReaderSessions.get(project).moveChapter(direction)
        }
        synchronized(this) { clickListeners[project] = listener }
        Toolkit.getDefaultToolkit().addAWTEventListener(listener, AWTEvent.MOUSE_EVENT_MASK)
        Disposer.register(project) {
            Toolkit.getDefaultToolkit().removeAWTEventListener(listener)
            synchronized(this) { clickListeners.remove(project) }
        }
    }

    private fun refresh(project: Project) {
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            val lines = if (ReaderVisibilitySettings.isVisible(project)) {
                synchronized(this) { visibleLines[project].orEmpty() }
            } else {
                emptyList()
            }
            val navigation = synchronized(this) { navigationState[project] ?: (false to false) }
            EditorFactory.getInstance().allEditors.filter { it.project == project }.forEach { editor ->
                synchronized(this) { headerInlays.remove(editor) }
                synchronized(this) { inlays.remove(editor) }.orEmpty().forEach(Inlay<*>::dispose)
                if (lines.isEmpty() || editor.isDisposed) return@forEach
                val document = editor.document
                val count = minOf(lines.size, document.lineCount)
                val caretLine = editor.caretModel.logicalPosition.line
                val firstLine = caretLine.coerceAtMost(maxOf(0, document.lineCount - count))
                val created = mutableListOf<Inlay<*>>()
                val mode = ReaderDisplaySettings.get(project)
                repeat(count) { index ->
                    val lineNumber = firstLine + index
                    val inlay = if (index == 0) {
                        val renderer = NovelHeaderInlayRenderer(lines[index], mode, navigation.first, navigation.second)
                        if (mode == ReaderDisplayMode.PARAGRAPH) {
                            editor.inlayModel.addInlineElement(
                                document.getLineStartOffset(lineNumber),
                                false,
                                renderer
                            )
                        } else {
                            editor.inlayModel.addAfterLineEndElement(
                                document.getLineEndOffset(lineNumber),
                                true,
                                renderer
                            )
                        }
                    } else if (mode == ReaderDisplayMode.PARAGRAPH) {
                        editor.inlayModel.addInlineElement(
                            document.getLineStartOffset(lineNumber),
                            false,
                            NovelParagraphInlayRenderer(lines[index])
                        )
                    } else {
                        editor.inlayModel.addAfterLineEndElement(
                            document.getLineEndOffset(lineNumber),
                            true,
                            NovelLineInlayRenderer(lines[index])
                        )
                    }
                    inlay?.let { createdInlay ->
                        created.add(createdInlay)
                        if (index == 0) synchronized(this) { headerInlays[editor] = createdInlay }
                    }
                }
                synchronized(this) { inlays[editor] = created }
            }
        }
    }
}

data class ReaderSnapshot(
    val books: List<BookOption> = emptyList(),
    val selectedBook: BookOption? = null,
    val chapters: List<ChapterOption> = emptyList(),
    val currentChapter: ChapterContent? = null,
    val visibleLines: List<String> = emptyList(),
    val chapterOrdinal: Int = 0,
    val overallProgress: Double = 0.0,
    val status: String = "正在连接小说书库${if (LibraryModeSettings.useDesktopLibrary()) "桌面端" else "本地 Runtime"}..."
)

object ReaderSessions {
    private val sessions = WeakHashMap<Project, NovelReaderSession>()

    @Synchronized
    fun get(project: Project): NovelReaderSession = sessions.getOrPut(project) { NovelReaderSession(project) }
}

class NovelReaderSession(private val project: Project) {
    private data class ReaderPosition(val bookId: String, val chapterNumber: Int, val lineStart: Int)

    private var books = emptyList<BookOption>()
    private var selectedBook: BookOption? = null
    private var chapters = emptyList<ChapterOption>()
    private var currentChapter: ChapterContent? = null
    private var lines = emptyList<String>()
    private var lineStart = 0
    private var status = "正在连接小说书库${if (LibraryModeSettings.useDesktopLibrary()) "桌面端" else "本地 Runtime"}..."
    private var listener: ((ReaderSnapshot) -> Unit)? = null
    private var started = false
    private var requestVersion = 0
    private var reconnectAttempts = 0
    private val progressExecutor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "NovelLibrary-Progress").apply { isDaemon = true }
    }

    init {
        Disposer.register(project) { progressExecutor.shutdown() }
    }

    @Synchronized
    fun start() {
        if (started) return
        started = true
        NovelEditorOverlay.start(project)
        ApplicationManager.getApplication().invokeLater(::loadBooks)
    }

    fun attach(listener: (ReaderSnapshot) -> Unit) {
        this.listener = listener
        publish()
        start()
    }

    private fun background(retry: (() -> Unit)? = null, task: () -> Unit) {
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                task()
            } catch (error: Exception) {
                SwingUtilities.invokeLater {
                    if (retry != null && reconnectAttempts < 11) {
                        reconnectAttempts += 1
                        status = "连接中断，正在重试（$reconnectAttempts/11）..."
                        publish()
                        ApplicationManager.getApplication().executeOnPooledThread {
                            Thread.sleep(750)
                            SwingUtilities.invokeLater(retry)
                        }
                    } else {
                        status = "连接失败：${error.message ?: "未知错误"}"
                        publish()
                    }
                }
            }
        }
    }

    private fun chapterProgress(): Double = when {
        lines.isEmpty() -> 0.0
        lines.size <= 5 -> 100.0
        else -> lineStart.toDouble() / (lines.size - 5) * 100.0
    }

    private fun chapterIndex(): Int = currentChapter?.let { current ->
        chapters.indexOfFirst { it.number == current.number }
    } ?: -1

    private fun overallProgress(chapterIndex: Int = chapterIndex()): Double =
        if (chapterIndex >= 0 && chapters.isNotEmpty()) {
            ((chapterIndex + chapterProgress() / 100.0) / chapters.size * 100.0).coerceIn(0.0, 100.0)
        } else 0.0

    private fun chapterHeader(): String {
        val chapter = currentChapter ?: return "尚未加载章节 · 总进度 0.0%"
        val index = chapterIndex()
        return "第 ${index + 1}/${chapters.size} 章 · ${chapter.title} · 总进度 ${"%.1f".format(overallProgress(index))}%"
    }

    private fun chapterNavigation(): Pair<Boolean, Boolean> {
        val index = chapterIndex()
        return (index > 0) to (index >= 0 && index < chapters.lastIndex)
    }

    private fun snapshot(): ReaderSnapshot {
        val chapterIndex = chapterIndex()
        return ReaderSnapshot(
            books,
            selectedBook,
            chapters,
            currentChapter,
            if (lines.isEmpty()) emptyList() else lines.subList(lineStart, minOf(lines.size, lineStart + 5)),
            chapterIndex + 1,
            overallProgress(chapterIndex),
            status
        )
    }

    private fun publish() {
        listener?.invoke(snapshot())
    }

    private fun loadBooks(preservePosition: Boolean = false) {
        val position = if (preservePosition) {
            val book = selectedBook
            val chapter = currentChapter
            if (book != null && chapter != null) ReaderPosition(book.id, chapter.number, lineStart) else null
        } else null
        val version = ++requestVersion
        background({ loadBooks(preservePosition) }) {
            val result = BridgeClient.books()
            SwingUtilities.invokeLater {
                if (version != requestVersion) return@invokeLater
                reconnectAttempts = 0
                books = result
                if (result.isEmpty()) {
                    status = "${if (LibraryModeSettings.useDesktopLibrary()) "桌面端" else "本地"}书库中还没有小说"
                    NovelEditorOverlay.clear(project)
                    publish()
                } else {
                    val book = result.find { it.id == position?.bookId } ?: result.first()
                    loadChapters(book, position?.takeIf { it.bookId == book.id })
                }
            }
        }
    }

    fun selectBook(book: BookOption) {
        syncProgress()
        loadChapters(book)
    }

    private fun awaitProgressWrites() {
        progressExecutor.submit { }.get()
    }

    fun flushProgressWrites() {
        syncProgress()
        awaitProgressWrites()
    }

    private fun loadChapters(book: BookOption, position: ReaderPosition? = null) {
        val version = ++requestVersion
        selectedBook = book
        chapters = emptyList()
        currentChapter = null
        lines = emptyList()
        lineStart = 0
        status = "正在加载 ${book.title}..."
        NovelEditorOverlay.clear(project)
        publish()
        background({ loadChapters(book, position) }) {
            awaitProgressWrites()
            val latestBook = BridgeClient.book(book.id) ?: book
            val allChapters = BridgeClient.chapters(book.id)
            val readable = allChapters
                .filter { it.kind == null || it.kind == "chapter" }
                .ifEmpty { allChapters }
                .mapIndexed { index, chapter -> chapter.copy(ordinal = index + 1) }
            SwingUtilities.invokeLater {
                if (version != requestVersion) return@invokeLater
                reconnectAttempts = 0
                books = books.map { item -> if (item.id == latestBook.id) latestBook else item }
                selectedBook = latestBook
                chapters = readable
                val preferredChapter = position?.chapterNumber ?: latestBook.currentChapter
                val preferred = readable.find { it.number == preferredChapter } ?: readable.firstOrNull()
                if (preferred == null) {
                    status = "当前小说没有章节"
                    publish()
                } else {
                    val restoredLineStart = position?.takeIf { it.chapterNumber == preferred.number }?.lineStart
                    val restoredProgress = if (position == null && preferred.number == latestBook.currentChapter) {
                        latestBook.chapterProgress
                    } else null
                    loadChapter(
                        preferred,
                        restoredLineStart = restoredLineStart,
                        restoredProgress = restoredProgress
                    )
                }
            }
        }
    }

    fun selectChapter(chapter: ChapterOption) = loadChapter(chapter)

    private fun loadChapter(
        chapter: ChapterOption,
        direction: Int = 1,
        restoredLineStart: Int? = null,
        restoredProgress: Double? = null,
        startAtEnd: Boolean = false,
        keepCurrentOnEmpty: Boolean = false
    ) {
        val book = selectedBook ?: return
        val candidates = chapters
        val version = ++requestVersion
        status = "正在加载 ${chapter.title}..."
        publish()
        background({
            loadChapter(chapter, direction, restoredLineStart, restoredProgress, startAtEnd, keepCurrentOnEmpty)
        }) {
            var index = candidates.indexOfFirst { it.number == chapter.number }
            var result = BridgeClient.chapter(book.id, chapter.number)
            var resultLines = displayLines(result.text)
            var attempts = 1
            while (resultLines.isEmpty() && attempts < 30) {
                index += direction
                if (index !in candidates.indices) break
                result = BridgeClient.chapter(book.id, candidates[index].number)
                resultLines = displayLines(result.text)
                attempts += 1
            }
            SwingUtilities.invokeLater {
                if (version != requestVersion) return@invokeLater
                reconnectAttempts = 0
                if (keepCurrentOnEmpty && resultLines.isEmpty()) {
                    render()
                    return@invokeLater
                }
                currentChapter = result
                lines = resultLines
                val maximumStart = maxOf(0, resultLines.size - 5)
                lineStart = when {
                    result.number == chapter.number && restoredLineStart != null -> restoredLineStart
                    result.number == chapter.number && restoredProgress != null -> {
                        lineStartFromProgress(resultLines.size, restoredProgress)
                    }
                    startAtEnd -> maximumStart
                    else -> 0
                }.coerceIn(0, maximumStart)
                render()
                syncProgress()
            }
        }
    }

    private fun syncProgress() {
        val book = selectedBook ?: return
        val chapter = currentChapter ?: return
        if (lines.isEmpty()) return
        val progress = chapterProgress()
        val updatedBook = book.copy(currentChapter = chapter.number, chapterProgress = progress)
        books = books.map { item -> if (item.id == book.id) updatedBook else item }
        selectedBook = updatedBook
        progressExecutor.execute {
            try {
                val revision = BridgeClient.saveProgress(book, chapter.number, progress, lineStart)
                if (revision != null) {
                    SwingUtilities.invokeLater {
                        val current = selectedBook
                        if (current?.id == book.id && revision > current.revision) {
                            val revised = current.copy(revision = revision)
                            selectedBook = revised
                            books = books.map { item -> if (item.id == revised.id) revised else item }
                        }
                    }
                }
            } catch (error: Exception) {
                SwingUtilities.invokeLater {
                    if (!project.isDisposed) {
                        status = "进度同步失败：${error.message ?: "未知错误"}"
                        publish()
                    }
                }
            }
        }
    }

    private fun render() {
        val chapter = currentChapter ?: return
        val navigation = chapterNavigation()
        if (lines.isEmpty()) {
            status = "${chapter.title} · 当前章节没有可阅读的正文"
            NovelEditorOverlay.show(project, chapterHeader(), emptyList(), navigation.first, navigation.second)
        } else {
            val end = minOf(lines.size, lineStart + 5)
            status = "${chapter.title} · ${lineStart + 1}-$end / ${lines.size} 行"
            NovelEditorOverlay.show(
                project,
                chapterHeader(),
                lines.subList(lineStart, end),
                navigation.first,
                navigation.second
            )
        }
        publish()
    }

    fun moveLine(direction: Int) {
        if (direction == 0 || lines.isEmpty()) return
        val maximumStart = maxOf(0, lines.size - 5)
        val next = lineStart + direction
        if (next in 0..maximumStart) {
            lineStart = next
            render()
            syncProgress()
            return
        }
        moveToAdjacentChapter(direction, startAtEnd = direction < 0, keepCurrentOnEmpty = true)
    }

    fun moveChapter(direction: Int) {
        moveToAdjacentChapter(direction, startAtEnd = false, keepCurrentOnEmpty = false)
    }

    private fun moveToAdjacentChapter(direction: Int, startAtEnd: Boolean, keepCurrentOnEmpty: Boolean) {
        if (direction == 0 || chapters.isEmpty()) return
        val chapter = currentChapter ?: return
        val index = chapters.indexOfFirst { it.number == chapter.number }
        if (index < 0) return
        val next = (index + direction).coerceIn(0, chapters.lastIndex)
        if (next != index) {
            loadChapter(
                chapters[next],
                direction,
                startAtEnd = startAtEnd,
                keepCurrentOnEmpty = keepCurrentOnEmpty
            )
        }
    }

    fun reload() {
        reconnectAttempts = 0
        loadBooks(preservePosition = true)
    }

    fun resetForProviderSwitch() {
        requestVersion += 1
        reconnectAttempts = 0
        books = emptyList()
        selectedBook = null
        chapters = emptyList()
        currentChapter = null
        lines = emptyList()
        lineStart = 0
        status = "正在连接小说书库${if (LibraryModeSettings.useDesktopLibrary()) "桌面端" else "本地 Runtime"}..."
        NovelEditorOverlay.clear(project)
        publish()
        loadBooks(preservePosition = false)
    }

    fun currentBook(): BookOption? = selectedBook
}

class NovelStartupActivity : ProjectActivity {
    override suspend fun execute(project: Project) {
        ReaderSessions.get(project).start()
    }
}

class NovelReaderPanel(private val project: Project) : JPanel(BorderLayout()) {
    private val session = ReaderSessions.get(project)
    private val books = JComboBox<BookOption>()
    private val chapters = JComboBox<ChapterOption>()
    private val content = JTextArea(7, 36)
    private val chapterInfo = JLabel("尚未加载章节")
    private val previousChapter = JButton("上一章")
    private val nextChapter = JButton("下一章")
    private val status = JLabel("正在连接小说书库${if (LibraryModeSettings.useDesktopLibrary()) "桌面端" else "本地 Runtime"}...")
    private val displayMode = JButton(ReaderDisplaySettings.label(ReaderDisplaySettings.get(project)))
    private val readerVisibility = JButton(ReaderVisibilitySettings.label(project))
    private var updatingControls = false

    init {
        NovelEditorOverlay.start(project)
        val toolbar = JPanel(WrapLayout(FlowLayout.LEFT, 6, 5))
        val previousLine = JButton("上一行")
        val nextLine = JButton("下一行")
        val refresh = JButton("刷新")
        val libraryMode = JButton(if (LibraryModeSettings.useDesktopLibrary()) "桌面书库" else "本地书库")
        val localDirectory = JButton("本地目录")
        val importNovel = JButton("导入小说")
        val backup = JButton("备份")
        val restore = JButton("恢复")
        val reparse = JButton("重新解析")
        val deleteBook = JButton("删除")
        val diagnostics = JButton("诊断")
        val shortcuts = JButton("快捷键")
        val configureShortcuts = JButton("自定义快捷键")
        toolbar.add(books)
        toolbar.add(chapters)
        toolbar.add(previousLine)
        toolbar.add(nextLine)
        toolbar.add(refresh)
        toolbar.add(libraryMode)
        toolbar.add(localDirectory)
        toolbar.add(importNovel)
        toolbar.add(backup)
        toolbar.add(restore)
        toolbar.add(reparse)
        toolbar.add(deleteBook)
        toolbar.add(diagnostics)
        toolbar.add(displayMode)
        toolbar.add(readerVisibility)
        toolbar.add(shortcuts)
        toolbar.add(configureShortcuts)

        content.isEditable = false
        content.lineWrap = true
        content.wrapStyleWord = true
        content.font = Font(Font.MONOSPACED, Font.PLAIN, 14)
        content.margin = java.awt.Insets(10, 10, 10, 10)

        chapterInfo.border = BorderFactory.createEmptyBorder(7, 10, 7, 10)
        chapterInfo.font = chapterInfo.font.deriveFont(Font.BOLD)
        previousChapter.isEnabled = false
        nextChapter.isEnabled = false
        val chapterNavigation = JPanel(FlowLayout(FlowLayout.RIGHT, 4, 3))
        chapterNavigation.add(previousChapter)
        chapterNavigation.add(nextChapter)
        val chapterBar = JPanel(BorderLayout())
        chapterBar.add(chapterInfo, BorderLayout.CENTER)
        chapterBar.add(chapterNavigation, BorderLayout.EAST)
        val fixedHeader = JPanel(BorderLayout())
        fixedHeader.add(chapterBar, BorderLayout.NORTH)
        fixedHeader.add(toolbar, BorderLayout.CENTER)
        add(fixedHeader, BorderLayout.NORTH)
        val contentScroll = JScrollPane(content)
        contentScroll.addMouseWheelListener { event: MouseWheelEvent ->
            val hasModifier = event.isControlDown || event.isAltDown || event.isShiftDown || event.isMetaDown
            if (event.wheelRotation != 0 && !hasModifier && ReaderVisibilitySettings.isVisible(project)) {
                event.consume()
                session.moveLine(if (event.wheelRotation > 0) 1 else -1)
            }
        }
        add(contentScroll, BorderLayout.CENTER)
        add(status, BorderLayout.SOUTH)

        books.addActionListener {
            if (!updatingControls) (books.selectedItem as? BookOption)?.let(session::selectBook)
        }
        chapters.addActionListener {
            if (!updatingControls) (chapters.selectedItem as? ChapterOption)?.let(session::selectChapter)
        }
        previousChapter.addActionListener { session.moveChapter(-1) }
        nextChapter.addActionListener { session.moveChapter(1) }
        previousLine.addActionListener { session.moveLine(-1) }
        nextLine.addActionListener { session.moveLine(1) }
        refresh.addActionListener { session.reload() }
        importNovel.addActionListener { chooseAndImport() }
        backup.addActionListener { chooseAndBackup() }
        restore.addActionListener { chooseAndRestore() }
        reparse.addActionListener { reparseCurrentBook() }
        deleteBook.addActionListener { deleteCurrentBook() }
        diagnostics.addActionListener { showDiagnostics() }
        libraryMode.addActionListener {
            val next = !LibraryModeSettings.useDesktopLibrary()
            val title = if (next) "桌面书库" else "本地书库"
            val choice = Messages.showYesNoDialog(project, "切换后使用$title；当前数据不会自动复制。", "小说书库数据源", Messages.getQuestionIcon())
            if (choice == Messages.YES) {
                ApplicationManager.getApplication().executeOnPooledThread {
                    runCatching { session.flushProgressWrites() }
                    SwingUtilities.invokeLater {
                        LibraryModeSettings.setUseDesktopLibrary(next)
                        libraryMode.text = title
                        session.resetForProviderSwitch()
                    }
                }
            }
        }
        localDirectory.addActionListener {
            val current = LibraryModeSettings.localDirectory().toString()
            val input = Messages.showInputDialog(project, "本地书库数据目录（可输入绝对路径）", "小说书库本地目录", Messages.getQuestionIcon(), current, null)
            if (!input.isNullOrBlank()) {
                ApplicationManager.getApplication().executeOnPooledThread {
                    val result = runCatching {
                        runCatching { session.flushProgressWrites() }
                        val lock = LibraryModeSettings.beginMigration(Path.of(current))
                        try {
                            BridgeClient.shutdownLocalRuntime()
                            LibraryModeSettings.setLocalDirectory(Path.of(input.trim()), Path.of(current))
                        } finally {
                            LibraryModeSettings.endMigration(lock)
                        }
                    }
                    SwingUtilities.invokeLater {
                        result
                            .onSuccess { LibraryModeSettings.setUseDesktopLibrary(false); libraryMode.text = "本地书库"; session.resetForProviderSwitch() }
                            .onFailure { Messages.showErrorDialog(project, it.message ?: "本地目录切换失败", "小说书库") }
                    }
                }
            }
        }
        displayMode.addActionListener {
            syncDisplayMode(NovelEditorOverlay.toggleDisplayMode(project))
        }
        readerVisibility.addActionListener {
            NovelEditorOverlay.toggleVisibility(project)
            syncReaderVisibility()
        }
        shortcuts.addActionListener { showShortcutHelp(project) }
        configureShortcuts.addActionListener { openShortcutSettings(project) }
        session.attach(::applySnapshot)
    }

    private fun applySnapshot(snapshot: ReaderSnapshot) {
        updatingControls = true
        books.removeAllItems()
        snapshot.books.forEach(books::addItem)
        books.selectedItem = snapshot.selectedBook
        chapters.removeAllItems()
        snapshot.chapters.forEach(chapters::addItem)
        chapters.selectedItem = snapshot.currentChapter?.let { current ->
            snapshot.chapters.find { it.number == current.number }
        }
        updatingControls = false
        content.text = when {
            snapshot.currentChapter == null -> ""
            snapshot.visibleLines.isEmpty() -> "当前章节没有可阅读的正文"
            else -> snapshot.visibleLines.joinToString("\n")
        }
        content.caretPosition = 0
        chapterInfo.text = snapshot.currentChapter?.let { chapter ->
            "第 ${snapshot.chapterOrdinal}/${snapshot.chapters.size} 章 · ${chapter.title} · 总进度 ${"%.1f".format(snapshot.overallProgress)}%"
        } ?: "尚未加载章节 · 总进度 0.0%"
        previousChapter.isEnabled = snapshot.currentChapter != null && snapshot.chapterOrdinal > 1
        nextChapter.isEnabled = snapshot.currentChapter != null && snapshot.chapterOrdinal < snapshot.chapters.size
        status.text = snapshot.status
    }

    private fun runMaintenance(label: String, success: String, action: () -> Unit) {
        status.text = label
        ApplicationManager.getApplication().executeOnPooledThread {
            val result = runCatching(action)
            SwingUtilities.invokeLater {
                result
                    .onSuccess {
                        session.reload()
                        Messages.showInfoMessage(project, success, "小说书库")
                    }
                    .onFailure { Messages.showErrorDialog(project, it.message ?: "$label 失败", "小说书库") }
            }
        }
    }

    private fun chooseAndImport() {
        if (LibraryModeSettings.useDesktopLibrary()) {
            Messages.showInfoMessage(project, "桌面模式请在小说书库桌面端中导入，或先切换到本地书库。", "导入小说")
            return
        }
        val chooser = JFileChooser().apply {
            dialogTitle = "导入 TXT 或 EPUB 小说"
            fileFilter = FileNameExtensionFilter("小说文件（TXT、EPUB）", "txt", "text", "epub")
            isAcceptAllFileFilterUsed = false
        }
        if (chooser.showOpenDialog(this) == JFileChooser.APPROVE_OPTION) {
            runMaintenance("正在导入小说...", "小说导入完成") { BridgeClient.importFile(chooser.selectedFile.absolutePath) }
        }
    }

    private fun chooseAndBackup() {
        val chooser = JFileChooser().apply {
            dialogTitle = "备份当前小说书库"
            dialogType = JFileChooser.SAVE_DIALOG
            selectedFile = java.io.File(System.getProperty("user.home"), "novel-library-backup-${System.currentTimeMillis()}.json")
            fileFilter = FileNameExtensionFilter("小说书库备份（JSON）", "json", "novellibrary-backup")
        }
        if (chooser.showSaveDialog(this) == JFileChooser.APPROVE_OPTION) {
            runMaintenance("正在备份书库...", "书库备份完成：${chooser.selectedFile.absolutePath}") {
                BridgeClient.exportLibrary(chooser.selectedFile.absolutePath)
            }
        }
    }

    private fun chooseAndRestore() {
        val chooser = JFileChooser().apply {
            dialogTitle = "恢复或迁移小说书库"
            fileFilter = FileNameExtensionFilter("小说书库备份", "json", "novellibrary-backup", "novellibrary-transfer")
            isAcceptAllFileFilterUsed = false
        }
        if (chooser.showOpenDialog(this) != JFileChooser.APPROVE_OPTION) return
        val local = !LibraryModeSettings.useDesktopLibrary()
        if (local) {
            val choice = Messages.showYesNoCancelDialog(
                project,
                "请选择恢复方式。清空恢复前会自动备份当前本地书库。",
                "恢复小说书库",
                "清空并恢复",
                "合并恢复",
                "取消",
                Messages.getWarningIcon()
            )
            if (choice == Messages.CANCEL) return
            runMaintenance("正在恢复书库...", "书库恢复完成") {
                BridgeClient.importLibrary(chooser.selectedFile.absolutePath, if (choice == Messages.YES) "replace" else "merge")
            }
        } else if (Messages.showYesNoDialog(project, "备份内容将合并到当前桌面书库，是否继续？", "恢复小说书库", Messages.getWarningIcon()) == Messages.YES) {
            runMaintenance("正在恢复书库...", "书库恢复完成") {
                BridgeClient.importLibrary(chooser.selectedFile.absolutePath, "merge")
            }
        }
    }

    private fun reparseCurrentBook() {
        if (LibraryModeSettings.useDesktopLibrary()) {
            Messages.showInfoMessage(project, "重新解析仅适用于本地书库", "小说书库")
            return
        }
        val book = session.currentBook() ?: return
        runMaintenance("正在重新解析《${book.title}》...", "重新解析完成") { BridgeClient.reparseBook(book.id) }
    }

    private fun deleteCurrentBook() {
        if (LibraryModeSettings.useDesktopLibrary()) {
            Messages.showInfoMessage(project, "删除书籍请在桌面端中操作", "小说书库")
            return
        }
        val book = session.currentBook() ?: return
        if (Messages.showYesNoDialog(project, "确定删除《${book.title}》及其受管源文件吗？", "删除本地书籍", Messages.getWarningIcon()) == Messages.YES) {
            runMaintenance("正在删除《${book.title}》...", "本地书籍已删除") { BridgeClient.deleteBook(book.id) }
        }
    }

    private fun showDiagnostics() {
        ApplicationManager.getApplication().executeOnPooledThread {
            val result = runCatching(BridgeClient::diagnostics)
            SwingUtilities.invokeLater {
                result
                    .onSuccess { Messages.showInfoMessage(project, it, "小说书库 Runtime 诊断") }
                    .onFailure { Messages.showErrorDialog(project, it.message ?: "诊断失败", "小说书库") }
            }
        }
    }

    fun syncDisplayMode(mode: ReaderDisplayMode) {
        displayMode.text = ReaderDisplaySettings.label(mode)
    }

    fun syncReaderVisibility() {
        readerVisibility.text = ReaderVisibilitySettings.label(project)
    }
}

private fun activeShortcut(actionId: String): String {
    val shortcuts = KeymapManager.getInstance().activeKeymap.getShortcuts(actionId)
    return shortcuts.joinToString(" / ") { KeymapUtil.getShortcutText(it) }.ifBlank { "未设置" }
}

private fun openShortcutSettings(project: Project?) {
    ShowSettingsUtil.getInstance().showSettingsDialog(project, KeymapPanel::class.java) { panel ->
        panel.selectAction("NovelLibrary.ToggleReaderVisibility")
    }
}

private fun showShortcutHelp(project: Project?) {
    val actions = listOf(
        "NovelLibrary.ToggleReaderVisibility" to "开启或关闭代码内阅读",
        "NovelLibrary.ToggleDisplayMode" to "切换段落/行尾显示模式",
        "NovelLibrary.PreviousLine" to "上一行",
        "NovelLibrary.NextLine" to "下一行",
        "NovelLibrary.PreviousChapter" to "上一章",
        "NovelLibrary.NextChapter" to "下一章"
    )
    val choice = Messages.showDialog(
        project,
        actions.joinToString("\n") { (id, label) -> "${activeShortcut(id).padEnd(18)}$label" } +
            "\n\n以上为当前 Keymap 的实际绑定，用户设置优先。",
        "小说书库快捷键",
        arrayOf("打开 Keymap 设置", "关闭"),
        0,
        Messages.getInformationIcon()
    )
    if (choice == 0) openShortcutSettings(project)
}

class NovelToolWindowFactory : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = NovelReaderPanel(project)
        ReaderPanels.put(project, panel)
        toolWindow.contentManager.addContent(ContentFactory.getInstance().createContent(panel, "阅读", false))
    }
}

class OpenReaderAction : AnAction() {
    override fun actionPerformed(event: AnActionEvent) { event.project?.let(ReaderPanels::show) }
}
class PreviousLineAction : AnAction() {
    override fun actionPerformed(event: AnActionEvent) { event.project?.let { ReaderSessions.get(it).moveLine(-1) } }
}
class NextLineAction : AnAction() {
    override fun actionPerformed(event: AnActionEvent) { event.project?.let { ReaderSessions.get(it).moveLine(1) } }
}
class PreviousChapterAction : AnAction() {
    override fun actionPerformed(event: AnActionEvent) { event.project?.let { ReaderSessions.get(it).moveChapter(-1) } }
}
class NextChapterAction : AnAction() {
    override fun actionPerformed(event: AnActionEvent) { event.project?.let { ReaderSessions.get(it).moveChapter(1) } }
}
class ToggleDisplayModeAction : AnAction() {
    override fun actionPerformed(event: AnActionEvent) {
        event.project?.let { project ->
            val mode = NovelEditorOverlay.toggleDisplayMode(project)
            ReaderPanels.get(project)?.syncDisplayMode(mode)
        }
    }
}
class ToggleReaderVisibilityAction : AnAction() {
    override fun actionPerformed(event: AnActionEvent) {
        event.project?.let { project ->
            NovelEditorOverlay.toggleVisibility(project)
            ReaderPanels.get(project)?.syncReaderVisibility()
        }
    }
}
class ShowShortcutsAction : AnAction() {
    override fun actionPerformed(event: AnActionEvent) { showShortcutHelp(event.project) }
}
class ImportFileAction : AnAction() {
    override fun actionPerformed(event: AnActionEvent) {
        if (LibraryModeSettings.useDesktopLibrary()) {
            Messages.showInfoMessage(event.project, "桌面模式请在小说书库桌面端中导入，或先切换到本地书库。", "导入小说")
            return
        }
        val chooser = JFileChooser().apply {
            dialogTitle = "导入 TXT 或 EPUB 小说"
            fileFilter = FileNameExtensionFilter("小说文件（TXT、EPUB）", "txt", "text", "epub")
            isAcceptAllFileFilterUsed = false
        }
        if (chooser.showOpenDialog(null) != JFileChooser.APPROVE_OPTION) return
        val file = chooser.selectedFile
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val completed = BridgeClient.importFile(file.absolutePath)
                SwingUtilities.invokeLater {
                    if (completed) event.project?.let { ReaderSessions.get(it).reload() }
                    Messages.showInfoMessage(event.project, if (completed) "小说导入完成" else "已发送到桌面端导入队列", "小说书库")
                }
            } catch (error: Exception) {
                SwingUtilities.invokeLater {
                    Messages.showErrorDialog(event.project, error.message ?: "导入失败", "小说书库")
                }
            }
        }
    }
}

class ToggleLibraryModeAction : AnAction() {
    override fun actionPerformed(event: AnActionEvent) {
        val next = !LibraryModeSettings.useDesktopLibrary()
        val title = if (next) "桌面书库" else "本地书库"
        if (Messages.showYesNoDialog(event.project, "切换后使用$title；当前数据不会自动复制。", "小说书库数据源", Messages.getQuestionIcon()) == Messages.YES) {
            event.project?.let { project ->
                val session = ReaderSessions.get(project)
                ApplicationManager.getApplication().executeOnPooledThread {
                    runCatching { session.flushProgressWrites() }
                    SwingUtilities.invokeLater {
                        LibraryModeSettings.setUseDesktopLibrary(next)
                        session.resetForProviderSwitch()
                    }
                }
            }
        }
    }
}

class ConfigureLocalDirectoryAction : AnAction() {
    override fun actionPerformed(event: AnActionEvent) {
        val current = LibraryModeSettings.localDirectory().toString()
        val input = Messages.showInputDialog(event.project, "本地书库数据目录（可输入绝对路径）", "小说书库本地目录", Messages.getQuestionIcon(), current, null)
        if (!input.isNullOrBlank()) {
            ApplicationManager.getApplication().executeOnPooledThread {
                val result = runCatching {
                    event.project?.let { runCatching { ReaderSessions.get(it).flushProgressWrites() } }
                    val lock = LibraryModeSettings.beginMigration(Path.of(current))
                    try {
                        BridgeClient.shutdownLocalRuntime()
                        LibraryModeSettings.setLocalDirectory(Path.of(input.trim()), Path.of(current))
                    } finally {
                        LibraryModeSettings.endMigration(lock)
                    }
                }
                SwingUtilities.invokeLater {
                    result
                        .onSuccess {
                            LibraryModeSettings.setUseDesktopLibrary(false)
                            event.project?.let { ReaderSessions.get(it).resetForProviderSwitch() }
                        }
                        .onFailure { Messages.showErrorDialog(event.project, it.message ?: "本地目录切换失败", "小说书库") }
                }
            }
        }
    }
}
