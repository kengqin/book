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
import com.intellij.openapi.editor.colors.EditorFontType
import com.intellij.openapi.editor.event.CaretEvent
import com.intellij.openapi.editor.event.CaretListener
import com.intellij.openapi.editor.event.EditorFactoryEvent
import com.intellij.openapi.editor.event.EditorFactoryListener
import com.intellij.openapi.editor.markup.TextAttributes
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.content.ContentFactory
import java.awt.BorderLayout
import java.awt.FlowLayout
import java.awt.Font
import java.awt.Graphics
import java.awt.Rectangle
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

data class BridgeConfig(val port: Int, val token: String)
data class BookOption(val id: String, val title: String, val currentChapter: Int?) { override fun toString() = title }
data class ChapterOption(val number: Int, val title: String, val kind: String?) { override fun toString() = title }
data class ChapterContent(val number: Int, val title: String, val text: String)

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

object BridgeClient {
    private val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build()

    private fun config(): BridgeConfig {
        val root = System.getenv("APPDATA") ?: error("APPDATA is not available")
        val text = java.nio.file.Files.readString(java.nio.file.Path.of(root, "NovelLibrary", "bridge.json"))
        val port = Regex(""""port"\s*:\s*(\d+)""").find(text)?.groupValues?.get(1)?.toInt()
            ?: error("Bridge port missing")
        val token = Regex(""""token"\s*:\s*"([^"]+)"""").find(text)?.groupValues?.get(1)
            ?: error("Bridge token missing")
        return BridgeConfig(port, token)
    }

    private fun send(path: String, body: String? = null): String {
        val config = config()
        val builder = HttpRequest.newBuilder(URI("http://127.0.0.1:${config.port}$path"))
            .timeout(Duration.ofSeconds(5))
            .header("Authorization", "Bearer ${config.token}")
        if (body == null) builder.GET() else builder.header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body))
        val response = client.send(builder.build(), HttpResponse.BodyHandlers.ofString())
        if (response.statusCode() !in 200..299) error("Bridge request failed: ${response.statusCode()}")
        return response.body()
    }

    fun books(): List<BookOption> = JsonParser.parseString(send("/v1/books")).asJsonArray.map { item ->
        val value = item.asJsonObject
        BookOption(
            value["id"].asString,
            value["title"].asString,
            value.get("currentChapter")?.takeUnless { it.isJsonNull }?.asInt
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
        val editor = inlay.editor
        val font = editor.colorsScheme.getFont(EditorFontType.PLAIN)
        return editor.contentComponent.getFontMetrics(font).stringWidth(display)
    }

    override fun paint(inlay: Inlay<*>, graphics: Graphics, targetRegion: Rectangle, textAttributes: TextAttributes) {
        val editor = inlay.editor
        graphics.font = editor.colorsScheme.getFont(EditorFontType.PLAIN)
        graphics.color = com.intellij.ui.JBColor(0x6B7280, 0x8B949E)
        graphics.drawString(display, targetRegion.x, targetRegion.y + editor.ascent)
    }
}

object NovelEditorOverlay {
    private val inlays = WeakHashMap<Editor, MutableList<Inlay<*>>>()
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

    private fun refresh(project: Project) {
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            val lines = synchronized(this) { visibleLines[project].orEmpty() }
            EditorFactory.getInstance().allEditors.filter { it.project == project }.forEach { editor ->
                synchronized(this) { inlays.remove(editor) }.orEmpty().forEach(Inlay<*>::dispose)
                if (lines.isEmpty() || editor.isDisposed) return@forEach
                val document = editor.document
                val count = minOf(5, lines.size, document.lineCount)
                val caretLine = editor.caretModel.logicalPosition.line
                val firstLine = caretLine.coerceAtMost(maxOf(0, document.lineCount - count))
                val created = mutableListOf<Inlay<*>>()
                repeat(count) { index ->
                    val offset = document.getLineEndOffset(firstLine + index)
                    editor.inlayModel.addAfterLineEndElement(
                        offset,
                        true,
                        NovelLineInlayRenderer(lines[index])
                    )?.let(created::add)
                }
                synchronized(this) { inlays[editor] = created }
            }
        }
    }
}

class NovelStartupActivity : ProjectActivity {
    override suspend fun execute(project: Project) {
        NovelEditorOverlay.start(project)
        ApplicationManager.getApplication().executeOnPooledThread {
            runCatching {
                val book = BridgeClient.books().firstOrNull() ?: return@runCatching
                val chapters = BridgeClient.chapters(book.id)
                var index = chapters.indexOfFirst { it.number == book.currentChapter }.coerceAtLeast(0)
                var lines = emptyList<String>()
                var attempts = 0
                while (index in chapters.indices && attempts < 30 && lines.isEmpty()) {
                    lines = displayLines(BridgeClient.chapter(book.id, chapters[index].number).text).take(5)
                    index += 1
                    attempts += 1
                }
                NovelEditorOverlay.show(project, lines)
            }
        }
    }
}

class NovelReaderPanel(private val project: Project) : JPanel(BorderLayout()) {
    private val books = JComboBox<BookOption>()
    private val chapters = JComboBox<ChapterOption>()
    private val content = JTextArea(7, 36)
    private val status = JLabel("正在连接小说书库桌面端...")
    private var chapterList = emptyList<ChapterOption>()
    private var currentChapter: ChapterContent? = null
    private var lines = emptyList<String>()
    private var lineStart = 0
    private var updatingControls = false

    init {
        NovelEditorOverlay.start(project)
        val toolbar = JPanel(FlowLayout(FlowLayout.LEFT, 6, 5))
        val previousChapter = JButton("上一章")
        val nextChapter = JButton("下一章")
        val previousLine = JButton("上一行")
        val nextLine = JButton("下一行")
        toolbar.add(books)
        toolbar.add(chapters)
        toolbar.add(previousChapter)
        toolbar.add(nextChapter)
        toolbar.add(previousLine)
        toolbar.add(nextLine)

        content.isEditable = false
        content.lineWrap = true
        content.wrapStyleWord = true
        content.font = Font(Font.MONOSPACED, Font.PLAIN, 14)
        content.margin = java.awt.Insets(10, 10, 10, 10)

        add(toolbar, BorderLayout.NORTH)
        add(JScrollPane(content), BorderLayout.CENTER)
        add(status, BorderLayout.SOUTH)

        books.addActionListener {
            if (!updatingControls) (books.selectedItem as? BookOption)?.let(::loadChapters)
        }
        chapters.addActionListener {
            if (!updatingControls) (chapters.selectedItem as? ChapterOption)?.let(::loadChapter)
        }
        previousChapter.addActionListener { moveChapter(-1) }
        nextChapter.addActionListener { moveChapter(1) }
        previousLine.addActionListener { moveLine(-1) }
        nextLine.addActionListener { moveLine(1) }
        loadBooks()
    }

    private fun background(task: () -> Unit) {
        ApplicationManager.getApplication().executeOnPooledThread {
            try { task() } catch (error: Exception) {
                SwingUtilities.invokeLater {
                    status.text = "连接失败：${error.message ?: "未知错误"}"
                }
            }
        }
    }

    private fun loadBooks() = background {
        val result = BridgeClient.books()
        SwingUtilities.invokeLater {
            updatingControls = true
            books.removeAllItems()
            result.forEach(books::addItem)
            updatingControls = false
            if (result.isEmpty()) status.text = "桌面端书库中还没有小说" else loadChapters(result.first())
        }
    }

    private fun loadChapters(book: BookOption) = background {
        val allChapters = BridgeClient.chapters(book.id)
        val readableChapters = allChapters.filter { it.kind == null || it.kind == "chapter" }
        val result = readableChapters.ifEmpty { allChapters }
        SwingUtilities.invokeLater {
            chapterList = result
            updatingControls = true
            chapters.removeAllItems()
            result.forEach(chapters::addItem)
            updatingControls = false
            val preferred = result.find { it.number == book.currentChapter } ?: result.firstOrNull()
            if (preferred == null) status.text = "当前小说没有章节" else loadChapter(preferred)
        }
    }

    private fun loadChapter(chapter: ChapterOption, direction: Int = 1) {
        val book = books.selectedItem as? BookOption ?: return
        val candidates = chapterList
        background {
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
            currentChapter = result
            lines = resultLines
            lineStart = 0
            updatingControls = true
            chapters.selectedItem = candidates.find { it.number == result.number }
            updatingControls = false
            render()
        }
    }
    }

    private fun render() {
        val chapter = currentChapter ?: return
        if (lines.isEmpty()) {
            content.text = "当前章节没有可阅读的正文"
            NovelEditorOverlay.clear(project)
            status.text = chapter.title
            return
        }
        val end = minOf(lines.size, lineStart + 5)
        content.text = lines.subList(lineStart, end).joinToString("\n")
        content.caretPosition = 0
        NovelEditorOverlay.show(project, lines.subList(lineStart, end))
        status.text = "${chapter.title} · ${lineStart + 1}-$end / ${lines.size} 行"
    }

    fun moveLine(direction: Int) {
        lineStart = (lineStart + direction).coerceIn(0, maxOf(0, lines.size - 5))
        render()
        val book = books.selectedItem as? BookOption ?: return
        val chapter = currentChapter ?: return
        val progress = if (lines.size <= 5) 100.0 else lineStart.toDouble() / (lines.size - 5) * 100.0
        background { BridgeClient.saveProgress(book.id, chapter.number, progress) }
    }

    fun moveChapter(direction: Int) {
        val chapter = currentChapter ?: return
        val index = chapterList.indexOfFirst { it.number == chapter.number }
        if (index < 0) return
        val next = (index + direction).coerceIn(0, chapterList.lastIndex)
        if (next != index) {
            updatingControls = true
            chapters.selectedItem = chapterList[next]
            updatingControls = false
            loadChapter(chapterList[next], direction)
        }
    }
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
    override fun actionPerformed(event: AnActionEvent) { event.project?.let { ReaderPanels.show(it) { panel -> panel.moveLine(-1) } } }
}
class NextLineAction : AnAction() {
    override fun actionPerformed(event: AnActionEvent) { event.project?.let { ReaderPanels.show(it) { panel -> panel.moveLine(1) } } }
}
class PreviousChapterAction : AnAction() {
    override fun actionPerformed(event: AnActionEvent) { event.project?.let { ReaderPanels.show(it) { panel -> panel.moveChapter(-1) } } }
}
class NextChapterAction : AnAction() {
    override fun actionPerformed(event: AnActionEvent) { event.project?.let { ReaderPanels.show(it) { panel -> panel.moveChapter(1) } } }
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
