import fs from 'node:fs'
import path from 'node:path'

const workspace = path.resolve(import.meta.dirname, '..')
const libraryRoot = path.join(workspace, '书库')
const manifestPath = path.join(workspace, '正文', '.vitepress', 'library.generated.json')
const metadataFilename = 'book.json'
const chineseNumberPattern = '零〇一二两三四五六七八九十百千万两'

const digits = new Map([
  ['零', 0], ['〇', 0], ['一', 1], ['二', 2], ['两', 2], ['三', 3],
  ['四', 4], ['五', 5], ['六', 6], ['七', 7], ['八', 8], ['九', 9]
])
const units = new Map([['十', 10], ['百', 100], ['千', 1000], ['万', 10000]])

function chineseNumberToInt(value) {
  if (/^\d+$/u.test(value)) return Number(value)
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

function optionalString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function safeTitle(value) {
  return value.replace(/[<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '')
}

function readBookMetadata(bookRoot, slug) {
  const file = path.join(bookRoot, metadataFilename)
  if (!fs.existsSync(file)) {
    return { id: slug, slug, title: slug, author: '佚名', status: '连载中', category: '其他', description: '', cover: '', seal: slug.slice(0, 1) }
  }

  let source
  try {
    source = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`无法读取书籍元数据：${file}（${error instanceof Error ? error.message : 'JSON 格式错误'}）`)
  }
  if (!source || Array.isArray(source) || typeof source !== 'object') throw new Error(`书籍元数据必须是对象：${file}`)

  const cover = optionalString(source.cover)
  if (cover.includes('..') || path.isAbsolute(cover)) throw new Error(`封面路径不允许越出站点目录：${file}`)
  return {
    id: optionalString(source.id) || slug,
    slug,
    title: optionalString(source.title) || slug,
    author: optionalString(source.author) || '佚名',
    status: optionalString(source.status) || '连载中',
    category: optionalString(source.category) || '其他',
    description: optionalString(source.description),
    cover,
    seal: optionalString(source.seal).slice(0, 1) || slug.slice(0, 1)
  }
}

function discoverBooks() {
  const ids = new Set()
  return fs.readdirSync(libraryRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const bookRoot = path.join(libraryRoot, entry.name)
      if (!fs.existsSync(path.join(bookRoot, '正文'))) return null
      const book = readBookMetadata(bookRoot, entry.name)
      if (ids.has(book.id)) throw new Error(`书籍 id 重复：${book.id}`)
      ids.add(book.id)
      return book
    })
    .filter(Boolean)
}

function parseChapterHeading(content, file) {
  const heading = content.match(/^#\s+(.+?)\s*$/mu)?.[1]?.trim()
  if (!heading) throw new Error(`缺少一级章节标题：${file}`)

  const separator = '[\\s　:：、，.．—-]+'
  const numbered = heading.match(new RegExp(`^第\\s*([0-9]+|[${chineseNumberPattern}]+)\\s*([章回节])(?:${separator}(.+))?$`, 'u'))
  if (numbered) {
    return {
      label: `第${numbered[1]}${numbered[2]}`,
      number: chineseNumberToInt(numbered[1]),
      title: safeTitle(numbered[3] || `第${numbered[1]}${numbered[2]}`)
    }
  }

  const special = heading.match(new RegExp(`^((?:序章|楔子|引子|后记|尾声|大结局)|(?:番外(?:篇)?|收官章|终章)[0-9${chineseNumberPattern}]*)(?:${separator}(.+))?$`, 'u'))
  if (special) return { label: special[1], number: null, title: safeTitle(special[2] || special[1]) }

  throw new Error(`无法识别章节标题：${file}（当前标题：${heading}）`)
}

function volumeOrder(group) {
  const match = group.match(new RegExp(`^第\\s*([0-9]+|[${chineseNumberPattern}]+)\\s*卷`, 'u'))
  return match ? chineseNumberToInt(match[1]) : Number.MAX_SAFE_INTEGER
}

function specialOrder(label) {
  if (/^(序章|楔子|引子)$/u.test(label)) return -1
  if (/^(番外|后记|尾声|收官章|终章|大结局)/u.test(label)) return 1
  return 0
}

function compareChapters(left, right) {
  const leftVolume = volumeOrder(left.group)
  const rightVolume = volumeOrder(right.group)
  if (leftVolume !== rightVolume) return leftVolume - rightVolume
  if (left.group !== right.group) return left.group.localeCompare(right.group, 'zh-Hans-CN', { numeric: true })
  const leftSpecial = specialOrder(left.label)
  const rightSpecial = specialOrder(right.label)
  if (leftSpecial !== rightSpecial) return leftSpecial - rightSpecial
  if (left.number !== null && right.number !== null && left.number !== right.number) return left.number - right.number
  return left.file.localeCompare(right.file, 'zh-Hans-CN', { numeric: true })
}

function scanChapters(book) {
  const root = path.join(libraryRoot, book.slug, '正文')
  if (!fs.existsSync(root)) return []

  const files = fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => path.join(entry.parentPath, entry.name))

  return files.map(file => {
    const chapter = parseChapterHeading(fs.readFileSync(file, 'utf8'), file)
    const relativeFile = path.relative(root, file).split(path.sep).join('/')
    return {
      ...chapter,
      group: relativeFile.includes('/') ? relativeFile.split('/')[0] : '正文',
      file: relativeFile,
      link: `/${book.slug}/正文/${relativeFile.replace(/\.md$/, '')}`
    }
  }).sort(compareChapters).map((chapter, index) => ({ ...chapter, order: index + 1 }))
}

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

export function writeLibraryManifest() {
  const manifestBooks = discoverBooks().map(book => {
    const chapters = scanChapters(book)
    if (!chapters.length) return null
    const bookRoot = path.join(libraryRoot, book.slug)
    fs.writeFileSync(path.join(bookRoot, 'index.md'), bookHome(book.id), 'utf8')
    fs.writeFileSync(path.join(bookRoot, '目录.md'), bookCatalogue(book.id), 'utf8')
    return {
      ...book,
      topicLink: `/${book.slug}/`,
      catalogueLink: `/${book.slug}/目录`,
      firstLink: chapters[0].link,
      chapterCount: chapters.length,
      range: `${chapters[0].label}—${chapters.at(-1).label}`,
      chapters
    }
  }).filter(Boolean)

  const library = { books: manifestBooks }
  fs.writeFileSync(path.join(libraryRoot, 'index.md'), `---\nlayout: page\nsidebar: false\naside: false\nfooter: false\nlibraryHome: true\n---\n\n<LibraryHome />\n`, 'utf8')
  fs.writeFileSync(manifestPath, `${JSON.stringify(library, null, 2)}\n`, 'utf8')
  return library
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const library = writeLibraryManifest()
  process.stdout.write(`已生成 ${library.books.length} 本小说的书库清单。\n`)
}
