import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const files = [
  'apps/desktop/src-tauri/resources/ide-plugins/manifest.json',
  'apps/desktop/src-tauri/resources/ide-plugins/code-oss-wheel-injection.js',
  'apps/desktop/src-tauri/src/ide_integration.rs',
  'apps/desktop/src-tauri/src/bridge.rs',
  'apps/local-runtime/Cargo.toml',
  'apps/local-runtime/src/main.rs',
  'apps/desktop/src/views/IdeIntegrationView.vue',
  'plugins/vscode/package.json',
  'plugins/README.md',
  'plugins/vscode/bridge.js',
  'plugins/vscode/extension.js',
  'plugins/vscode/import-selection.js',
  'plugins/vscode/reader-utils.js',
  'plugins/vscode/wheel-bridge.js',
  'plugins/vscode/README.md',
  'plugins/vscode/LICENSE',
  'plugins/vscode/.vscodeignore',
  'plugins/vscode/media/novel-library.svg',
  'plugins/intellij/src/main/resources/META-INF/pluginIcon.svg',
  'plugins/intellij/src/main/resources/META-INF/pluginIcon_dark.svg',
  'plugins/intellij/build.gradle.kts',
  'plugins/intellij/gradle.properties',
  'plugins/intellij/README.md',
  'plugins/intellij/src/main/kotlin/com/kengqin/novellibrary/NovelLibraryPlugin.kt',
  'plugins/intellij/src/main/resources/META-INF/plugin.xml',
  'plugins/intellij/src/main/resources/icons/novelLibrary.svg',
  'plugins/visual-studio/NovelLibrary.VisualStudio.csproj',
  'plugins/visual-studio/README.md',
  'plugins/visual-studio/NovelLibraryBridge.cs',
  'plugins/visual-studio/NovelLibraryLocalSettings.cs',
  'plugins/visual-studio/NovelLibraryOptionsPage.cs',
  'plugins/visual-studio/NovelLibraryPackage.cs',
  'plugins/visual-studio/NovelLibraryReaderSession.cs',
  'plugins/visual-studio/NovelLibraryToolWindow.cs',
  'plugins/visual-studio/NovelLibraryAdornment.cs',
  'plugins/visual-studio/NovelLibraryCommands.cs',
  'plugins/visual-studio/NovelLibrary.vsct',
  'plugins/visual-studio/LICENSE',
  'plugins/visual-studio/source.extension.vsixmanifest',
  'packages/reader-protocol/src/index.ts',
  'scripts/install-ide-plugins.ps1',
  'scripts/package-visual-studio-plugin.ps1',
  'scripts/release/prepare-ide-plugin-reuse.mjs',
  'scripts/stage-ide-plugin-runtime.ps1',
  'scripts/verify-ide-plugin-runtime.ps1',
  'scripts/test-local-runtime-e2e.mjs',
  '.github/workflows/build-ide-plugins.yml',
  '.github/workflows/release-desktop.yml'
]

const sources = new Map()
for (const file of files) sources.set(file, await readFile(join(root, file), 'utf8'))
for (const file of ['plugins/vscode/media/novel-library.png', 'plugins/visual-studio/Icon.png']) await access(join(root, file))
const source = file => sources.get(file)
const requireMatch = (value, pattern, message) => {
  if (!pattern.test(value)) throw new Error(message)
}
const requireValue = (condition, message) => {
  if (!condition) throw new Error(message)
}

const vscode = JSON.parse(source('plugins/vscode/package.json'))
const semver = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)
requireValue(semver(vscode.version), 'VS Code extension version must be valid SemVer')
requireValue(vscode.displayName === '小说书库阅读器', 'VS Code extension display name must identify the plugin')
requireValue(vscode.description?.includes('五行只读正文') && vscode.description?.includes('阅读进度同步'), 'VS Code marketplace description must be detailed and formal')
requireValue(vscode.main === 'extension.js', 'VS Code extension entry point is missing')
requireValue(vscode.icon === 'media/novel-library.png', 'VS Code marketplace must use the shared desktop icon')
requireValue(vscode.activationEvents?.includes('onStartupFinished'), 'VS Code automatic startup is missing')
requireValue(vscode.contributes?.viewsContainers?.activitybar?.some(item => item.id === 'novelLibrary'), 'VS Code activity bar container is missing')
requireValue(vscode.contributes?.views?.novelLibrary?.some(item => item.id === 'novelLibrary.reader'), 'VS Code reader sidebar is missing')
const vscodeViewCommands = new Set(vscode.contributes?.menus?.['view/title']?.map(item => item.command))
for (const command of ['novelLibrary.showReader', 'novelLibrary.hideReader', 'novelLibrary.previousLine', 'novelLibrary.nextLine', 'novelLibrary.previousChapter', 'novelLibrary.nextChapter', 'novelLibrary.refreshLibrary', 'novelLibrary.showShortcuts']) {
  requireValue(vscodeViewCommands.has(command), `VS Code reader toolbar command is missing: ${command}`)
}
requireValue(!vscodeViewCommands.has('novelLibrary.deleteCurrentBook'), 'VS Code delete action must not stay in the reader title overflow menu')
const vscodeBookContextDelete = vscode.contributes?.menus?.['view/item/context']?.find(item => item.command === 'novelLibrary.deleteCurrentBook')
requireValue(vscodeBookContextDelete?.when?.includes('viewItem == book') && vscodeBookContextDelete.when.includes('viewItem == currentBook') && vscodeBookContextDelete.when.includes('!novelLibrary.useDesktopLibrary'), 'VS Code delete action must be scoped to local book context menus')
const vscodeDeleteCommand = vscode.contributes?.commands?.find(item => item.command === 'novelLibrary.deleteCurrentBook')
requireValue(vscodeDeleteCommand?.title === '删除本地书籍' && vscodeDeleteCommand.category === '小说书库', 'VS Code book context delete label must stay concise')
const vscodeKeys = new Set(vscode.contributes?.keybindings?.map(item => item.key))
for (const key of ['ctrl+alt+n', 'ctrl+alt+9', 'ctrl+alt+up', 'ctrl+alt+down', 'ctrl+alt+left', 'ctrl+alt+right', 'ctrl+alt+d']) {
  requireValue(vscodeKeys.has(key), `VS Code keybinding is missing: ${key}`)
}
const vscodeExtension = source('plugins/vscode/extension.js')
const vscodeImportSelection = source('plugins/vscode/import-selection.js')
requireMatch(vscodeExtension, /MODAL_CANCEL_ACTION = Object\.freeze\(\{ title: '取消', isCloseAffordance: true \}\)/, 'VS Code modal dialogs must use a single localized close affordance')
requireMatch(vscodeExtension, /if \(!\['复制并切换', '空目录切换'\]\.includes\(copyChoice\)\) return/, 'VS Code directory migration must stop for the modal close affordance')
requireMatch(vscodeExtension, /if \(!\['合并恢复', '清空并恢复'\]\.includes\(choice\)\) return/, 'VS Code restore must stop for the modal close affordance')
requireMatch(vscodeExtension, /slice\(state\.lineStart, state\.lineStart \+ 5\)/, 'VS Code five-line reader is missing')
requireMatch(vscodeExtension, /createTextEditorDecorationType/, 'VS Code inline editor decorations are missing')
requireValue(!vscodeExtension.includes('hoverMessage:'), 'VS Code inline reader hover popup must not obscure novel content')
requireMatch(vscodeExtension, /displayMode === 'paragraph'/, 'VS Code paragraph display mode is missing')
requireMatch(vscodeExtension, /displayMode.*lineEnd/, 'VS Code original line-end display mode is missing')
requireMatch(vscodeExtension, /const INLINE_CHAPTER_CONTROLS_ENABLED = false/, 'VS Code inline chapter buttons must remain temporarily hidden')
requireMatch(vscodeExtension, /const contentText = text/, 'VS Code fixed header must render progress text without chapter buttons')
requireMatch(vscodeExtension, /toggleDisplayMode/, 'VS Code display mode toggle is missing')
requireMatch(vscodeExtension, /createTreeView\('novelLibrary\.reader'/, 'VS Code reader sidebar provider is missing')
requireMatch(vscodeExtension, /registerCommand\('novelLibrary\.selectBook'/, 'VS Code book selection command is missing')
requireMatch(vscodeExtension, /registerCommand\('novelLibrary\.selectChapter'/, 'VS Code chapter selection command is missing')
requireMatch(vscodeExtension, /label: `书架 \(\$\{state\.books\.length\}\)`/, 'VS Code bookshelf section is missing')
requireMatch(vscodeExtension, /label: `章节 \(\$\{state\.chapters\.length\}\)`/, 'VS Code chapter section is missing')
requireMatch(vscodeExtension, /type: 'content'/, 'VS Code content section is missing')
requireMatch(vscodeExtension, /registerCommand\('novelLibrary\.openBookFromSidebar'/, 'VS Code direct sidebar book selection is missing')
requireMatch(vscodeExtension, /arguments: \[book\],[\s\S]*book,[\s\S]*contextValue: current \? 'currentBook' : 'book'/, 'VS Code book tree items must carry their book payload for context actions')
requireMatch(vscodeExtension, /registerCommand\('novelLibrary\.openChapterFromSidebar'/, 'VS Code direct sidebar chapter selection is missing')
requireMatch(vscodeExtension, /const scheduleReconnect = \(delay = 0\) =>[\s\S]*reader\.loadLibrary\(\)[\s\S]*scheduleReconnect\(3000\)/, 'VS Code automatic library reconnection is missing')
requireMatch(vscodeExtension, /onDidChangeVisibility[\s\S]*onDidChangeWindowState/, 'VS Code reconnect triggers are missing')
requireMatch(vscodeExtension, /setContext', 'novelLibrary\.readerEnabled', state\.enabled/, 'VS Code library sync must preserve the reader visibility preference')
requireMatch(vscodeExtension, /for \(let attempts = 0;[\s\S]*attempts < 30/, 'VS Code empty-chapter skipping is missing')
requireMatch(vscodeExtension, /chapter\.kind === 'chapter'/, 'VS Code non-content chapter filtering is missing')
requireMatch(vscodeExtension, /state\.chapters\.map\(\(chapter, index\)[\s\S]*`第 \$\{index \+ 1\} 章`/, 'VS Code chapter list must show sequential readable chapter numbers')
requireMatch(vscodeExtension, /storage\.update\('novelLibrary\.readerEnabled'/, 'VS Code reader visibility preference is missing')
requireMatch(vscodeExtension, /const position = state\.book && state\.chapter[\s\S]*lineStart: state\.lineStart[\s\S]*loadBook\(book, position\?\.bookId === book\.id \? position : undefined\)/, 'VS Code bookshelf refresh must preserve the current reading position')
requireMatch(vscodeExtension, /restoredProgress = !position[\s\S]*resolvedBook\.chapterProgress/, 'VS Code startup must read the saved chapter progress')
requireMatch(vscodeExtension, /lineStartFromProgress\(lines\.length, restoredProgress\)/, 'VS Code startup must restore the saved chapter line')
requireMatch(vscodeExtension, /await persistProgress\(\)/, 'VS Code progress writes must complete before reader actions return')
requireMatch(vscodeExtension, /let progressWriteQueue = Promise\.resolve\(\)[\s\S]*progressWriteQueue = write\.catch/, 'VS Code progress writes must remain serialized')
requireMatch(vscodeExtension, /pendingProgressStorageKey[\s\S]*rememberPendingProgress[\s\S]*replayPendingProgress/, 'VS Code failed progress writes must persist per provider and replay')
requireMatch(vscodeExtension, /getProviderIdentity\(\)[\s\S]*bookId/, 'VS Code pending progress keys must include provider storage identity and book id')
requireMatch(vscodeExtension, /const progressClientId = crypto\.randomUUID\(\)[\s\S]*let progressSequence = 0/, 'VS Code progress identity must be isolated per extension-host process')
requireValue(!vscodeExtension.includes("storage.get('novelLibrary.progressClientId')"), 'VS Code must not share a progress client identity across parallel windows')
requireMatch(vscodeExtension, /rememberProgress[\s\S]*currentChapter: chapterNumber[\s\S]*chapterProgress/, 'VS Code must update its in-memory book progress after every move')
requireMatch(vscodeExtension, /flushCurrentBookProgress[\s\S]*latestBook\(book\)/, 'VS Code book switching must flush writes and reload persisted progress')
requireMatch(vscodeExtension, /resetProvider[\s\S]*progressWriteQueue[\s\S]*state\.book = null/, 'VS Code provider switching must flush progress and isolate provider state')
requireValue(!/moveLines = async direction => \{\s*if \(!state\.enabled\) await toggle\(true\)/.test(vscodeExtension), 'VS Code line shortcuts must not force hidden reading back on')
requireValue(vscode.contributes?.commands?.some(item => item.command === 'novelLibrary.showShortcuts' && item.icon === '$(keyboard)'), 'VS Code shortcut-help button is missing')
requireMatch(vscodeExtension, /registerCommand\('novelLibrary\.showShortcuts'[\s\S]*小说书库快捷键[\s\S]*Ctrl\+Alt\+D/, 'VS Code shortcut-help dialog is incomplete')
requireMatch(vscodeExtension, /registerCommand\('novelLibrary\.configureShortcuts'/, 'VS Code custom shortcut command is missing')
requireMatch(vscodeExtension, /openGlobalKeybindings[\s\S]*@ext:novel-library\.novel-library-reader/, 'VS Code custom shortcut settings entry is missing')
requireMatch(vscodeExtension, /request\('\/v1\/show', \{ method: 'POST' \}\)[\s\S]*openDesktopApp\(\)/, 'VS Code desktop launch must use Bridge with a local process fallback')
const vscodeBridge = source('plugins/vscode/bridge.js')
const vscodeWheelBridge = source('plugins/vscode/wheel-bridge.js')
const codeOssWheelInjection = source('apps/desktop/src-tauri/resources/ide-plugins/code-oss-wheel-injection.js')
requireMatch(vscodeBridge, /AbortSignal\.timeout\(5000\)/, 'VS Code Bridge timeout must be five seconds')
requireMatch(vscodeBridge, /waitForImportJob[\s\S]*\/v2\/import-jobs/, 'VS Code local imports must poll background jobs')
requireMatch(vscodeBridge, /retainSource:[\s\S]*retainManagedSource/, 'VS Code managed-source retention setting is not sent to Runtime imports')
requireMatch(vscodeBridge, /\/v2\/runtime\/status[\s\S]*dataDirectory/, 'VS Code must validate the Runtime data directory')
requireMatch(vscodeBridge, /requiredCapabilities[\s\S]*progress\.v2[\s\S]*import\.idempotency[\s\S]*runtime\.diagnostics[\s\S]*runtime\.check-database[\s\S]*epub\.structure\.v2/, 'VS Code Runtime capability negotiation is incomplete')
requireMatch(vscodeBridge, /providerSettings\.useDesktopLibrary[\s\S]*\['books', 'chapters', 'progress'\][\s\S]*Bridge 会话已失效/, 'VS Code desktop Bridge capability and session negotiation is incomplete')
requireMatch(vscodeBridge, /minimumClientProtocolVersion[\s\S]*isRuntimeCompatible[\s\S]*PROTOCOL_INCOMPATIBLE/, 'VS Code must reject a Runtime that requires a newer client')
requireMatch(vscodeBridge, /error\.code === 'PROTOCOL_INCOMPATIBLE'\) throw error/, 'VS Code must not terminate a Runtime that requires a newer client')
requireMatch(vscodeBridge, /getProviderIdentity[\s\S]*storageId/, 'VS Code provider identity must use the persistent storage id')
requireMatch(vscodeBridge, /runtime-manifest\.json[\s\S]*\.sha256[\s\S]*createHash\('sha256'\)[\s\S]*\['version'\]/, 'VS Code bundled Runtime integrity and version verification is incomplete')
for (const contract of [/install\.lock/, /active\.json/, /['"]versions['"]/, /previousVersion/]) {
  requireMatch(vscodeBridge, contract, 'VS Code shared Runtime installation, activation and rollback metadata are incomplete')
}
requireMatch(vscodeBridge, /migration\.lock/, 'VS Code local directory migration lock is missing')
requireMatch(vscodeBridge, /Connection: 'close'/, 'VS Code Bridge must close each local HTTP connection')
requireMatch(vscodeBridge, /novel-library-desktop/, 'VS Code Bridge must resolve the running desktop installation')
requireMatch(vscodeBridge, /ShowWindowAsync[\s\S]*SetForegroundWindow[\s\S]*Start-Process/, 'VS Code desktop fallback must restore or launch the installed desktop app')
requireValue(!vscodeExtension.includes('novellibrary://'), 'VS Code must not use an unregistered desktop URL scheme')
requireMatch(vscodeExtension, /createWheelBridge[\s\S]*wheelBridge\.markerCss\(\)/, 'VS Code loopback wheel bridge marker is missing')
for (const command of ['deleteCurrentBook', 'reparseCurrentBook', 'backupCurrentLibrary', 'restoreCurrentLibrary', 'openDiagnostics']) {
  requireMatch(vscodeExtension, new RegExp(`registerCommand\\('novelLibrary\\.${command}'`), `VS Code local maintenance command is missing: ${command}`)
}
requireMatch(vscodeExtension, /registerCommand\('novelLibrary\.deleteCurrentBook', async item =>[\s\S]*const selectedBook = item\?\.book \|\| state\.book[\s\S]*encodeURIComponent\(selectedBook\.id\)/, 'VS Code delete action must delete the right-clicked book')
requireMatch(vscodeExtension, /registerCommand\('novelLibrary\.importFile'[\s\S]*selectImportFile\(vscode\.window, uri\)/, 'VS Code import command must delegate to the file picker')
requireMatch(vscodeImportSelection, /IMPORT_DIALOG_OPTIONS[\s\S]*canSelectFiles: true[\s\S]*txt[\s\S]*epub[\s\S]*showOpenDialog\(IMPORT_DIALOG_OPTIONS\)/, 'VS Code import command must open a TXT/EPUB file picker')
requireValue(!vscodeExtension.includes('activeTextEditor?.document.uri'), 'VS Code import command must not silently use the active editor file')
requireMatch(vscodeExtension, /const wheelMarker = wheelBridge\.markerCss\(\)[\s\S]*textDecoration: `none; \$\{wheelMarker\}/, 'VS Code editor decorations must expose the injected wheel marker')
requireMatch(vscodeWheelBridge, /server\.listen\(0, '127\.0\.0\.1'/, 'VS Code wheel bridge must bind to a random loopback port')
requireMatch(vscodeWheelBridge, /randomBytes\(18\)/, 'VS Code wheel bridge must authenticate injected clients')
requireMatch(codeOssWheelInjection, /document\.addEventListener\('wheel'[\s\S]*preventDefault\(\)[\s\S]*stopImmediatePropagation\(\)/, 'Code OSS wheel injection must consume wheel events only after decoration hit-testing')
requireMatch(codeOssWheelInjection, /getComputedStyle\(element, pseudo\)[\s\S]*--novel-library-wheel/, 'Code OSS wheel injection decoration hit-testing is missing')
const desktopBridge = source('apps/desktop/src-tauri/src/bridge.rs')
requireMatch(desktopBridge, /method == "POST" && path == "\/v1\/show"[\s\S]*show_main_window/, 'Desktop Bridge show-window endpoint is missing')

const intellijBuild = source('plugins/intellij/build.gradle.kts')
const intellijXml = source('plugins/intellij/src/main/resources/META-INF/plugin.xml')
const intellijCode = source('plugins/intellij/src/main/kotlin/com/kengqin/novellibrary/NovelLibraryPlugin.kt')
const intellijIcon = source('plugins/intellij/src/main/resources/icons/novelLibrary.svg')
const intellijPluginIcon = source('plugins/intellij/src/main/resources/META-INF/pluginIcon.svg')
const intellijPluginIconDark = source('plugins/intellij/src/main/resources/META-INF/pluginIcon_dark.svg')
const intellijVersion = intellijBuild.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
requireValue(semver(intellijVersion), 'JetBrains plugin version must be valid SemVer')
requireMatch(intellijBuild, /jvmTarget = JvmTarget\.JVM_17/, 'JetBrains Kotlin bytecode must target Java 17')
requireMatch(intellijBuild, /targetCompatibility = JavaVersion\.VERSION_17/, 'JetBrains Java bytecode must target Java 17')
requireMatch(intellijBuild, /pluginVerification[\s\S]*IntellijIdeaCommunity[\s\S]*2024\.1/, 'JetBrains plugin verifier target is missing')
requireValue(source('plugins/intellij/gradle.properties').includes('kotlin.stdlib.default.dependency=false'), 'JetBrains plugin must use the platform Kotlin standard library')
requireMatch(intellijXml, /<toolWindow id="小说书库"[^>]+icon="\/icons\/novelLibrary\.svg"/, 'JetBrains tool window icon is missing')
for (const detail of ['Core features', 'without modifying project files', 'localhost desktop Bridge']) {
  requireValue(intellijXml.includes(detail), `JetBrains marketplace description is missing: ${detail}`)
}
requireMatch(source('plugins/vscode/media/novel-library.svg'), /M1\.25 3\.15C3\.6/, 'VS Code activity bar must use the shared book icon shape')
requireMatch(intellijIcon, /M1\.25 3\.15C3\.6/, 'JetBrains tool window must use the shared book icon shape')
for (const icon of [intellijPluginIcon, intellijPluginIconDark]) {
  requireMatch(icon, /M91 137c60-16/, 'JetBrains marketplace must use the shared desktop book icon')
  requireMatch(icon, /M338 125h43v132/, 'JetBrains marketplace icon bookmark is missing')
}
requireMatch(intellijXml, /<postStartupActivity/, 'JetBrains automatic startup activity is missing')
requireMatch(intellijXml, /<applicationConfigurable[^>]+NovelLibraryApplicationConfigurable/, 'JetBrains application-level local Runtime settings page is missing')
for (const shortcut of ['ctrl alt N', 'ctrl alt UP', 'ctrl alt DOWN', 'ctrl alt LEFT', 'ctrl alt RIGHT']) {
  requireValue(intellijXml.includes(`first-keystroke="${shortcut}"`), `JetBrains keybinding is missing: ${shortcut}`)
}
requireMatch(intellijXml, /action id="NovelLibrary\.ToggleReaderVisibility"[\s\S]*?<keyboard-shortcut first-keystroke="ctrl alt N"/, 'JetBrains Ctrl+Alt+N must toggle code-inline reading')
requireMatch(intellijXml, /action id="NovelLibrary\.ToggleDisplayMode"[\s\S]*?<keyboard-shortcut first-keystroke="ctrl alt 9"/, 'JetBrains Ctrl+Alt+9 must toggle the reader display mode')
requireMatch(intellijCode, /take\(5\)/, 'JetBrains five-line reader is missing')
requireMatch(intellijCode, /addAfterLineEndElement/, 'JetBrains inline editor inlays are missing')
requireMatch(intellijCode, /addInlineElement/, 'JetBrains paragraph editor inlays are missing')
requireMatch(intellijCode, /ReaderDisplayMode\.PARAGRAPH/, 'JetBrains paragraph display mode is missing')
requireMatch(intellijCode, /ReaderDisplayMode\.LINE_END/, 'JetBrains original line-end display mode is missing')
requireMatch(intellijCode, /private const val INLINE_CHAPTER_CONTROLS_ENABLED = false/, 'JetBrains inline chapter buttons must remain temporarily hidden')
requireMatch(intellijCode, /class WrapLayout[\s\S]*availableWidth/, 'JetBrains reader toolbar must wrap instead of clipping actions')
requireMatch(intellijCode, /object ReaderVisibilitySettings/, 'JetBrains reader visibility preference is missing')
requireMatch(intellijCode, /class ToggleReaderVisibilityAction/, 'JetBrains reader visibility action is missing')
requireMatch(intellijCode, /addMouseWheelListener[\s\S]*wheelRotation[\s\S]*moveLine/, 'JetBrains reader areas must support mouse-wheel line navigation')
requireMatch(intellijCode, /AWTEventListener[\s\S]*inlays\[editor\][\s\S]*bounds\?\.contains\(point\)/, 'JetBrains editor wheel navigation must only consume events over reader inlays')
requireMatch(intellijCode, /isDescendingFrom\(event\.component, it\.component\)[\s\S]*convertPoint\(event\.component, event\.point, editor\.contentComponent\)/, 'JetBrains wheel hit testing must accept events from the full editor component tree')
requireMatch(intellijCode, /if \(overReader\) \{\s*event\.consume\(\)[\s\S]*moveLine/, 'JetBrains reader wheel navigation must consume only inlay hits')
requireValue(!/contentComponent\.addMouseWheelListener/.test(intellijCode), 'JetBrains reader must not steal wheel events from the editor content component')
requireMatch(intellijCode, /val attempts = if \(method == "GET"\) 3 else 1/, 'JetBrains Bridge GET retry is missing')
requireMatch(intellijCode, /连接中断，正在重试/, 'JetBrains session reconnect handling is missing')
requireMatch(intellijCode, /val refresh = JButton\("刷新"\)/, 'JetBrains manual reader refresh is missing')
requireMatch(intellijCode, /fun reload\(\)[\s\S]*loadBooks\(preservePosition = true\)/, 'JetBrains reader refresh must preserve the current reading position')
requireMatch(intellijCode, /chapterProgress: Double[\s\S]*lineStartFromProgress/, 'JetBrains startup must restore the saved chapter progress')
requireMatch(intellijCode, /newSingleThreadExecutor[\s\S]*awaitProgressWrites/, 'JetBrains progress writes must remain serialized')
requireMatch(intellijCode, /flushProgressWrites[\s\S]*resetForProviderSwitch/, 'JetBrains provider switching must flush progress and isolate provider state')
requireMatch(intellijCode, /fun book\(bookId: String\)[\s\S]*send\("\/v1\/books\/\$id"\)/, 'JetBrains book switching must reload persisted progress')
requireMatch(intellijCode, /updatedBook = book\.copy\(currentChapter = chapter\.number, chapterProgress = progress\)/, 'JetBrains must update its in-memory book progress after every move')
requireMatch(intellijCode, /JButton\("快捷键"\)[\s\S]*showShortcutHelp/, 'JetBrains shortcut-help button is missing')
requireMatch(intellijCode, /KeymapManager[\s\S]*activeShortcut[\s\S]*打开 Keymap 设置/, 'JetBrains shortcut help must use the active customizable Keymap')
requireMatch(intellijCode, /JButton\("自定义快捷键"\)[\s\S]*openShortcutSettings/, 'JetBrains custom shortcut settings entry is missing')
requireMatch(intellijCode, /showSettingsDialog\(project, KeymapPanel::class\.java\)[\s\S]*selectAction\("NovelLibrary\.ToggleReaderVisibility"\)/, 'JetBrains custom shortcut settings must open Keymap by configurable class and select a plugin action')
requireValue(!intellijCode.includes('showSettingsDialog(project, "preferences.keymap")'), 'JetBrains must not pass the Keymap configurable ID to the display-name overload')
requireMatch(intellijCode, /while \(resultLines\.isEmpty\(\) && attempts < 30\)/, 'JetBrains empty-chapter skipping is missing')
requireMatch(intellijCode, /it\.kind == null \|\| it\.kind == "chapter"/, 'JetBrains non-content chapter filtering is missing')
requireMatch(intellijCode, /mapIndexed \{ index, chapter -> chapter\.copy\(ordinal = index \+ 1\) \}/, 'JetBrains chapter list must assign sequential readable chapter numbers')
requireMatch(intellijCode, /timeout\(Duration\.ofSeconds\(5\)\)/, 'JetBrains Bridge timeout must be five seconds')
requireMatch(intellijCode, /validateLocalConfig[\s\S]*\/v2\/runtime\/status/, 'JetBrains must health-check local Runtime discovery')
requireMatch(intellijCode, /capabilities\.containsAll[\s\S]*runtime\.diagnostics[\s\S]*epub\.structure\.v2/, 'JetBrains Runtime capability negotiation is incomplete')
requireMatch(intellijCode, /\/v2\/import-jobs[\s\S]*"completed"/, 'JetBrains local imports must poll background jobs')
requireMatch(intellijCode, /class ImportFileAction[\s\S]*JFileChooser\(\)[\s\S]*showOpenDialog[\s\S]*selectedFile/, 'JetBrains import action must open a local file picker')
for (const method of ['deleteBook', 'reparseBook', 'exportLibrary', 'importLibrary', 'diagnostics']) {
  requireMatch(intellijCode, new RegExp(`fun ${method}\\(`), `JetBrains local maintenance method is missing: ${method}`)
}
requireMatch(intellijCode, /migration\.lock/, 'JetBrains local directory migration lock is missing')
for (const contract of [/runtime-manifest\.json/, /novel-library-runtime\.exe\.sha256/, /MessageDigest\.getInstance\("SHA-256"\)/, /ProcessBuilder\(executable\.toString\(\), "version"\)/]) {
  requireMatch(intellijCode, contract, 'JetBrains bundled Runtime integrity and version verification is incomplete')
}
for (const contract of [/install\.lock/, /active\.json/, /resolve\("versions"\)/, /previousVersion/]) {
  requireMatch(intellijCode, contract, 'JetBrains shared Runtime installation, activation and rollback metadata are incomplete')
}
requireMatch(intellijCode, /import\.idempotency[\s\S]*runtime\.check-database[\s\S]*epub\.structure\.v2/, 'JetBrains Runtime capability negotiation is incomplete')
requireMatch(intellijCode, /RETAIN_MANAGED_SOURCE[\s\S]*retainSource/, 'JetBrains managed-source retention setting is incomplete')
requireMatch(intellijCode, /PENDING_PROGRESS[\s\S]*savePendingProgress[\s\S]*replayPendingProgress/, 'JetBrains failed progress writes must persist per provider and replay')
requireMatch(intellijCode, /progressProviderKey[\s\S]*storageId[\s\S]*::\$bookId/, 'JetBrains pending progress keys must include provider storage identity and book id')
requireMatch(intellijCode, /minimumClientProtocolVersion[\s\S]*需要更新版插件[\s\S]*不会覆盖或终止它/, 'JetBrains must preserve a Runtime that requires a newer client')
requireMatch(intellijCode, /progressClientId = "jetbrains-\$\{UUID\.randomUUID\(\)\}"[\s\S]*progressSequence = AtomicLong\(\)[\s\S]*incrementAndGet\(\)/, 'JetBrains progress identity must be isolated per IDE process')
requireMatch(intellijCode, /validateDesktopConfig[\s\S]*\/v1\/manifest[\s\S]*setOf\("books", "chapters", "progress"\)/, 'JetBrains desktop Bridge capability and session negotiation is incomplete')
requireMatch(intellijCode, /ProcessHandle\.allProcesses/, 'JetBrains Bridge must resolve the running desktop installation')
for (const action of ['PreviousLineAction', 'NextLineAction', 'PreviousChapterAction', 'NextChapterAction']) {
  requireMatch(
    intellijCode,
    new RegExp(`class ${action}[^]*?ReaderSessions\\.get\\(it\\)\\.move(?:Line|Chapter)\\(`),
    `JetBrains ${action} must update the background reader session without opening the tool window`,
  )
}

const visualProject = source('plugins/visual-studio/NovelLibrary.VisualStudio.csproj')
const visualManifest = source('plugins/visual-studio/source.extension.vsixmanifest')
const visualVsct = source('plugins/visual-studio/NovelLibrary.vsct')
const visualSession = source('plugins/visual-studio/NovelLibraryReaderSession.cs')
const visualAdornment = source('plugins/visual-studio/NovelLibraryAdornment.cs')
requireMatch(visualProject, /<TargetFramework>net472<\/TargetFramework>/, 'Visual Studio target framework is missing')
requireMatch(visualProject, /novel-library-visual-studio-\$\(Version\)\.vsix/, 'Official Visual Studio VSIX output is missing')
requireMatch(visualProject, /<Content Include="Icon\.png"><IncludeInVSIX>true<\/IncludeInVSIX><\/Content>/, 'Visual Studio shared icon must be included in the VSIX')
requireMatch(visualProject, /runtime\\win32-x64\\novel-library-runtime\.exe/, 'Visual Studio Runtime payload is missing')
const visualVersion = visualManifest.match(/Identity Id="NovelLibrary\.VisualStudio" Version="([^"]+)"/)?.[1]
requireValue(semver(visualVersion), 'Visual Studio extension version must be valid SemVer')
requireMatch(visualManifest, /Microsoft\.VisualStudio\.VsPackage/, 'Visual Studio package asset is missing')
requireMatch(visualManifest, /Microsoft\.VisualStudio\.MefComponent/, 'Visual Studio editor component asset is missing')
requireMatch(visualManifest, /<Icon>Icon\.png<\/Icon>/, 'Visual Studio marketplace must use the shared desktop icon')
requireMatch(visualManifest, /五行只读正文[\s\S]*本机 Bridge[\s\S]*不会修改项目文件/, 'Visual Studio marketplace description must explain features and data boundaries')
for (const readme of ['plugins/vscode/README.md', 'plugins/intellij/README.md', 'plugins/visual-studio/README.md']) {
  const value = source(readme)
  for (const section of ['核心功能', '默认快捷键', '数据与隐私', '故障排查']) {
    requireValue(value.includes(`## ${section}`), `${readme} is missing its ${section} section`)
  }
}
for (const key of ['N', 'VK_UP', 'VK_DOWN', 'VK_LEFT', 'VK_RIGHT']) {
  requireValue(visualVsct.includes(`key1="${key}"`), `Visual Studio keybinding is missing: ${key}`)
}
requireMatch(visualVsct, /KeyBinding[^>]+id="ToggleReaderVisibility"[^>]+key1="N"[^>]+mod1="CONTROL ALT"/, 'Visual Studio Ctrl+Alt+N must toggle code-inline reading')
requireMatch(visualVsct, /KeyBinding[^>]+id="ToggleDisplayMode"[^>]+key1="9"[^>]+mod1="CONTROL ALT"/, 'Visual Studio Ctrl+Alt+9 must toggle the reader display mode')
requireMatch(source('plugins/visual-studio/NovelLibraryCommands.cs'), /0x0105[\s\S]*NovelLibraryReaderSession\.ToggleVisibility|NovelLibraryReaderSession\.ToggleVisibility\(\)[\s\S]*0x0105/, 'Visual Studio reader visibility command is missing')
requireMatch(visualSession, /Take\(5\)/, 'Visual Studio five-line reader is missing')
requireMatch(visualSession, /attempts < 30/, 'Visual Studio empty-chapter skipping is missing')
requireMatch(visualSession, /item\.Kind == "chapter"/, 'Visual Studio non-content chapter filtering is missing')
requireMatch(visualSession, /Chapters\[index\]\.Ordinal = index \+ 1/, 'Visual Studio chapter list must assign sequential readable chapter numbers')
requireMatch(visualAdornment, /IAdornmentLayer/, 'Visual Studio inline editor adornments are missing')
requireMatch(visualAdornment, /ReaderDisplayMode\.Paragraph/, 'Visual Studio paragraph display mode is missing')
requireMatch(visualAdornment, /private static readonly bool InlineChapterControlsEnabled = false;/, 'Visual Studio inline chapter buttons must remain temporarily hidden')
requireMatch(visualAdornment, /PreviewMouseWheel[\s\S]*_readerRegions[\s\S]*MoveLineAsync/, 'Visual Studio inline reader must support hover wheel navigation')
requireMatch(visualAdornment, /if \(!_readerRegions\.Any\(region => region\.Contains\(point\)\)\) return;\s*args\.Handled = true;/, 'Visual Studio reader must leave wheel events outside reader regions untouched')
requireMatch(source('plugins/visual-studio/NovelLibraryToolWindow.cs'), /_contentScroll\.PreviewMouseWheel[\s\S]*MoveLineAsync/, 'Visual Studio reader panel must support hover wheel navigation')
requireMatch(source('plugins/visual-studio/NovelLibraryToolWindow.cs'), /Content = "快捷键"[\s\S]*ShortcutHelp\.Show[\s\S]*Ctrl\+Alt\+N[\s\S]*Ctrl\+Alt\+9[\s\S]*Ctrl\+Alt\+→/, 'Visual Studio shortcut-help button or dialog is incomplete')
requireMatch(source('plugins/visual-studio/NovelLibraryToolWindow.cs'), /Content = "自定义快捷键"[\s\S]*OpenKeyboardSettings[\s\S]*Tools\.Options[\s\S]*Environment\.Keyboard/, 'Visual Studio custom shortcut settings entry is missing')
requireMatch(visualVsct, /id="ShowShortcuts"[\s\S]*小说书库：查看快捷键/, 'Visual Studio shortcut-help menu command is missing')
requireMatch(visualSession, /visual-studio-reader-visible\.txt[\s\S]*IsReaderVisible/, 'Visual Studio reader visibility preference is missing')
requireMatch(visualAdornment, /if \(!NovelLibraryReaderSession\.IsReaderVisible\) return;/, 'Visual Studio hidden reader must remove editor adornments')
requireMatch(visualSession, /ReaderDisplayMode\.LineEnd/, 'Visual Studio original line-end display mode is missing')
requireMatch(visualSession, /ChapterProgress[\s\S]*LineStartFromProgress/, 'Visual Studio startup must restore the saved chapter progress')
requireMatch(visualSession, /Gate\.WaitAsync[\s\S]*MoveLineAsync[\s\S]*Gate\.WaitAsync/, 'Visual Studio reader mutations must be serialized')
requireMatch(visualSession, /ResetForProviderSwitch[\s\S]*FlushProgressAsync/, 'Visual Studio provider switching must flush progress and isolate provider state')
requireMatch(visualSession, /Bridge\.GetAsync<BookItem>\([\s\S]*Uri\.EscapeDataString\(book\.Id\)[\s\S]*latestBook\.ChapterProgress/, 'Visual Studio book switching must reload persisted progress')
requireMatch(visualSession, /CurrentBook\.CurrentChapter = chapterNumber[\s\S]*CurrentBook\.ChapterProgress = chapterProgress/, 'Visual Studio must update its in-memory book progress after every move')
requireMatch(source('plugins/visual-studio/NovelLibraryBridge.cs'), /Timeout = TimeSpan\.FromSeconds\(5\)/, 'Visual Studio Bridge timeout must be five seconds')
requireMatch(source('plugins/visual-studio/NovelLibraryBridge.cs'), /ConnectionClose = true/, 'Visual Studio Bridge must close each local HTTP connection')
requireMatch(source('plugins/visual-studio/NovelLibraryBridge.cs'), /GetProcessesByName/, 'Visual Studio Bridge must resolve the running desktop installation')
requireMatch(source('plugins/visual-studio/NovelLibraryBridge.cs'), /Assembly\.Location[\s\S]*runtime[\s\S]*win32-x64/, 'Visual Studio must resolve Runtime relative to the installed extension')
requireMatch(source('plugins/visual-studio/NovelLibraryBridge.cs'), /ValidateLocalRuntimeAsync[\s\S]*\/v2\/runtime\/status/, 'Visual Studio must health-check local Runtime discovery')
requireMatch(source('plugins/visual-studio/NovelLibraryBridge.cs'), /ValidateDesktopBridgeAsync[\s\S]*\/v1\/manifest[\s\S]*"books", "chapters", "progress"/, 'Visual Studio desktop Bridge capability and session negotiation is incomplete')
requireMatch(source('plugins/visual-studio/NovelLibraryBridge.cs'), /required[\s\S]*runtime\.diagnostics[\s\S]*epub\.structure\.v2/, 'Visual Studio Runtime capability negotiation is incomplete')
for (const contract of [/runtime-manifest\.json/, /\.sha256/, /SHA256\.Create\(\)/, /Arguments = "version"/]) {
  requireMatch(source('plugins/visual-studio/NovelLibraryBridge.cs'), contract, 'Visual Studio bundled Runtime integrity and version verification is incomplete')
}
for (const contract of [/install\.lock/, /active\.json/, /"versions"/, /PreviousVersion/]) {
  requireMatch(source('plugins/visual-studio/NovelLibraryBridge.cs'), contract, 'Visual Studio shared Runtime installation, activation and rollback metadata are incomplete')
}
requireMatch(source('plugins/visual-studio/NovelLibraryBridge.cs'), /import\.idempotency[\s\S]*runtime\.check-database[\s\S]*epub\.structure\.v2/, 'Visual Studio Runtime capability negotiation is incomplete')
requireMatch(source('plugins/visual-studio/NovelLibraryBridge.cs'), /\/v2\/import-jobs[\s\S]*"completed"/, 'Visual Studio local imports must poll background jobs')
requireMatch(source('plugins/visual-studio/NovelLibraryToolWindow.cs'), /Content = "导入小说"[\s\S]*ImportFileAsync/, 'Visual Studio local import entry is missing')
for (const method of ['DeleteBookAsync', 'ReparseBookAsync', 'ExportLibraryAsync', 'ImportLibraryAsync', 'GetDiagnosticsAsync']) {
  requireMatch(source('plugins/visual-studio/NovelLibraryBridge.cs'), new RegExp(method), `Visual Studio local maintenance method is missing: ${method}`)
}
requireMatch(source('plugins/visual-studio/NovelLibraryLocalSettings.cs'), /migration\.lock/, 'Visual Studio local directory migration lock is missing')
requireMatch(source('plugins/visual-studio/NovelLibraryPackage.cs'), /ProvideOptionPage\(typeof\(NovelLibraryOptionsPage\)/, 'Visual Studio application-level local Runtime settings page is missing')
requireMatch(source('plugins/visual-studio/NovelLibraryOptionsPage.cs'), /UseDesktopLibrary[\s\S]*LocalDataDirectory[\s\S]*LogLevel/, 'Visual Studio local Runtime settings are incomplete')
requireMatch(source('plugins/visual-studio/NovelLibraryOptionsPage.cs'), /RetainManagedSource/, 'Visual Studio managed-source retention setting is missing')
requireMatch(source('plugins/visual-studio/NovelLibraryBridge.cs'), /retainSource = NovelLibraryLocalSettings\.RetainManagedSource/, 'Visual Studio managed-source retention setting is not sent to Runtime imports')
requireMatch(source('plugins/visual-studio/NovelLibraryLocalSettings.cs'), /PendingProgress[\s\S]*SavePendingProgress[\s\S]*ClearPendingProgress/, 'Visual Studio failed progress persistence is missing')
requireMatch(source('plugins/visual-studio/NovelLibraryLocalSettings.cs'), /ProviderStorageIds[\s\S]*ProgressProviderKey[\s\S]*::\{bookId\}/, 'Visual Studio pending progress keys must include provider storage identity and book id')
requireMatch(source('plugins/visual-studio/NovelLibraryLocalSettings.cs'), /ProgressClientId = \$"visual-studio-[\s\S]*Interlocked\.Increment\(ref ProgressSequence\)/, 'Visual Studio progress identity must be isolated per IDE process')
requireMatch(source('plugins/visual-studio/NovelLibraryBridge.cs'), /ReplayPendingProgressAsync/, 'Visual Studio failed progress replay is missing')
requireMatch(source('plugins/visual-studio/NovelLibraryBridge.cs'), /MinimumClientProtocolVersion[\s\S]*需要更新版插件[\s\S]*不会覆盖或终止它/, 'Visual Studio must preserve a Runtime that requires a newer client')

const desktopManifest = JSON.parse(source('apps/desktop/src-tauri/resources/ide-plugins/manifest.json'))
const desktopIdeIntegration = source('apps/desktop/src-tauri/src/ide_integration.rs')
requireMatch(desktopIdeIntegration, /vscode_script_process/, 'Code OSS editors must use their official command scripts')
for (const [command, label] of [['trae.cmd', 'Trae'], ['qoder.cmd', 'Qoder'], ['windsurf.cmd', 'Windsurf'], ['kiro.cmd', 'Kiro'], ['codium.cmd', 'VSCodium'], ['code-oss.cmd', 'Code - OSS']]) {
  requireValue(desktopIdeIntegration.includes(`command: "${command}"`) && desktopIdeIntegration.includes(`label: "${label}"`), `Code OSS target support is missing: ${label}`)
  requireValue(desktopManifest.plugins.find(item => item.id === 'vscode')?.supportedIdes?.includes(label), `Desktop manifest Code OSS support is missing: ${label}`)
}
requireMatch(desktopIdeIntegration, /install_jetbrains_plugin/, 'JetBrains local ZIP deployment is missing')
requireMatch(desktopIdeIntegration, /vswhere\.exe[\s\S]*Microsoft\.VisualStudio\.Product\.BuildTools[\s\S]*Common7[\s\S]*VSIXInstaller\.exe|visual_studio_product_has_ide[\s\S]*Common7[\s\S]*VSIXInstaller\.exe/, 'Visual Studio detection must resolve VSIXInstaller from a real IDE instance')
requireMatch(source('scripts/install-ide-plugins.ps1'), /vswhere\.exe[\s\S]*Product\.BuildTools|vswhere\.exe[\s\S]*Product\.Community[\s\S]*Common7\\IDE\\VSIXInstaller\.exe/, 'CLI Visual Studio installer detection must use a real IDE instance')
requireValue(!desktopIdeIntegration.includes('cli' + '.js'), 'Desktop plugin installation must never construct a cli.js argument')
requireMatch(desktopIdeIntegration, /--list-extensions/, 'VS Code installed state must use the IDE CLI')
requireMatch(desktopIdeIntegration, /parse_vscode_extension_state/, 'VS Code CLI installed-state parser is missing')
requireMatch(desktopIdeIntegration, /remove_vscode_extension_directories[\s\S]*fallback_used/, 'Code OSS uninstall must fall back when a fork CLI is incompatible')
requireMatch(desktopIdeIntegration, /reopen_after_install[\s\S]*reopen_target_ide/, 'JetBrains automatic close flow must reopen the IDE after install or update')
requireMatch(desktopIdeIntegration, /clean_installer_diagnostic/, 'IDE installer diagnostic filtering is missing')
requireMatch(desktopIdeIntegration, /cfg!\(debug_assertions\)[\s\S]*\[development, bundled_nested, bundled_direct\]/, 'Desktop debug plugin manifest must not be shadowed by a stale bundled copy')
requireMatch(desktopIdeIntegration, /WHEEL_INJECTION_START[\s\S]*workbench\.html\.novel-library-reader\.backup/, 'Code OSS wheel injection backup contract is missing')
requireMatch(desktopIdeIntegration, /update_workbench_checksum[\s\S]*workbench_integrity_checksum/, 'Code OSS wheel injection integrity update is missing')
requireMatch(desktopIdeIntegration, /set_code_oss_wheel_injection/, 'Code OSS wheel injection toggle command is missing')
requireMatch(desktopIdeIntegration, /已自动回滚/, 'Code OSS wheel injection failure rollback is missing')
requireMatch(desktopIdeIntegration, /CloseMainWindow[\s\S]*IDE_CLOSE_PENDING/, 'Desktop JetBrains updater must request a graceful IDE close without force-killing it')
requireMatch(desktopIdeIntegration, /std::thread::scope/, 'IDE installed-state checks must run concurrently')
requireValue(!source('apps/desktop/src/views/IdeIntegrationView.vue').includes('detectionTimeoutMs'), 'IDE detection must not have an arbitrary UI timeout')
requireValue(!source('apps/desktop/src/views/IdeIntegrationView.vue').includes('class="inline-error"'), 'IDE integration feedback must use the global message layer')
requireMatch(source('apps/desktop/src/views/IdeIntegrationView.vue'), /showGlobalError\(error\.value,/, 'IDE integration errors must use global messages')
const expectedArtifacts = new Map([
  ['vscode', [vscode.version, `novel-library-reader-${vscode.version}.vsix`]],
  ['intellij', [intellijVersion, `novel-library-intellij-${intellijVersion}.zip`]],
  ['visual-studio', [visualVersion, `novel-library-visual-studio-${visualVersion}.vsix`]]
])
for (const [id, [version, file]] of expectedArtifacts) {
  const plugin = desktopManifest.plugins.find(item => item.id === id)
  requireValue(plugin?.version === version && plugin?.file === file, `Desktop plugin manifest is out of sync: ${id}`)
}

const installer = source('scripts/install-ide-plugins.ps1')
requireMatch(installer, /Install-JetBrainsLocal/, 'JetBrains local ZIP deployment script is missing')
requireMatch(source('scripts/verify-ide-plugin-runtime.ps1'), /novel-library-runtime/, 'IDE package Runtime verification is missing')
requireMatch(source('scripts/verify-ide-plugin-runtime.ps1'), /runtime-manifest\.json[\s\S]*sha256[\s\S]*Get-FileHash[\s\S]*version/, 'IDE package Runtime manifest verification is incomplete')
for (const contract of [/runtime-manifest\.json/, /Get-FileHash/, /sha256/, /\.sha256/]) {
  requireMatch(source('scripts/stage-ide-plugin-runtime.ps1'), contract, 'IDE Runtime staging must generate a manifest and SHA-256 sidecar')
}
requireMatch(source('scripts/test-local-runtime-e2e.mjs'), /failed replace must preserve the library/, 'Local Runtime destructive-import regression test is missing')
requireMatch(source('scripts/test-local-runtime-e2e.mjs'), /storageId must survive crash recovery[\s\S]*doctor/, 'Local Runtime identity and doctor E2E coverage is missing')
requireMatch(source('scripts/test-local-runtime-e2e.mjs'), /epub\.structure\.v2[\s\S]*frontmatter[\s\S]*Real EPUB Runtime parity/, 'Local Runtime EPUB binary parity E2E coverage is missing')
requireMatch(source('scripts/test-local-runtime-e2e.mjs'), /idempotencyKey must return the original import job[\s\S]*databaseCheck[\s\S]*checksumSha256[\s\S]*tampered/, 'Local Runtime idempotency, database-check and checksum E2E coverage is missing')
const runtimeSource = source('apps/local-runtime/src/main.rs')
for (const capability of ['progress.v2', 'import.jobs', 'import.idempotency', 'books.delete', 'books.reparse', 'backup.transfer', 'runtime.diagnostics', 'runtime.check-database', 'epub.structure.v2']) {
  requireValue(runtimeSource.includes(`"${capability}"`), `Local Runtime capability is missing: ${capability}`)
}
requireMatch(runtimeSource, /MAX_EPUB_EXPANDED_BYTES[\s\S]*HTML_DANGEROUS_BLOCK_RE/, 'Local Runtime EPUB safety limits are missing')
requireMatch(runtimeSource, /parse_epub3_navigation[\s\S]*parse_ncx_navigation[\s\S]*frontmatter[\s\S]*appendix/, 'Local Runtime EPUB structure classification is incomplete')
requireMatch(runtimeSource, /strip_epub_content_prefix[\s\S]*first_epub_chapter_heading/, 'Local Runtime must remove duplicated EPUB chapter headings')
requireMatch(runtimeSource, /REAL_EPUB_RUNTIME_RESULT[\s\S]*frontmatter[\s\S]*body/, 'Local Runtime real EPUB parity regression is missing')
requireMatch(runtimeSource, /ensure_storage_id[\s\S]*storageId/, 'Local Runtime persistent storage identity is missing')
requireMatch(runtimeSource, /idempotency_key[\s\S]*same-client-request/, 'Local Runtime persisted import idempotency regression is missing')
requireMatch(runtimeSource, /retain_source[\s\S]*retain_source: Some\(false\)[\s\S]*managed_source_path\.is_none/, 'Local Runtime managed-source retention behavior is missing')
requireMatch(runtimeSource, /checksumSha256[\s\S]*checksum 校验失败[\s\S]*selected-book package|checksumSha256[\s\S]*checksum 校验失败[\s\S]*selected export/, 'Local Runtime transfer checksum and selected-book boundaries are missing')
requireMatch(runtimeSource, /check-database[\s\S]*storageIdSuffix[\s\S]*databasePath/, 'Local Runtime database check and diagnostics redaction coverage is missing')
const desktopReleaseWorkflow = source('.github/workflows/release-desktop.yml')
const pluginReuse = source('scripts/release/prepare-ide-plugin-reuse.mjs')
requireMatch(desktopReleaseWorkflow, /Prepare reusable IDE plugin artifacts[\s\S]*prepare-ide-plugin-reuse\.mjs/, 'Desktop release must assess reusable IDE plugin artifacts')
requireMatch(desktopReleaseWorkflow, /Verify reusable IDE plugin artifacts[\s\S]*verify-ide-plugin-runtime\.ps1[\s\S]*ExpectedIdentifier[\s\S]*reused=true/, 'Reused IDE plugin artifacts must pass package identity and Runtime verification')
for (const step of ['Validate standalone IDE Runtime', 'Build standalone IDE Runtime', 'Stage standalone IDE Runtime', 'Package VS Code and Cursor plugin', 'Build JetBrains plugin', 'Build Visual Studio plugin']) {
  requireMatch(desktopReleaseWorkflow, new RegExp(`name: ${step}\\n\\s+if: steps\\.reuse-plugins\\.outputs\\.reused != 'true'`), `${step} must run only when verified artifacts cannot be reused`)
}
for (const input of ['apps/local-runtime/', 'packages/reader-protocol/', 'plugins/', 'manifest.json', 'stage-ide-plugin-runtime.ps1', 'package-visual-studio-plugin.ps1']) {
  requireValue(pluginReuse.includes(input), `IDE plugin reuse must track build input: ${input}`)
}
requireMatch(pluginReuse, /asset\.digest[\s\S]*SHA256[\s\S]*bytes\.length[\s\S]*createHash\('sha256'\)/, 'IDE plugin reuse must verify release asset size and SHA-256')
requireValue((desktopReleaseWorkflow.match(/stage-ide-plugin-runtime\.ps1/g) || []).length >= 3, 'Desktop release must stage the Runtime manifest and checksum for every rebuilt IDE plugin')
const ideBuildWorkflow = source('.github/workflows/build-ide-plugins.yml')
for (const input of ['plugins/**', 'apps/local-runtime/**', 'packages/reader-protocol/**', 'apps/desktop/src-tauri/resources/ide-plugins/manifest.json', 'scripts/package-visual-studio-plugin.ps1', 'scripts/stage-ide-plugin-runtime.ps1']) {
  requireValue(ideBuildWorkflow.includes(input), `IDE plugin build workflow must track artifact input: ${input}`)
}
requireValue(!ideBuildWorkflow.includes("'scripts/validate-ide-integrations.mjs'"), 'IDE contract-only changes must not rebuild plugin packages')
requireMatch(installer, /\[switch\]\$AllTargets/, 'Non-interactive all-target installation is missing')
for (const command of ['trae', 'qoder', 'windsurf', 'kiro', 'codium', 'code-oss']) {
  requireValue(installer.includes(`'${command}'`), `Standalone installer Code OSS target is missing: ${command}`)
}
const visualPackager = source('scripts/package-visual-studio-plugin.ps1')
for (const entry of ['[Content_Types].xml', 'NovelLibrary.VisualStudio.dll', 'NovelLibrary.VisualStudio.pkgdef', 'Icon.png', 'README.md']) {
  requireValue(visualPackager.includes(`'${entry}'`), `Visual Studio VSIX validation is missing: ${entry}`)
}
for (const workflow of ['.github/workflows/build-ide-plugins.yml', '.github/workflows/release-desktop.yml']) {
  const value = source(workflow)
  requireMatch(value, /manifest\.json/, `${workflow} must read the plugin manifest for artifact names`)
}

console.log(`validated ${files.length} IDE integration files and all three plugin contracts`)
