# 更新日志

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。桌面端正式版本与 Git Tag、GitHub Release、安装包版本保持一致。

## [0.1.2] - 2026-07-16

### 新增

- 新增跨页面全局更新状态，下载进度在书架、阅读器和设置页面持续显示。
- 更新下载支持取消；下载完成后由用户点击“安装并重启”，不再自动强制重启。

### 修复

- 修复 v0.1.1 更新器对象被 Vue 响应式代理后，点击更新出现 `Cannot read private member from an object whose class did not declare it` 并导致无法下载安装的问题。
- 修复历史版本 Release 和安装包链接无法通过系统浏览器打开的问题。
- 更新服务不可用时改为显示中文状态，不再暴露底层英文错误。
- 修复发布流程缺少 `latest.json`，导致自动更新检查返回 `404` 的问题。

### 升级说明

- v0.1.1 内置更新器存在兼容问题；应用内更新失败时，请下载 v0.1.2 安装包覆盖安装，书库数据不会被删除。

## [0.1.1] - 2026-07-16

### 修复

- Windows 启动统一使用 GUI 子系统，安装后不再显示命令行窗口。

### 调整

- Windows 默认安装目录、安装包文件名、快捷方式和卸载项统一使用 `NovelLibrary` 英文名称。

## [0.1.0] - 2026-07-15

### 新增

- 新增 Windows 桌面端，支持自定义安装目录。
- 新增 TXT 导入、编码识别、章节解析、本地书架和 SQLite 持久化。
- 新增书籍详情、分卷目录、章节阅读、全文搜索和阅读进度恢复。
- 新增字号、行距、阅读配色以及书库删除功能。
- 新增 JSON 备份恢复、自定义数据目录和自定义 SQLite 数据库文件。
- 新增版本中心、历史更新日志、自动检查更新和指定历史版本安装入口。

### 数据

- 默认数据目录为 `%APPDATA%\NovelLibrary`。
- 当前数据库 schema 为 `2`；安装旧版本前应先导出备份。

[0.1.2]: https://github.com/kengqin/book/releases/tag/v0.1.2
[0.1.1]: https://github.com/kengqin/book/releases/tag/v0.1.1
[0.1.0]: https://github.com/kengqin/book/releases/tag/v0.1.0
