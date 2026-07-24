# 小说书库 IDE 插件

本目录包含小说书库桌面端的三套 IDE 阅读插件。它们共享同一套本机 Bridge 协议和阅读语义，但分别使用各 IDE 的原生扩展机制实现界面与编辑器集成。

## 插件包

- `vscode`：适用于 Visual Studio Code、Cursor、Trae、Qoder、Windsurf、Kiro 及其他兼容 Code OSS 编辑器的 VSIX。
- `intellij`：适用于 IntelliJ IDEA、PyCharm、WebStorm、Android Studio、Rider、CLion、GoLand、RubyMine 等 IntelliJ Platform IDE 的 ZIP 插件。
- `visual-studio`：适用于 Visual Studio 2022 Community、Professional 和 Enterprise 的 VSIX。

三套插件均提供书架与章节浏览、五行只读正文、章节边界自动衔接、固定章节进度栏、段落/行尾显示模式、阅读状态保存以及桌面端进度同步。正文仅通过编辑器装饰、Inlay 或 Adornment 呈现，不写入源文件。

## 统一交互

- `Ctrl+Alt+N`：显示或隐藏代码内阅读。
- `Ctrl+Alt+9`：切换段落模式与行尾模式。
- `Ctrl+Alt+↑ / ↓`：上一行或下一行。
- `Ctrl+Alt+← / →`：上一章或下一章。

默认快捷键可在 Code OSS Keyboard Shortcuts、JetBrains Keymap 或 Visual Studio Environment/Keyboard 设置中覆盖。插件阅读界面均提供快捷键说明与自定义入口。

JetBrains IDE 和 Visual Studio 原生支持在五行阅读区域内悬停滚轮切行，并保持区域外的代码滚动不受影响。Code OSS 扩展 API 不提供装饰区域滚轮事件，因此对应能力由桌面端的“增强滚轮”实验开关提供；该功能默认关闭，启用前备份工作台文件，关闭时可恢复，写入失败会自动回滚。

## 本机连接与数据边界

插件不会直接打开 SQLite 数据库。桌面端在运行目录附近维护当前进程的 `bridge.json`，其中包含本次运行使用的回环端口和临时令牌；旧版 `%APPDATA%/NovelLibrary/bridge.json` 仅作为迁移兼容回退。

所有书架读取与进度写入均通过回环地址完成，不向局域网或公网开放。桌面端安装器使用 `scripts/install-ide-plugins.ps1` 执行安装、更新和卸载复检；IDE 仍可能显示自身的安全或权限确认。
