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
import com.intellij.openapi.options.ShowSettingsUtil
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
import java.awt.event.MouseWheelEvent
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.time.Duration
import java.util.WeakHashMap
import javax.swing.JButton
import javax.swing.JComboBox
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JScrollPane
import javax.swing.JTextArea
import javax.swing.SwingUtilities
import kotlin.math.roundToInt

data class BridgeConfig(val port: Int, val token: String)
data class BookOption(val id: String, val title: String, val currentChapter: Int?, val chapterProgress: Double) { override fun toString() = title }
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

object BridgeClient {
    private val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build()
    private var cachedInstalledBridge: java.nio.file.Path? = null

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

    private fun config(): BridgeConfig {
        val root = System.getenv("APPDATA") ?: error("APPDATA is not available")
        val legacyDirectory = java.nio.file.Path.of(root, "NovelLibrary")
        val legacyBridge = legacyDirectory.resolve("bridge.json")
        val bridgePath = installedBridge() ?: legacyBridge
        val text = java.nio.file.Files.readString(bridgePath)
        val port = Regex(""""port"\s*:\s*(\d+)""").find(text)?.groupValues?.get(1)?.toInt()
            ?: error("Bridge port missing")
        val token = Regex(""""token"\s*:\s*"([^"]+)"""").find(text)?.groupValues?.get(1)
            ?: error("Bridge token missing")
        return BridgeConfig(port, token)
    }

    private fun send(path: String, body: String? = null): String {
        var lastError = "Bridge request failed"
        repeat(if (body == null) 3 else 1) { attempt ->
            val config = config()
            val builder = HttpRequest.newBuilder(URI("http://127.0.0.1:${config.port}$path"))
                .timeout(Duration.ofSeconds(5))
                .header("Authorization", "Bearer ${config.token}")
            if (body == null) builder.GET() else builder.header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body))
            val response = client.send(builder.build(), HttpResponse.BodyHandlers.ofString())
            if (response.statusCode() in 200..299) return response.body()
            val detail = runCatching {
                JsonParser.parseString(response.body()).asJsonObject.get("error")?.asString
            }.getOrNull()
            lastError = "Bridge request failed: ${response.statusCode()}${detail?.let { " · $it" }.orEmpty()}"
            if (attempt < 2) Thread.sleep(200)
        }
        error(lastError)
    }

    fun books(): List<BookOption> = JsonParser.parseString(send("/v1/books")).asJsonArray.map { item ->
        val value = item.asJsonObject
        BookOption(
            value["id"].asString,
            value["title"].asString,
            value.get("currentChapter")?.takeUnless { it.isJsonNull }?.asInt,
            value.get("chapterProgress")?.takeUnless { it.isJsonNull }?.asDouble ?: 0.0
        )
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

    fun saveProgress(bookId: String, chapterNumber: Int, chapterProgress: Double) {
        val payload = JsonObject().apply {
            addProperty("bookId", bookId)
            addProperty("chapterNumber", chapterNumber)
            addProperty("chapterProgress", chapterProgress)
        }
        send("/v1/progress", payload.toString())
    }

    fun importFile(path: String) {
        send("/v1/import", JsonObject().apply { addProperty("path", path) }.toString())
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

object NovelEditorOverlay {
    private val inlays = WeakHashMap<Editor, MutableList<Inlay<*>>>()
    private val wheelListeners = WeakHashMap<Project, AWTEventListener>()
    private val visibleLines = WeakHashMap<Project, List<String>>()
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
    }

    @Synchronized
    fun show(project: Project, lines: List<String>) {
        visibleLines[project] = lines.take(5)
        refresh(project)
    }

    @Synchronized
    fun clear(project: Project) {
        visibleLines.remove(project)
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

    private fun refresh(project: Project) {
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            val lines = if (ReaderVisibilitySettings.isVisible(project)) {
                synchronized(this) { visibleLines[project].orEmpty() }
            } else {
                emptyList()
            }
            EditorFactory.getInstance().allEditors.filter { it.project == project }.forEach { editor ->
                synchronized(this) { inlays.remove(editor) }.orEmpty().forEach(Inlay<*>::dispose)
                if (lines.isEmpty() || editor.isDisposed) return@forEach
                val document = editor.document
                val count = minOf(5, lines.size, document.lineCount)
                val caretLine = editor.caretModel.logicalPosition.line
                val firstLine = caretLine.coerceAtMost(maxOf(0, document.lineCount - count))
                val created = mutableListOf<Inlay<*>>()
                val mode = ReaderDisplaySettings.get(project)
                repeat(count) { index ->
                    val lineNumber = firstLine + index
                    if (mode == ReaderDisplayMode.PARAGRAPH) {
                        editor.inlayModel.addInlineElement(
                            document.getLineStartOffset(lineNumber),
                            false,
                            NovelParagraphInlayRenderer(lines[index])
                        )?.let(created::add)
                    } else {
                        editor.inlayModel.addAfterLineEndElement(
                            document.getLineEndOffset(lineNumber),
                            true,
                            NovelLineInlayRenderer(lines[index])
                        )?.let(created::add)
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
    val status: String = "正在连接小说书库桌面端..."
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
    private var status = "正在连接小说书库桌面端..."
    private var listener: ((ReaderSnapshot) -> Unit)? = null
    private var started = false
    private var requestVersion = 0
    private var reconnectAttempts = 0

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

    private fun snapshot() = ReaderSnapshot(
        books,
        selectedBook,
        chapters,
        currentChapter,
        if (lines.isEmpty()) emptyList() else lines.subList(lineStart, minOf(lines.size, lineStart + 5)),
        status
    )

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
                    status = "桌面端书库中还没有小说"
                    NovelEditorOverlay.clear(project)
                    publish()
                } else {
                    val book = result.find { it.id == position?.bookId } ?: result.first()
                    loadChapters(book, position?.takeIf { it.bookId == book.id })
                }
            }
        }
    }

    fun selectBook(book: BookOption) = loadChapters(book)

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
            val allChapters = BridgeClient.chapters(book.id)
            val readable = allChapters
                .filter { it.kind == null || it.kind == "chapter" }
                .ifEmpty { allChapters }
                .mapIndexed { index, chapter -> chapter.copy(ordinal = index + 1) }
            SwingUtilities.invokeLater {
                if (version != requestVersion) return@invokeLater
                reconnectAttempts = 0
                chapters = readable
                val preferredChapter = position?.chapterNumber ?: book.currentChapter
                val preferred = readable.find { it.number == preferredChapter } ?: readable.firstOrNull()
                if (preferred == null) {
                    status = "当前小说没有章节"
                    publish()
                } else {
                    val restoredLineStart = position?.takeIf { it.chapterNumber == preferred.number }?.lineStart
                    val restoredProgress = if (position == null && preferred.number == book.currentChapter) {
                        book.chapterProgress
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
        restoredProgress: Double? = null
    ) {
        val book = selectedBook ?: return
        val candidates = chapters
        val version = ++requestVersion
        status = "正在加载 ${chapter.title}..."
        publish()
        background({ loadChapter(chapter, direction, restoredLineStart, restoredProgress) }) {
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
                currentChapter = result
                lines = resultLines
                lineStart = if (result.number == chapter.number) {
                    (restoredLineStart ?: restoredProgress?.let {
                        lineStartFromProgress(resultLines.size, it)
                    } ?: 0).coerceIn(0, maxOf(0, resultLines.size - 5))
                } else 0
                render()
                syncProgress()
            }
        }
    }

    private fun syncProgress() {
        val book = selectedBook ?: return
        val chapter = currentChapter ?: return
        if (lines.isEmpty()) return
        val progress = if (lines.size <= 5) 100.0 else lineStart.toDouble() / (lines.size - 5) * 100.0
        background { BridgeClient.saveProgress(book.id, chapter.number, progress) }
    }

    private fun render() {
        val chapter = currentChapter ?: return
        if (lines.isEmpty()) {
            status = "${chapter.title} · 当前章节没有可阅读的正文"
            NovelEditorOverlay.clear(project)
        } else {
            val end = minOf(lines.size, lineStart + 5)
            status = "${chapter.title} · ${lineStart + 1}-$end / ${lines.size} 行"
            NovelEditorOverlay.show(project, lines.subList(lineStart, end))
        }
        publish()
    }

    fun moveLine(direction: Int) {
        val next = (lineStart + direction).coerceIn(0, maxOf(0, lines.size - 5))
        if (next == lineStart || lines.isEmpty()) return
        lineStart = next
        render()
        syncProgress()
    }

    fun moveChapter(direction: Int) {
        val chapter = currentChapter ?: return
        val index = chapters.indexOfFirst { it.number == chapter.number }
        if (index < 0) return
        val next = (index + direction).coerceIn(0, chapters.lastIndex)
        if (next != index) loadChapter(chapters[next], direction)
    }

    fun reload() {
        reconnectAttempts = 0
        loadBooks(preservePosition = true)
    }
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
    private val status = JLabel("正在连接小说书库桌面端...")
    private val displayMode = JButton(ReaderDisplaySettings.label(ReaderDisplaySettings.get(project)))
    private val readerVisibility = JButton(ReaderVisibilitySettings.label(project))
    private var updatingControls = false

    init {
        NovelEditorOverlay.start(project)
        val toolbar = JPanel(WrapLayout(FlowLayout.LEFT, 6, 5))
        val previousChapter = JButton("上一章")
        val nextChapter = JButton("下一章")
        val previousLine = JButton("上一行")
        val nextLine = JButton("下一行")
        val refresh = JButton("刷新")
        val shortcuts = JButton("快捷键")
        val configureShortcuts = JButton("自定义快捷键")
        toolbar.add(books)
        toolbar.add(chapters)
        toolbar.add(previousChapter)
        toolbar.add(nextChapter)
        toolbar.add(previousLine)
        toolbar.add(nextLine)
        toolbar.add(refresh)
        toolbar.add(displayMode)
        toolbar.add(readerVisibility)
        toolbar.add(shortcuts)
        toolbar.add(configureShortcuts)

        content.isEditable = false
        content.lineWrap = true
        content.wrapStyleWord = true
        content.font = Font(Font.MONOSPACED, Font.PLAIN, 14)
        content.margin = java.awt.Insets(10, 10, 10, 10)

        add(toolbar, BorderLayout.NORTH)
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
        status.text = snapshot.status
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
    ShowSettingsUtil.getInstance().showSettingsDialog(project, "Keymap")
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
        val file = event.getData(com.intellij.openapi.actionSystem.CommonDataKeys.VIRTUAL_FILE) ?: return
        ApplicationManager.getApplication().executeOnPooledThread {
            try { BridgeClient.importFile(file.path) } catch (error: Exception) {
                SwingUtilities.invokeLater {
                    Messages.showErrorDialog(event.project, error.message ?: "导入失败", "小说书库")
                }
            }
        }
    }
}
