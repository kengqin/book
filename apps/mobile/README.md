# 移动端应用骨架

这里是 Android / iOS 的独立应用入口，不替换 `apps/desktop`。

当前阶段已完成：

- 移动端独立 Capacitor + Vue 构建边界
- 书架、搜索、设置三 Tab，以及书籍详情、目录和全屏阅读器
- TXT / EPUB 后台解析、EPUB 富文本清洗和阅读进度保存
- 浏览器 IndexedDB / Android+iOS SQLite 双存储适配
- 完整书库和单本书备份恢复
- Android APK 下载、SHA-256 校验和系统安装入口
- iOS TestFlight / App Store 跳转接口

原生工程位于 `android/` 和 `ios/`。iOS 的 Xcode 编译和 TestFlight 上传需要在 macOS + Xcode 环境执行。

本地运行：

```powershell
npm run dev --workspace @novel-library/mobile
```

Android 本地构建：

```powershell
npm run mobile:package:android
npm run mobile:package:android:debug
npm run mobile:package:android:release
```

推荐在仓库根目录使用上述增量打包命令。输入和现有产物均未变化时，会直接复用并跳过 Web、Capacitor 或 Gradle 阶段。需要无条件重建时执行 `npm run mobile:package:force`。

Release APK 已接入项目本地正式签名密钥和自动验签。完整缓存规则见 `docs/移动端增量打包流程.md`。
