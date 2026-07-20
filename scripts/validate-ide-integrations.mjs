import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const files = [
  'apps/desktop/src-tauri/resources/ide-plugins/manifest.json',
  'apps/desktop/src-tauri/src/ide_integration.rs',
  'apps/desktop/src/views/IdeIntegrationView.vue',
  'plugins/vscode/package.json',
  'plugins/README.md',
  'plugins/vscode/bridge.js',
  'plugins/vscode/extension.js',
  'plugins/vscode/README.md',
  'plugins/vscode/LICENSE',
  'plugins/vscode/.vscodeignore',
  'plugins/vscode/media/novel-library.svg',
  'plugins/intellij/build.gradle.kts',
  'plugins/intellij/src/main/kotlin/com/kengqin/novellibrary/NovelLibraryPlugin.kt',
  'plugins/intellij/src/main/resources/META-INF/plugin.xml',
  'plugins/intellij/src/main/resources/icons/novelLibrary.svg',
  'plugins/visual-studio/NovelLibrary.VisualStudio.csproj',
  'plugins/visual-studio/NovelLibraryBridge.cs',
  'plugins/visual-studio/NovelLibraryPackage.cs',
  'plugins/visual-studio/NovelLibraryReaderSession.cs',
  'plugins/visual-studio/NovelLibraryToolWindow.cs',
  'plugins/visual-studio/NovelLibraryAdornment.cs',
  'plugins/visual-studio/NovelLibraryCommands.cs',
  'plugins/visual-studio/NovelLibrary.vsct',
  'plugins/visual-studio/LICENSE',
  'plugins/visual-studio/source.extension.vsixmanifest',
  'scripts/install-ide-plugins.ps1',
  'scripts/package-visual-studio-plugin.ps1',
  '.github/workflows/build-ide-plugins.yml',
  '.github/workflows/release-desktop.yml'
]

const sources = new Map()
for (const file of files) sources.set(file, await readFile(join(root, file), 'utf8'))
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
requireValue(vscode.main === 'extension.js', 'VS Code extension entry point is missing')
requireValue(vscode.activationEvents?.includes('onStartupFinished'), 'VS Code automatic startup is missing')
requireValue(vscode.contributes?.viewsContainers?.activitybar?.some(item => item.id === 'novelLibrary'), 'VS Code activity bar container is missing')
requireValue(vscode.contributes?.views?.novelLibrary?.some(item => item.id === 'novelLibrary.reader'), 'VS Code reader sidebar is missing')
const vscodeViewCommands = new Set(vscode.contributes?.menus?.['view/title']?.map(item => item.command))
for (const command of ['novelLibrary.showReader', 'novelLibrary.hideReader', 'novelLibrary.previousLine', 'novelLibrary.nextLine', 'novelLibrary.previousChapter', 'novelLibrary.nextChapter', 'novelLibrary.refreshLibrary']) {
  requireValue(vscodeViewCommands.has(command), `VS Code reader toolbar command is missing: ${command}`)
}
const vscodeKeys = new Set(vscode.contributes?.keybindings?.map(item => item.key))
for (const key of ['ctrl+alt+n', 'ctrl+alt+up', 'ctrl+alt+down', 'ctrl+alt+left', 'ctrl+alt+right']) {
  requireValue(vscodeKeys.has(key), `VS Code keybinding is missing: ${key}`)
}
const vscodeExtension = source('plugins/vscode/extension.js')
requireMatch(vscodeExtension, /slice\(state\.lineStart, state\.lineStart \+ 5\)/, 'VS Code five-line reader is missing')
requireMatch(vscodeExtension, /createTextEditorDecorationType/, 'VS Code inline editor decorations are missing')
requireMatch(vscodeExtension, /displayMode === 'paragraph'/, 'VS Code paragraph display mode is missing')
requireMatch(vscodeExtension, /displayMode.*lineEnd/, 'VS Code original line-end display mode is missing')
requireMatch(vscodeExtension, /toggleDisplayMode/, 'VS Code display mode toggle is missing')
requireMatch(vscodeExtension, /registerTreeDataProvider\('novelLibrary\.reader'/, 'VS Code reader sidebar provider is missing')
requireMatch(vscodeExtension, /registerCommand\('novelLibrary\.selectBook'/, 'VS Code book selection command is missing')
requireMatch(vscodeExtension, /registerCommand\('novelLibrary\.selectChapter'/, 'VS Code chapter selection command is missing')
requireMatch(vscodeExtension, /label: `书架 \(\$\{state\.books\.length\}\)`/, 'VS Code bookshelf section is missing')
requireMatch(vscodeExtension, /label: `章节 \(\$\{state\.chapters\.length\}\)`/, 'VS Code chapter section is missing')
requireMatch(vscodeExtension, /type: 'content'/, 'VS Code content section is missing')
requireMatch(vscodeExtension, /registerCommand\('novelLibrary\.openBookFromSidebar'/, 'VS Code direct sidebar book selection is missing')
requireMatch(vscodeExtension, /registerCommand\('novelLibrary\.openChapterFromSidebar'/, 'VS Code direct sidebar chapter selection is missing')
requireMatch(vscodeExtension, /const connectOnStartup = async \(\) =>/, 'VS Code automatic reader display is missing')
requireMatch(vscodeExtension, /attempt < 12[\s\S]*reader\.toggle\(true, true\)/, 'VS Code startup connection retry is missing')
requireMatch(vscodeExtension, /for \(let attempts = 0;[\s\S]*attempts < 30/, 'VS Code empty-chapter skipping is missing')
requireMatch(vscodeExtension, /chapter\.kind === 'chapter'/, 'VS Code non-content chapter filtering is missing')
requireMatch(vscodeExtension, /storage\.update\('novelLibrary\.readerEnabled'/, 'VS Code reader visibility preference is missing')
requireValue(!/moveLines = async direction => \{\s*if \(!state\.enabled\) await toggle\(true\)/.test(vscodeExtension), 'VS Code line shortcuts must not force hidden reading back on')
const vscodeBridge = source('plugins/vscode/bridge.js')
requireMatch(vscodeBridge, /AbortSignal\.timeout\(5000\)/, 'VS Code Bridge timeout must be five seconds')
requireMatch(vscodeBridge, /Connection: 'close'/, 'VS Code Bridge must close each local HTTP connection')
requireMatch(vscodeBridge, /novel-library-desktop/, 'VS Code Bridge must resolve the running desktop installation')

const intellijBuild = source('plugins/intellij/build.gradle.kts')
const intellijXml = source('plugins/intellij/src/main/resources/META-INF/plugin.xml')
const intellijCode = source('plugins/intellij/src/main/kotlin/com/kengqin/novellibrary/NovelLibraryPlugin.kt')
const intellijIcon = source('plugins/intellij/src/main/resources/icons/novelLibrary.svg')
const intellijVersion = intellijBuild.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
requireValue(semver(intellijVersion), 'JetBrains plugin version must be valid SemVer')
requireMatch(intellijBuild, /jvmTarget = JvmTarget\.JVM_17/, 'JetBrains Kotlin bytecode must target Java 17')
requireMatch(intellijBuild, /targetCompatibility = JavaVersion\.VERSION_17/, 'JetBrains Java bytecode must target Java 17')
requireMatch(intellijXml, /<toolWindow id="小说书库"[^>]+icon="\/icons\/novelLibrary\.svg"/, 'JetBrains tool window icon is missing')
requireMatch(intellijIcon, /M2 2\.5C2 1\.67/, 'JetBrains tool window must use the shared book icon shape')
requireMatch(intellijXml, /<postStartupActivity/, 'JetBrains automatic startup activity is missing')
for (const shortcut of ['ctrl alt N', 'ctrl alt UP', 'ctrl alt DOWN', 'ctrl alt LEFT', 'ctrl alt RIGHT']) {
  requireValue(intellijXml.includes(`first-keystroke="${shortcut}"`), `JetBrains keybinding is missing: ${shortcut}`)
}
requireMatch(intellijCode, /take\(5\)/, 'JetBrains five-line reader is missing')
requireMatch(intellijCode, /addAfterLineEndElement/, 'JetBrains inline editor inlays are missing')
requireMatch(intellijCode, /addInlineElement/, 'JetBrains paragraph editor inlays are missing')
requireMatch(intellijCode, /ReaderDisplayMode\.PARAGRAPH/, 'JetBrains paragraph display mode is missing')
requireMatch(intellijCode, /ReaderDisplayMode\.LINE_END/, 'JetBrains original line-end display mode is missing')
requireMatch(intellijCode, /class WrapLayout[\s\S]*availableWidth/, 'JetBrains reader toolbar must wrap instead of clipping actions')
requireMatch(intellijCode, /object ReaderVisibilitySettings/, 'JetBrains reader visibility preference is missing')
requireMatch(intellijCode, /class ToggleReaderVisibilityAction/, 'JetBrains reader visibility action is missing')
requireMatch(intellijCode, /repeat\(if \(body == null\) 3 else 1\)/, 'JetBrains Bridge GET retry is missing')
requireMatch(intellijCode, /连接中断，正在重试/, 'JetBrains session reconnect handling is missing')
requireMatch(intellijCode, /val refresh = JButton\("刷新"\)/, 'JetBrains manual reader refresh is missing')
requireMatch(intellijCode, /while \(resultLines\.isEmpty\(\) && attempts < 30\)/, 'JetBrains empty-chapter skipping is missing')
requireMatch(intellijCode, /it\.kind == null \|\| it\.kind == "chapter"/, 'JetBrains non-content chapter filtering is missing')
requireMatch(intellijCode, /timeout\(Duration\.ofSeconds\(5\)\)/, 'JetBrains Bridge timeout must be five seconds')
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
const visualVersion = visualManifest.match(/Identity Id="NovelLibrary\.VisualStudio" Version="([^"]+)"/)?.[1]
requireValue(semver(visualVersion), 'Visual Studio extension version must be valid SemVer')
requireMatch(visualManifest, /Microsoft\.VisualStudio\.VsPackage/, 'Visual Studio package asset is missing')
requireMatch(visualManifest, /Microsoft\.VisualStudio\.MefComponent/, 'Visual Studio editor component asset is missing')
for (const key of ['N', 'VK_UP', 'VK_DOWN', 'VK_LEFT', 'VK_RIGHT']) {
  requireValue(visualVsct.includes(`key1="${key}"`), `Visual Studio keybinding is missing: ${key}`)
}
requireMatch(visualSession, /Take\(5\)/, 'Visual Studio five-line reader is missing')
requireMatch(visualSession, /attempts < 30/, 'Visual Studio empty-chapter skipping is missing')
requireMatch(visualSession, /item\.Kind == "chapter"/, 'Visual Studio non-content chapter filtering is missing')
requireMatch(visualAdornment, /IAdornmentLayer/, 'Visual Studio inline editor adornments are missing')
requireMatch(visualAdornment, /ReaderDisplayMode\.Paragraph/, 'Visual Studio paragraph display mode is missing')
requireMatch(visualSession, /visual-studio-reader-visible\.txt[\s\S]*IsReaderVisible/, 'Visual Studio reader visibility preference is missing')
requireMatch(visualAdornment, /if \(!NovelLibraryReaderSession\.IsReaderVisible\) return;/, 'Visual Studio hidden reader must remove editor adornments')
requireMatch(visualSession, /ReaderDisplayMode\.LineEnd/, 'Visual Studio original line-end display mode is missing')
requireMatch(source('plugins/visual-studio/NovelLibraryBridge.cs'), /Timeout = TimeSpan\.FromSeconds\(5\)/, 'Visual Studio Bridge timeout must be five seconds')
requireMatch(source('plugins/visual-studio/NovelLibraryBridge.cs'), /ConnectionClose = true/, 'Visual Studio Bridge must close each local HTTP connection')
requireMatch(source('plugins/visual-studio/NovelLibraryBridge.cs'), /GetProcessesByName/, 'Visual Studio Bridge must resolve the running desktop installation')

const desktopManifest = JSON.parse(source('apps/desktop/src-tauri/resources/ide-plugins/manifest.json'))
const desktopIdeIntegration = source('apps/desktop/src-tauri/src/ide_integration.rs')
requireMatch(desktopIdeIntegration, /vscode_script_process/, 'VS Code and Cursor must use their official command scripts')
requireMatch(desktopIdeIntegration, /install_jetbrains_plugin/, 'JetBrains local ZIP deployment is missing')
requireValue(!desktopIdeIntegration.includes('cli' + '.js'), 'Desktop plugin installation must never construct a cli.js argument')
requireMatch(desktopIdeIntegration, /--list-extensions/, 'VS Code installed state must use the IDE CLI')
requireMatch(desktopIdeIntegration, /parse_vscode_extension_state/, 'VS Code CLI installed-state parser is missing')
requireMatch(desktopIdeIntegration, /clean_installer_diagnostic/, 'IDE installer diagnostic filtering is missing')
requireMatch(desktopIdeIntegration, /std::thread::scope/, 'IDE installed-state checks must run concurrently')
requireValue(!source('apps/desktop/src/views/IdeIntegrationView.vue').includes('detectionTimeoutMs'), 'IDE detection must not have an arbitrary UI timeout')
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
requireMatch(installer, /\[switch\]\$AllTargets/, 'Non-interactive all-target installation is missing')
const visualPackager = source('scripts/package-visual-studio-plugin.ps1')
for (const entry of ['[Content_Types].xml', 'NovelLibrary.VisualStudio.dll', 'NovelLibrary.VisualStudio.pkgdef']) {
  requireValue(visualPackager.includes(`'${entry}'`), `Visual Studio VSIX validation is missing: ${entry}`)
}
for (const workflow of ['.github/workflows/build-ide-plugins.yml', '.github/workflows/release-desktop.yml']) {
  const value = source(workflow)
  requireMatch(value, /manifest\.json/, `${workflow} must read the plugin manifest for artifact names`)
}

console.log(`validated ${files.length} IDE integration files and all three plugin contracts`)
