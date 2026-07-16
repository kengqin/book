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

- `plugins/intellij`：`0.4.1`，Kotlin + IntelliJ Platform Gradle Plugin，提供工具窗口、5 行行尾 Inlay、启动自动加载和快捷键，一个包覆盖多个 JetBrains IDE。
- `plugins/vscode`：`0.4.2`，CommonJS 扩展，提供活动栏、含真实正文的侧边栏、5 行行尾 Decoration、选书选章、导入命令和快捷键。
- `plugins/visual-studio`：`0.4.0`，Visual Studio 2022 官方 VSIX，提供 WPF 工具窗口、5 行行尾 Adornment、选书选章和快捷键。

插件读取章节列表后优先过滤 `frontmatter` 和 `volume`，自动从 `kind=chapter` 的正文开始；附近空正文最多向前搜索 30 项。Bridge 请求最长 5 秒，避免 IDE 或桌面端失去响应。

## 安装

桌面端资源目录固定包含 `novel-library-reader-0.4.2.vsix`、`novel-library-intellij-0.4.1.zip`、`novel-library-visual-studio-0.4.0.vsix` 和清单。工具页默认展示全部支持插件并提供搜索，检测到每个 IDE 后由用户单独选择安装目标。已安装实例展示实际版本和卸载操作。

JetBrains ZIP 根据目标产品 `product-info.json` 部署到准确插件目录，不调用只支持 Marketplace ID 的 `installPlugins`。检测和安装子进程均隐藏命令行窗口。命令行入口支持交互选择，也支持 `-Only ... -AllTargets` 自动化验收。

## 验收

仓库根目录运行 `npm test`、`npm run desktop:web:build`、`npm run plugins:validate`，桌面端目录运行 `cargo fmt --all -- --check` 和 `cargo test`。还必须执行 JetBrains `clean buildPlugin`、Visual Studio `dotnet build -c Release` 和官方 VSIX 结构校验。

2026-07-16 本机验收：VS Code `1.129.0` 与 Cursor `3.5.17` 均成功安装 `0.4.2`，隔离宿主通过真实 Bridge 验证 `诡秘之主 / 绯红 / 5 行` 和下一行同步；IntelliJ IDEA `2025.3.2` 成功加载 `0.4.1`。NSIS 安装到隔离目录后真实包含清单与三份插件，并能完整卸载。Visual Studio 官方 VSIX 已 0 警告构建并校验清单、DLL、`.pkgdef` 和命令注册，但本机未安装 Visual Studio，因此安装、工具窗口和卸载仍须在有 VS 2022 的发布机完成。
