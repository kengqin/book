import fs from 'node:fs'
import path from 'node:path'

const workspace = path.resolve(import.meta.dirname, '..')
const bookDir = path.join(workspace, '书库', '剑来')
const sourceDir = path.join(bookDir, '原文')
const docsDir = path.join(workspace, '正文')
const outputDir = path.join(bookDir, '正文')
const libraryManifestPath = path.join(docsDir, '.vitepress', 'library.generated.json')
const dryRun = process.argv.includes('--dry-run')

const sources = [
  { filename: '剑来(1-500章).txt', firstChapter: 64, lastChapter: 497 },
  { filename: '剑来(501-1000章).txt', firstChapter: 498, lastChapter: 995 },
  { filename: '剑来(1001-1278章).txt', firstChapter: 996, lastChapter: 1273 }
]

const digits = new Map([
  ['零', 0], ['〇', 0], ['一', 1], ['二', 2], ['两', 2], ['三', 3],
  ['四', 4], ['五', 5], ['六', 6], ['七', 7], ['八', 8], ['九', 9]
])
const units = new Map([['十', 10], ['百', 100], ['千', 1000], ['万', 10000]])

function chineseNumberToInt(value) {
  if (/^\d+$/.test(value)) return Number(value)

  let total = 0
  let section = 0
  let current = 0

  for (const char of value) {
    if (digits.has(char)) {
      current = digits.get(char)
      continue
    }

    const unit = units.get(char)
    if (!unit) throw new Error(`无法解析章号：${value}`)
    if (unit === 10000) {
      section += current
      total += (section || 1) * unit
      section = 0
      current = 0
    } else {
      section += (current || 1) * unit
      current = 0
    }
  }

  return total + section + current
}

function safeTitle(value) {
  return value
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
}

function alignHeaders(candidates, firstChapter, lastChapter) {
  const expectedCount = lastChapter - firstChapter + 1
  const rows = expectedCount + 1
  const columns = candidates.length + 1
  const costs = Array.from({ length: rows }, () => new Float64Array(columns).fill(Infinity))
  const actions = Array.from({ length: rows }, () => new Uint8Array(columns))
  costs[0][0] = 0

  for (let selected = 0; selected <= expectedCount; selected += 1) {
    for (let seen = 0; seen < candidates.length; seen += 1) {
      const cost = costs[selected][seen]
      if (!Number.isFinite(cost)) continue

      if (cost + 1 < costs[selected][seen + 1]) {
        costs[selected][seen + 1] = cost + 1
        actions[selected][seen + 1] = 1
      }

      if (selected < expectedCount) {
        const expected = firstChapter + selected
        const difference = Math.abs(candidates[seen].number - expected)
        const mismatchCost = difference === 0 ? 0 : 5 + Math.min(difference, 20)
        if (cost + mismatchCost < costs[selected + 1][seen + 1]) {
          costs[selected + 1][seen + 1] = cost + mismatchCost
          actions[selected + 1][seen + 1] = 2
        }
      }
    }
  }

  const selectedHeaders = []
  let selected = expectedCount
  let seen = candidates.length
  while (selected > 0 || seen > 0) {
    const action = actions[selected][seen]
    if (action === 2) {
      selectedHeaders.push(candidates[seen - 1])
      selected -= 1
      seen -= 1
    } else if (action === 1) {
      seen -= 1
    } else {
      throw new Error(`章节标题对齐失败：${firstChapter}-${lastChapter}`)
    }
  }

  return selectedHeaders.reverse()
}

function parseSource({ filename, firstChapter, lastChapter }) {
  const sourcePath = path.join(sourceDir, filename)
  const text = fs.readFileSync(sourcePath, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const headerPattern = /^第([零〇一二两三四五六七八九十百千万\d]+)章[ \t　]+([^\n]+)$/gm
  const candidateHeaders = [...text.matchAll(headerPattern)].map(match => ({
    match,
    number: chineseNumberToInt(match[1])
  }))
  const alignedHeaders = alignHeaders(candidateHeaders, firstChapter, lastChapter)
  const headers = alignedHeaders.map(candidate => candidate.match)

  return headers.map((match, index) => {
    const number = firstChapter + index
    const numberText = String(number)
    const title = safeTitle(match[2])
    const start = match.index + match[0].length
    const end = headers[index + 1]?.index ?? text.length
    const body = text.slice(start, end)
      .split('\n')
      .map(line => line.replace(/^[ \t　]+/, '').trimEnd())
      .filter(line => line && !/^更多精彩小说，请访问/.test(line))
      .join('\n\n')
      .trim()

    return { number, numberText, title, body, source: filename }
  })
}

const parsed = sources.flatMap(parseSource)
const chaptersByNumber = new Map()
const duplicates = []

for (const chapter of parsed) {
  if (chaptersByNumber.has(chapter.number)) {
    duplicates.push({
      number: chapter.number,
      previous: chaptersByNumber.get(chapter.number).source,
      replacement: chapter.source
    })
  }
  chaptersByNumber.set(chapter.number, chapter)
}

const chapters = [...chaptersByNumber.values()].sort((a, b) => a.number - b.number)
const first = chapters.at(0)?.number
const last = chapters.at(-1)?.number
const gaps = []

for (let number = first; number <= last; number += 1) {
  if (!chaptersByNumber.has(number)) gaps.push(number)
}

const summary = {
  sourceSections: parsed.length,
  uniqueChapters: chapters.length,
  firstChapter: first,
  lastChapter: last,
  duplicates,
  gaps
}

if (dryRun) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  process.exit(gaps.length ? 1 : 0)
}

const resolvedOutput = path.resolve(outputDir)
if (!resolvedOutput.startsWith(`${path.resolve(bookDir)}${path.sep}`) || path.basename(resolvedOutput) !== '正文') {
  throw new Error(`拒绝清理非预期目录：${resolvedOutput}`)
}

fs.rmSync(resolvedOutput, { recursive: true, force: true })
fs.mkdirSync(resolvedOutput, { recursive: true })

const manifest = chapters.map(chapter => {
  const groupStart = Math.floor(chapter.number / 100) * 100 || 1
  const groupEnd = groupStart === 1 ? 99 : groupStart + 99
  const groupName = `${String(groupStart).padStart(4, '0')}-${String(groupEnd).padStart(4, '0')}`
  const filenameTitle = safeTitle(chapter.title).replace(/\s+/g, '-')
  const filename = `第${String(chapter.number).padStart(4, '0')}章-${filenameTitle}.md`
  const relativeFile = path.posix.join(groupName, filename)
  const chapterDir = path.join(resolvedOutput, groupName)
  fs.mkdirSync(chapterDir, { recursive: true })

  const content = `# 第${chapter.numberText}章 ${chapter.title}\n\n${chapter.body}\n`
  fs.writeFileSync(path.join(chapterDir, filename), content, 'utf8')

  return {
    number: chapter.number,
    numberText: chapter.numberText,
    title: chapter.title,
    group: groupName,
    file: relativeFile,
    link: `/剑来/正文/${relativeFile.replace(/\.md$/, '')}`
  }
})

const groups = [...new Set(manifest.map(chapter => chapter.group))]
const bookHome = bookId => `---
layout: page
sidebar: false
aside: false
footer: false
bookHome: ${bookId}
---

<BookHome book-id="${bookId}" />
`

const bookCatalogue = bookId => `---
layout: page
sidebar: false
aside: false
footer: false
---

<BookCatalogue book-id="${bookId}" />
`

const eternalRoot = path.join(workspace, '书库', '永恒道途')
const eternalChaptersRoot = path.join(eternalRoot, '正文')
const eternalFiles = fs.readdirSync(eternalChaptersRoot, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
  .map(entry => path.join(entry.parentPath, entry.name))

const eternalChapters = eternalFiles.map(file => {
  const content = fs.readFileSync(file, 'utf8')
  const heading = content.match(/^#\s+第([零〇一二两三四五六七八九十百千万\d]+)章\s+(.+)$/m)
  if (!heading) throw new Error(`无法读取《永恒道途》章节标题：${file}`)
  const number = chineseNumberToInt(heading[1])
  const relativeFile = path.relative(eternalChaptersRoot, file).split(path.sep).join('/')
  return {
    number,
    numberText: heading[1],
    title: safeTitle(heading[2]),
    group: relativeFile.split('/')[0],
    file: relativeFile,
    link: `/永恒道途/正文/${relativeFile.replace(/\.md$/, '')}`
  }
}).sort((a, b) => a.number - b.number)

const library = {
  books: [
    {
      id: 'jianlai',
      slug: '剑来',
      title: '剑来',
      author: '烽火戏诸侯',
      status: '阅读中',
      description: '大千世界，无奇不有。天道崩塌，唯有一剑。',
      topicLink: '/剑来/',
      catalogueLink: '/剑来/目录',
      firstLink: manifest[0].link,
      chapterCount: manifest.length,
      range: `第 ${first}—${last} 章`,
      chapters: manifest
    },
    {
      id: 'eternal-path',
      slug: '永恒道途',
      title: '永恒道途',
      author: '原创长篇',
      status: '暂停重构',
      description: '寒门少年陈玄携掌天瓶踏上仙途，一步一步，走出自己的大道。',
      topicLink: '/永恒道途/',
      catalogueLink: '/永恒道途/目录',
      firstLink: eternalChapters[0].link,
      chapterCount: eternalChapters.length,
      range: `第 ${eternalChapters[0].number}—${eternalChapters.at(-1).number} 章`,
      chapters: eternalChapters
    }
  ]
}

fs.writeFileSync(path.join(workspace, '书库', 'index.md'), `---\nlayout: page\nsidebar: false\naside: false\nfooter: false\nlibraryHome: true\n---\n\n<LibraryHome />\n`, 'utf8')
fs.writeFileSync(path.join(bookDir, 'index.md'), bookHome('jianlai'), 'utf8')
fs.writeFileSync(path.join(bookDir, '目录.md'), bookCatalogue('jianlai'), 'utf8')
fs.writeFileSync(path.join(eternalRoot, 'index.md'), bookHome('eternal-path'), 'utf8')
fs.writeFileSync(path.join(eternalRoot, '目录.md'), bookCatalogue('eternal-path'), 'utf8')
fs.writeFileSync(libraryManifestPath, `${JSON.stringify(library, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
