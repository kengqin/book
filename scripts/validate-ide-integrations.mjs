import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\//, '').replaceAll('/', '\\')
const files = [
  'plugins/vscode/package.json',
  'plugins/vscode/bridge.js',
  'plugins/vscode/extension.js',
  'plugins/vscode/README.md',
  'plugins/vscode/LICENSE',
  'plugins/vscode/.vscodeignore',
  'plugins/vscode/media/novel-library.svg',
  'plugins/intellij/build.gradle.kts',
  'plugins/intellij/src/main/resources/META-INF/plugin.xml',
  'plugins/visual-studio/NovelLibraryBridge.cs',
  'plugins/visual-studio/NovelLibrary.VisualStudio.csproj',
  'plugins/visual-studio/NovelLibraryPackage.cs',
  'plugins/visual-studio/LICENSE',
  'plugins/visual-studio/source.extension.vsixmanifest',
  'scripts/package-visual-studio-plugin.ps1'
]
for (const file of files) await readFile(join(root, file))
const manifest = JSON.parse(await readFile(join(root, 'plugins/vscode/package.json'), 'utf8'))
if (manifest.main !== 'extension.js' || !manifest.contributes?.commands?.length) throw new Error('VS Code manifest is incomplete')
console.log(`validated ${files.length} IDE integration files`)
