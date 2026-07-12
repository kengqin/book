import fs from 'node:fs'
import path from 'node:path'

const workspace = path.resolve(import.meta.dirname, '..')
const libraryRoot = path.join(workspace, '书库')
const manifestPath = path.join(workspace, '正文', '.vitepress', 'library.generated.json')

const digits = new Map([
  ['零', 0], ['〇', 0], ['一', 1], ['二', 2], ['两', 2], ['三', 3],
  ['四', 4], ['五', 5], ['六', 6], ['七', 7], ['八', 8], ['九', 9]
])
const units = new Map([['十', 10], ['百', 100], ['千', 1000], ['万', 10000]])

const books = [
  {
    id: 'jianlai', slug: '剑来', title: '剑来', author: '烽火戏诸侯', status: '阅读中',
    description: '大千世界，无奇不有。天道崩塌，唯有一剑。'
  },
  {
    id: 'xuezhong', slug: '雪中悍刀行', title: '雪中悍刀行', author: '烽火戏诸侯', status: '全本',
    description: '庙堂与江湖交错，白马出凉州，一刀走过风雪与人间。'
  },
  {
    id: 'eternal-path', slug: '永恒道途', title: '永恒道途', author: '原创长篇', status: '暂停重构',
    description: '寒门少年陈玄携掌天瓶踏上仙途，一步一步，走出自己的大道。'
  }
]

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
  return value.replace(/[<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '')
}

function scanChapters(book) {
  const root = path.join(libraryRoot, book.slug, '正文')
  if (!fs.existsSync(root)) return []

  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => path.join(entry.parentPath, entry.name))
    .map(file => {
      const content = fs.readFileSync(file, 'utf8')
      const heading = content.match(/^#\s+第([零〇一二两三四五六七八九十百千万\d]+)章\s+(.+)$/m)
      if (!heading) throw new Error(`无法读取《${book.title}》章节标题：${file}`)
      const number = chineseNumberToInt(heading[1])
      const relativeFile = path.relative(root, file).split(path.sep).join('/')
      return {
        number,
        numberText: heading[1],
        title: safeTitle(heading[2]),
        group: relativeFile.split('/')[0],
        file: relativeFile,
        link: `/${book.slug}/正文/${relativeFile.replace(/\.md$/, '')}`
      }
    })
    .sort((a, b) => a.number - b.number)
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
  const manifestBooks = books.map(book => {
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
      range: `第 ${chapters[0].number}—${chapters.at(-1).number} 章`,
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
