# NovelLibrary Local Runtime

`novel-library-runtime` 是三套 IDE 插件在本地模式下共享的独立书库服务。它只绑定 `127.0.0.1`，使用每次启动轮换的 Bearer token，不依赖桌面端、Node.js 或管理员权限。

## 命令

```powershell
novel-library-runtime.exe version
novel-library-runtime.exe serve --data-dir "D:\NovelLibraryData" --port 0
novel-library-runtime.exe doctor --data-dir "D:\NovelLibraryData"
```

数据目录包含 `library.db`、受管源文件 `sources/`、自动/手动备份 `backups/`、单实例锁 `runtime.lock` 和发现文件 `local-runtime.json`。`storageId` 保存在数据库元数据中，因此安全复制切换目录后保持稳定。

## 能力

- TXT（UTF-8、UTF-16LE/BE、GB18030）和 EPUB 导入。
- 后台导入任务、重复源 hash 去重、重新解析和删除。
- revision、clientId、sequence 驱动的进度冲突与幂等处理。
- `novel-library-backup` v1–v4 及旧 transfer v1 的备份恢复，并原样保留桌面端笔记数据以支持往返迁移。
- 恢复事务、覆盖恢复前自动备份、失败回滚和 schema 降级阻断。
- Runtime 状态、数据库完整性诊断、崩溃任务恢复和 stale discovery 恢复。

## 测试

```powershell
cargo test --manifest-path apps/local-runtime/Cargo.toml
npm run runtime:e2e
```

当前正式分发目标为 Windows x64。
