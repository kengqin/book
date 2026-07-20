import { CapacitorSQLite } from '@capacitor-community/sqlite'
import { calculateOverallProgress, type LibrarySearchResult, type LocalAsset, type LocalBook, type LocalChapter, type SaveImportedBookInput, type StorageStats, type ThemeSettings } from '@novel-library/reader-core'

const database = 'novel-library'
let ready: Promise<void> | undefined

function dbReady() {
  ready ??= (async () => {
    await CapacitorSQLite.createConnection({ database, version: 1, encrypted: false, mode: 'no-encryption', readonly: false })
    await CapacitorSQLite.open({ database })
    await CapacitorSQLite.execute({ database, statements: `
      CREATE TABLE IF NOT EXISTS books (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL, last_read_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chapters (id TEXT PRIMARY KEY NOT NULL, book_id TEXT NOT NULL, number INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(book_id, number));
      CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY NOT NULL, book_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chapters_book_idx ON chapters(book_id, number);
    ` })
  })()
  return ready
}

async function query<T>(statement: string, values: unknown[] = []) {
  await dbReady()
  const result = await CapacitorSQLite.query({ database, statement, values })
  return (result.values ?? []) as T[]
}

async function run(statement: string, values: unknown[] = []) {
  await dbReady()
  await CapacitorSQLite.run({ database, statement, values })
}

function decode<T>(value: string) {
  return JSON.parse(value) as T
}

function encode(value: unknown) {
  return JSON.stringify(value)
}

export async function saveImportedBook(input: SaveImportedBookInput): Promise<LocalBook> {
  const id = input.existingId ?? crypto.randomUUID()
  const previous = input.existingId ? await getBook(id) : undefined
  const now = Date.now()
  const volumes = [...new Set(input.result.chapters.filter(chapter => chapter.kind !== 'frontmatter').map(chapter => chapter.volume).filter(Boolean))]
  const book: LocalBook = {
    id,
    title: input.result.metadata.title,
    author: input.result.metadata.author || '佚名',
    description: input.result.metadata.description,
    sourceName: input.result.metadata.sourceName,
    sourceSize: input.result.metadata.sourceSize,
    encoding: input.result.metadata.encoding,
    sourceFormat: input.result.metadata.sourceFormat,
    coverDataUrl: input.result.metadata.coverDataUrl,
    chapterCount: input.result.chapters.length,
    totalWords: input.result.chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
    volumes,
    theme: { ...input.theme },
    parseOptions: { ...input.options },
    currentChapter: Math.min(previous?.currentChapter ?? 1, input.result.chapters.length),
    progress: previous?.progress ?? 0,
    chapterProgress: previous?.chapterProgress ?? 0,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    lastReadAt: previous?.lastReadAt ?? now
  }
  await dbReady()
  await CapacitorSQLite.executeSet({ database, set: [
    { statement: 'DELETE FROM chapters WHERE book_id = ?', values: [id] },
    { statement: 'DELETE FROM assets WHERE book_id = ?', values: [id] },
    { statement: 'INSERT OR REPLACE INTO books(id, payload, updated_at, last_read_at) VALUES (?, ?, ?, ?)', values: [id, encode(book), book.updatedAt, book.lastReadAt] },
    ...input.result.chapters.map(chapter => ({ statement: 'INSERT INTO chapters(id, book_id, number, payload) VALUES (?, ?, ?, ?)', values: [`${id}:${chapter.number}`, id, chapter.number, encode({ ...chapter, id: `${id}:${chapter.number}`, bookId: id })] }))
  ], transaction: true })
  return book
}

export async function getBooks() {
  const rows = await query<{ payload: string }>('SELECT payload FROM books ORDER BY last_read_at DESC')
  return rows.map(row => decode<LocalBook>(row.payload))
}

export async function getBook(id: string) {
  const rows = await query<{ payload: string }>('SELECT payload FROM books WHERE id = ?', [id])
  return rows[0] ? decode<LocalBook>(rows[0].payload) : undefined
}

export async function getChapter(bookId: string, number: number) {
  const rows = await query<{ payload: string }>('SELECT payload FROM chapters WHERE book_id = ? AND number = ?', [bookId, number])
  return rows[0] ? decode<LocalChapter>(rows[0].payload) : undefined
}

export async function getChapters(bookId: string) {
  const rows = await query<{ payload: string }>('SELECT payload FROM chapters WHERE book_id = ? ORDER BY number', [bookId])
  return rows.map(row => decode<LocalChapter>(row.payload))
}

export async function updateBookProgress(bookId: string, chapter: number, progress: number) {
  const book = await getBook(bookId)
  if (!book) return
  const updated = { ...book, currentChapter: chapter, progress: calculateOverallProgress(chapter, progress, book.chapterCount), chapterProgress: Math.min(100, Math.max(0, progress)), lastReadAt: Date.now() }
  await run('UPDATE books SET payload = ?, updated_at = ?, last_read_at = ? WHERE id = ?', [encode(updated), updated.updatedAt, updated.lastReadAt, bookId])
}

export async function updateBookTheme(bookId: string, theme: ThemeSettings, _cover?: Blob) {
  const book = await getBook(bookId)
  if (!book) return
  const updated = { ...book, theme: { ...theme }, updatedAt: Date.now() }
  await run('UPDATE books SET payload = ?, updated_at = ? WHERE id = ?', [encode(updated), updated.updatedAt, bookId])
}

export async function deleteBook(bookId: string) {
  await dbReady()
  await CapacitorSQLite.executeSet({ database, set: [
    { statement: 'DELETE FROM chapters WHERE book_id = ?', values: [bookId] },
    { statement: 'DELETE FROM assets WHERE book_id = ?', values: [bookId] },
    { statement: 'DELETE FROM books WHERE id = ?', values: [bookId] }
  ], transaction: true })
}

async function getAssets() {
  const rows = await query<{ payload: string }>('SELECT payload FROM assets')
  return rows.map(row => decode<LocalAsset & { blob: string }>(row.payload))
}

export async function exportLibrary() {
  const [books, chapters, assets] = await Promise.all([getBooks(), query<{ payload: string }>('SELECT payload FROM chapters ORDER BY book_id, number'), getAssets()])
  return { format: 'novel-library-backup', version: 1, exportedAt: new Date().toISOString(), books, chapters: chapters.map(row => decode<LocalChapter>(row.payload)), assets }
}

export async function exportBook(bookId: string) {
  const book = await getBook(bookId)
  if (!book) throw new Error('要导出的书籍不存在')
  return { format: 'novel-library-book', version: 1, exportedAt: new Date().toISOString(), books: [book], chapters: await getChapters(bookId), assets: (await getAssets()).filter(asset => asset.bookId === bookId) }
}

export async function importLibraryBackup(payload: unknown) {
  const backup = payload as { format?: string; version?: number; books?: LocalBook[]; chapters?: LocalChapter[]; assets?: Array<LocalAsset & { blob: string }> }
  if (backup?.version !== 1 || !Array.isArray(backup.books) || !Array.isArray(backup.chapters)) throw new Error('不是有效的本地书架备份')
  if (backup.format !== undefined && !['novel-library-backup', 'novel-library-book'].includes(backup.format)) throw new Error('不支持的备份格式')
  const bookIds = new Set(backup.books.map(book => book?.id).filter((id): id is string => typeof id === 'string' && Boolean(id)))
  if (bookIds.size !== backup.books.length || backup.chapters.some(chapter => !chapter?.id || !bookIds.has(chapter.bookId))) throw new Error('备份中的书籍或章节关联无效')
  await dbReady()
  await CapacitorSQLite.executeSet({ database, set: [
    ...backup.books.map(book => ({ statement: 'INSERT OR REPLACE INTO books(id, payload, updated_at, last_read_at) VALUES (?, ?, ?, ?)', values: [book.id, encode({ ...book, chapterProgress: Number.isFinite(book.chapterProgress) ? book.chapterProgress : 0 }), book.updatedAt, book.lastReadAt] })),
    ...backup.chapters.map(chapter => ({ statement: 'INSERT OR REPLACE INTO chapters(id, book_id, number, payload) VALUES (?, ?, ?, ?)', values: [chapter.id, chapter.bookId, chapter.number, encode(chapter)] })),
    ...(backup.assets ?? []).map(asset => ({ statement: 'INSERT OR REPLACE INTO assets(id, book_id, kind, payload) VALUES (?, ?, ?, ?)', values: [asset.id, asset.bookId, asset.kind, encode(asset)] }))
  ], transaction: true })
}

function searchSnippet(content: string, queryText: string) {
  const normalized = content.replace(/\s+/gu, ' ').trim()
  const index = normalized.toLocaleLowerCase().indexOf(queryText.toLocaleLowerCase())
  if (index < 0) return normalized.slice(0, 100)
  const start = Math.max(0, index - 42)
  const end = Math.min(normalized.length, index + queryText.length + 58)
  return `${start ? '…' : ''}${normalized.slice(start, end)}${end < normalized.length ? '…' : ''}`
}

export async function searchLibrary(queryText: string, limit = 200): Promise<LibrarySearchResult[]> {
  const normalized = queryText.trim().toLocaleLowerCase()
  if (!normalized) return []
  const books = await getBooks()
  const bookMap = new Map(books.map(book => [book.id, book]))
  const rows = await query<{ payload: string }>('SELECT payload FROM chapters ORDER BY number')
  const results: LibrarySearchResult[] = []
  for (const row of rows) {
    const chapter = decode<LocalChapter>(row.payload)
    const book = bookMap.get(chapter.bookId)
    if (!book) continue
    const match = `${book.title}\n${book.author}\n${chapter.title}\n${chapter.originalLabel}\n${chapter.contentText}`.toLocaleLowerCase().includes(normalized)
    if (!match) continue
    results.push({ bookId: book.id, bookTitle: book.title, chapterNumber: chapter.number, originalLabel: chapter.originalLabel, kind: chapter.kind, chapterTitle: chapter.title, snippet: searchSnippet(chapter.contentText, queryText.trim()) })
    if (results.length >= Math.max(1, limit)) break
  }
  return results
}

export async function clearLibrary() {
  await dbReady()
  await CapacitorSQLite.execute({ database, statements: 'DELETE FROM books; DELETE FROM chapters; DELETE FROM assets;' })
}

export async function getLibraryStats(): Promise<StorageStats> {
  const [books, chapters] = await Promise.all([query<{ count: number }>('SELECT COUNT(*) AS count FROM books'), query<{ count: number }>('SELECT COUNT(*) AS count FROM chapters')])
  return { books: Number(books[0]?.count ?? 0), chapters: Number(chapters[0]?.count ?? 0), usage: 0, quota: 0 }
}
