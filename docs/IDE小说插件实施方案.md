# IDE 小说插件实施方案

> 完整技术基线见 [`IDE小说插件完整技术方案.md`](./IDE小说插件完整技术方案.md)。本文档保留为实施摘要和快速入口。

## 交付范围

本功能在 `codex/novel-ide-plugin` 分支中作为一个完整版本交付，桌面端负责本地书库，IDE 只通过本机 Bridge 访问数据。首发平台为 Windows 10/11，支持 IntelliJ 系列、VS Code/Cursor 和 Visual Studio 2022。

## 同步协议

Bridge 监听 `127.0.0.1` 的动态端口，并在 `%APPDATA%/NovelLibrary/bridge.json` 中写入端口、协议版本、进程号、会话 ID 和每次启动轮换的 token。除 `/v1/health` 外的接口必须使用 `Authorization: Bearer <token>`。

核心接口为：

- `GET /v1/manifest`
- `GET /v1/books`
- `GET /v1/books/:bookId/chapters`
- `GET /v1/books/:bookId/chapters/:number`
- `POST /v1/progress`
- `POST /v1/import`
- `POST /v1/open`

正文只由桌面端写入，进度和书签可由插件回写。导入请求由 Bridge 发送给桌面端前端，继续复用现有 TXT/EPUB Worker 和 SQLite 仓储。

## 阅读位置

完整阅读器保存章节、百分比和字符锚点。桌面端紧凑模式展示 4、5 或 8 行，方向键逐行移动，PageUp/PageDown 按窗口移动，Ctrl+左右方向键切换章节。IDE 插件采用相同命令语义，并由各 IDE 的 Keymap 处理快捷键冲突。

## 适配器

- `plugins/intellij`：Kotlin + IntelliJ Platform Gradle Plugin，一个包覆盖多个 JetBrains IDE。
- `plugins/vscode`：无构建依赖的 CommonJS 扩展，提供 Webview 阅读面板、导入命令和快捷键。
- `plugins/visual-studio`：Visual Studio 2022 VSIX 工程和 C# Bridge 客户端。

## 验收

仓库根目录运行 `npm test`、`npm run desktop:web:build`、`npm run plugins:validate`，桌面端目录运行 `cargo fmt --all -- --check` 和 `cargo test`。JetBrains 和 Visual Studio 的最终包构建需要对应官方 IDE/SDK 工具链；当前环境没有安装这些工具，因此提交前必须在 Windows 发布机完成两类 VSIX/ZIP 的真实构建和安装测试。
