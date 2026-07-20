# Web 在线阅读端

`@novel-library/web` 是仓库中的 VitePress Web 应用，与 `apps/desktop`、`apps/mobile` 并列。

```text
apps/web/
├── .vitepress/  # VitePress 配置、主题和生成产物
├── scripts/     # 书库清单生成
└── 书库/        # 公开书籍、章节、元数据和专题资源
```

在仓库根目录运行：

```bash
npm run web:dev
npm run web:build
npm run web:preview
npm run web:publish
```

`content:library` 保留为生成书库清单的兼容命令；站点相关操作统一使用 `web:*`。
