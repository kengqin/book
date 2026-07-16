import { readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('releases/releases.json', root), 'utf8'))

function argument(name) {
  const prefix = `--${name}=`
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length)
}

const tag = argument('tag') || `v${manifest.latest}`
const version = tag.replace(/^v/, '')
const release = manifest.releases.find((entry) => entry.version === version)

if (!release) throw new Error(`版本清单中不存在 ${tag}`)

const installerName = argument('installer-name') || release.installerUrl.split('/').at(-1)
const sha256 = argument('sha256') || release.sha256
const lines = [
  `# NovelLibrary ${tag}`,
  '',
  `> ${release.title}`,
  '',
  `发布日期：${release.date}`,
  ''
]

for (const section of release.sections) {
  lines.push(`## ${section.title}`, '', ...section.items.map((item) => `- ${item}`), '')
}

if (release.upgradeNotes?.length) {
  lines.push('## 升级说明', '', ...release.upgradeNotes.map((item) => `- ${item}`), '')
}

lines.push(
  '## 下载与校验',
  '',
  `- Windows x64 安装包：[${installerName}](${release.installerUrl})`,
  `- 数据库 Schema：\`${release.databaseSchema}\``,
  `- SHA256：\`${sha256 || '以 Release 附件中的 .sha256 文件为准'}\``,
  '',
  '完整历史记录请查看 [CHANGELOG.md](https://github.com/kengqin/book/blob/main/CHANGELOG.md)。',
  ''
)

const notes = lines.join('\n')
const output = argument('output')

if (output) {
  await writeFile(output, notes, 'utf8')
  console.log(output)
} else {
  process.stdout.write(notes)
}
