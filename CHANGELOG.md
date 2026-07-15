# 更新日志

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。桌面端正式版本与 Git Tag、GitHub Release、安装包版本保持一致。

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

[0.1.0]: https://github.com/kengqin/book/releases/tag/v0.1.0
