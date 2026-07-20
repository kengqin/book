# Android 正式签名管理

Android 正式包使用项目独立的发布密钥。该密钥决定应用升级身份：所有后续 APK/AAB 必须继续使用同一密钥，否则已有用户无法覆盖安装升级。

## 项目内位置

真实文件统一存放在项目根目录：

```text
.release-local/android-signing/
├── novel-library-release.jks   # 正式私钥库
├── signing.properties          # Gradle 使用的本地配置和密码
└── IMPORTANT-credentials.txt   # 人工恢复凭据
```

整个 `.release-local/` 已被 Git 忽略，不会进入版本库。不要取消忽略，也不要把上述三个文件发送到公开网盘、聊天工具、邮件或源码仓库。

## 首次生成

在项目根目录执行：

```powershell
npm run mobile:android:signing:generate
```

生成参数：RSA 4096 位、SHA-256、PKCS#12 密钥库、有效期 10000 天，别名为 `novel-library-release`。脚本使用密码学安全随机源生成密码，并默认拒绝覆盖已有密钥。

## 构建和验证

同步移动端资源后构建正式 APK：

```powershell
npm run mobile:web:build
npm run mobile:native:sync
Set-Location apps/mobile/android
.\gradlew.bat clean assembleRelease
Set-Location ../../..
npm run mobile:android:signing:verify
```

签名后的 APK 位于：

```text
apps/mobile/android/app/build/outputs/apk/release/app-release.apk
```

验证脚本会检查密钥库、APK 的 v1/v2/v3 签名以及 APK 证书与正式密钥库的 SHA-256 指纹是否完全一致。v4 是 `adb` 增量安装使用的独立 `.idsig` 辅助文件，不是对外分发 APK 的内嵌签名要求。Release 构建在找不到本地密钥时会直接失败，避免误发未签名包。

## 必须执行的备份

把整个 `.release-local/android-signing/` 目录复制到至少两个独立的离线加密介质，并检查文件能够正常读取。建议一份由项目负责人保管，一份放在独立安全位置。备份后运行一次：

```powershell
npm run mobile:android:signing:verify
```

密钥丢失无法通过重新生成来补救；新密钥只能被 Android 识别为另一个应用。密码与密钥库放在一起只便于本机集中管理，离线备份必须整体加密。

## 换电脑恢复

将备份的 `android-signing` 目录原样放回新工作区的 `.release-local/` 下，安装 JDK 和 Android SDK，然后执行验证命令。不要再次运行生成命令。

## GitHub Actions 正式发布

Android 使用独立的 `mobile-v*` Tag，例如 `mobile-v0.1.0`。Tag 必须指向已经合并到 `main` 的提交。工作流会构建、验签并发布 APK，但显式保持 `latest=false`，不会覆盖桌面端依赖的 GitHub Latest Release。

首次发布前，在 GitHub 仓库 Actions Secrets 中配置：

- `ANDROID_SIGNING_KEYSTORE_BASE64`：`novel-library-release.jks` 的 Base64 内容。
- `ANDROID_SIGNING_PASSWORD`：生成签名时保存的密钥库密码；当前生成流程的私钥密码与其相同。

在本机生成 Base64 文本时不要输出到仓库文件，可复制到剪贴板后直接录入 GitHub Secret：

```powershell
$key = '.release-local/android-signing/novel-library-release.jks'
[Convert]::ToBase64String([IO.File]::ReadAllBytes($key)) | Set-Clipboard
```

发布前执行：

```powershell
npm test
npm run mobile:release:validate -- --tag=mobile-v0.1.0
npm run mobile:package:android:release
```

确认版本提交已进入 `main` 后创建并推送 Tag：

```powershell
git tag mobile-v0.1.0
git push origin mobile-v0.1.0
```

工作流会上传版本化 APK 和 `.sha256`，公开 Release 后把实际 APK SHA-256 回写到 `main` 的 `releases/mobile-releases.json`。正式发布后不得复用或覆盖同一版本 Tag。
