package com.kengqin.novellibrary

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory
import java.awt.BorderLayout
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import javax.swing.JLabel
import javax.swing.JPanel

data class BridgeConfig(val port: Int, val token: String)

object BridgeClient {
    private val client = HttpClient.newHttpClient()
    private fun config(): BridgeConfig {
        val root = System.getenv("APPDATA") ?: error("APPDATA is not available")
        val text = java.nio.file.Files.readString(java.nio.file.Path.of(root, "NovelLibrary", "bridge.json"))
        val port = Regex("\\\"port\\\"\\s*:\\s*(\\d+)").find(text)?.groupValues?.get(1)?.toInt() ?: error("Bridge port missing")
        val token = Regex("\\\"token\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"").find(text)?.groupValues?.get(1) ?: error("Bridge token missing")
        return BridgeConfig(port, token)
    }
    fun get(path: String): String { val c = config(); return client.send(HttpRequest.newBuilder(URI("http://127.0.0.1:${c.port}$path")).header("Authorization", "Bearer ${c.token}").GET().build(), HttpResponse.BodyHandlers.ofString()).body() }
    fun post(path: String, body: String): String { val c = config(); return client.send(HttpRequest.newBuilder(URI("http://127.0.0.1:${c.port}$path")).header("Authorization", "Bearer ${c.token}").header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString()).body() }
}

class NovelToolWindowFactory : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = JPanel(BorderLayout())
        panel.add(JLabel("小说阅读面板已连接 Bridge。使用命令打开书架和章节。"), BorderLayout.NORTH)
        toolWindow.contentManager.addContent(ContentFactory.getInstance().createContent(panel, "阅读", false))
    }
}

class OpenReaderAction : AnAction() { override fun actionPerformed(event: AnActionEvent) { val project = event.project ?: return; ToolWindowManager.getInstance(project).getToolWindow("小说")?.show() } }
class ImportFileAction : AnAction() { override fun actionPerformed(event: AnActionEvent) { val file = event.getData(com.intellij.openapi.actionSystem.CommonDataKeys.VIRTUAL_FILE); if (file == null) return; try { BridgeClient.post("/v1/import", "{\"path\":\"${file.path.replace("\\", "\\\\")}\"}") } catch (error: Exception) { Messages.showErrorDialog(error.message ?: "导入失败", "小说书库") } } }
