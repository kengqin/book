# 在线小说书库

基于 VitePress 的多书阅读项目。每本书的内容与资料独立存放在 `书库/<书名>/`，平台主题和构建配置保留在 `正文/`。

## 目录结构

```text
书库/
├── 剑来/
│   ├── 原文/       # 本地原始留档，不提交 Git
│   └── 正文/       # 拆分后的发布章节
├── 雪中悍刀行/
│   ├── 原文/       # 本地原始留档，不提交 Git
│   └── 正文/       # 本地拆分章节，不提交 Git
└── 永恒道途/
    ├── 正文/
    ├── 设定/
    ├── 参考资料/
    └── 站点/

正文/               # VitePress 平台配置与公共主题
scripts/            # 内容整理脚本
```

## 当前展示

当前站点展示《剑来》本地留档中已整理的章节。《永恒道途》已完整归档，后续可继续重构。

## 常用命令

```bash
npm run content:jianlai
npm run content:xuezhong
npm run content:library
npm run docs:dev
npm run docs:build
```

## 本地发布

站点不再随 `main` 分支推送自动构建。首次使用前，在 GitHub 仓库的
`Settings > Pages` 中将发布来源设为 `Deploy from a branch`，分支选择
`gh-pages`，目录选择根目录 `/`。

确认本地内容无误后执行：

```bash
npm run docs:publish
```

该命令会先在本地生成静态站点，再仅将 `正文/.vitepress/dist` 的内容推送到
`gh-pages` 分支。`书库/剑来/原文/` 下的 TXT 留档不会进入发布分支。

GitHub Actions 中保留了仅可手动触发的备用发布流程，不再响应 `main` 推送。
