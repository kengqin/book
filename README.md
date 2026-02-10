# 永恒道途

修仙长篇小说《永恒道途》在线阅读站点，基于 [VitePress](https://vitepress.dev/) 构建。

## 项目结构

```
book/
├── package.json
├── .gitignore
├── .github/workflows/deploy.yml    # GitHub Actions 自动部署
├── 正文/                            # VitePress 源目录 (srcDir)
│   ├── index.md                     # 首页
│   ├── .vitepress/
│   │   ├── config.mts               # VitePress 配置
│   │   └── theme/
│   │       ├── index.ts             # 自定义主题入口
│   │       └── custom.css           # 小说阅读样式
│   └── 第一卷-青云初啼/
│       ├── 第一章-寒门少年.md
│       ├── 第二章-掌天瓶现.md
│       └── ...（共20章）
└── 《永恒道途》*.md                  # 参考文档（不会被发布）
```

## 本地开发

```bash
# 安装依赖
npm install

# 启动本地开发服务器
npm run docs:dev

# 构建静态站点
npm run docs:build

# 预览构建产物
npm run docs:preview
```

## 部署

项目通过 GitHub Actions 自动部署到 GitHub Pages。

每次推送到 `main` 分支后会自动触发构建和部署。

### 首次部署设置

1. 进入 GitHub 仓库 **Settings → Pages**
2. 将 **Source** 设置为 **GitHub Actions**
3. 推送代码到 `main` 分支，等待 Actions 运行完成

部署完成后，站点地址为：`https://kengqin.github.io/book/`

## 添加新章节

1. 在 `正文/第一卷-青云初啼/` 下新建 `.md` 文件，文件名格式如 `第二十一章-标题.md`
2. 在 `正文/.vitepress/config.mts` 的 `sidebar` 配置中添加对应条目
3. 推送到 `main` 分支，站点会自动更新
