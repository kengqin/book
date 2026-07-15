# 在线小说书库

基于 VitePress 的多书阅读项目。每本书的内容与资料独立存放在 `书库/<书名>/`，平台主题和构建配置保留在 `正文/`。

桌面端采用 Tauri 2、Vue 3 和 SQLite，并与在线端共享小说解析和阅读内核。架构与使用方式参见 [桌面端架构设计方案](docs/桌面端架构设计方案.md) 和 [桌面端使用说明](docs/桌面端使用说明.md)。

## 目录结构

```text
书库/
└── <书名>/
    ├── book.json   # 书名、作者、状态、简介与封面配置
    ├── 正文/       # 已发布章节
    ├── 设定/       # 可选
    └── 站点/       # 专题封面等静态资源

正文/               # VitePress 平台配置与公共主题
scripts/            # 通用书库清单生成脚本
```

## 当前展示

构建时会扫描所有包含 `正文/` 的书籍目录，并由各目录的 `book.json` 生成书单、专题页与目录。

## 书籍元数据

每本需要发布的书在目录根部放置 `book.json`：

```json
{
  "id": "stable-book-id",
  "title": "书名",
  "author": "作者",
  "status": "连载中",
  "category": "类型",
  "description": "简介",
  "cover": "cover.jpg",
  "seal": "书"
}
```

`cover` 指向该书 `站点/` 目录内的图片。章节正文使用一级标题，支持数字或中文数字的“第 X 章/回/节”，以及“序章、楔子、引子、番外、后记、尾声、收官章、终章、大结局”。构建会保留原始章标，因此首章可从任意章号开始。

## 常用命令

```bash
npm run content:library
npm run docs:dev
npm run docs:build
npm test
npm run desktop:dev
npm run desktop:web:build
npm run desktop:build
```

桌面端版本记录见 [CHANGELOG.md](CHANGELOG.md)，发布步骤见
[桌面端发布说明](docs/桌面端发布说明.md)，机器可读版本清单位于
`releases/releases.json`。推送 `v*` Tag 后，GitHub Actions 会构建签名安装包、
发布 GitHub Release 并生成自动更新所需的 `latest.json`。

桌面端开发环境当前使用 `D:\Software\Rust` 中的 Rust 工具链，以及
`D:\Software\VisualStudio\2022\BuildTools` 中的 Visual C++ Build Tools。

## 本地发布

站点不再随 `main` 分支推送自动构建。首次使用前，在 GitHub 仓库的
`Settings > Pages` 中将发布来源设为 `Deploy from a branch`，分支选择
`gh-pages`，目录选择根目录 `/`。

确认本地内容无误后执行：

```bash
npm run docs:publish
```

该命令会先在本地生成静态站点，再仅将 `正文/.vitepress/dist` 的内容推送到
`gh-pages` 分支。书库中的原始 TXT 不会进入发布分支。

GitHub Actions 中保留了仅可手动触发的备用发布流程，不再响应 `main` 推送。
