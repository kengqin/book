import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import {
  calculateOverallProgress,
  type LibraryMaintenanceService,
  type LibraryRepository,
  type LocalAsset,
  type LocalBook,
  type LocalChapter,
  type SaveImportedBookInput,
  type StorageStats,
  type ThemeSettings
} from '@novel-library/reader-core'

interface LibraryDB extends DBSchema {
  books: {
    key: string
    value: LocalBook
    indexes: { 'by-updated': number }
  }
  chapters: {
    key: string
    value: LocalChapter
    indexes: { 'by-book': string; 'by-book-number': [string, number] }
  }
  assets: {
    key: string
    value: LocalAsset
    indexes: { 'by-book': string }
  }
}

let database: Promise<IDBPDatabase<LibraryDB>> | undefined

function getDB() {
  if (typeof indexedDB === 'undefined') throw new Error('当前环境不支持浏览器本地数据库')
  database ??= openDB<LibraryDB>('novel-library-v1', 1, {
    upgrade(db) {
      const books = db.createObjectStore('books', { keyPath: 'id' })
      books.createIndex('by-updated', 'updatedAt')
      const chapters = db.createObjectStore('chapters', { keyPath: 'id' })
      chapters.createIndex('by-book', 'bookId')
      chapters.createIndex('by-book-number', ['bookId', 'number'], { unique: true })
      const assets = db.createObjectStore('assets', { keyPath: 'id' })
      assets.createIndex('by-book', 'bookId')
    }
  })
  return database
}

async function removeBookRecords(db: IDBPDatabase<LibraryDB>, bookId: string) {
  const tx = db.transaction(['chapters', 'assets'], 'readwrite')
  const chapterKeys = await tx.objectStore('chapters').index('by-book').getAllKeys(bookId)
  const assetKeys = await tx.objectStore('assets').index('by-book').getAllKeys(bookId)
  await Promise.all([
    ...chapterKeys.map(key => tx.objectStore('chapters').delete(key)),
    ...assetKeys.map(key => tx.objectStore('assets').delete(key))
  ])
  await tx.done
}

export async function saveImportedBook(input: SaveImportedBookInput) {
  const db = await getDB()
  const id = input.existingId ?? crypto.randomUUID()
  const previous = input.existingId ? await db.get('books', id) : undefined
  const previousCover = previous ? await db.get('assets', `${id}:cover`) : undefined
  if (previous) await removeBookRecords(db, id)
  const now = Date.now()
  const coverBlob = input.cover ?? (input.theme.coverAssetId ? previousCover?.blob : undefined)
  const coverAssetId = coverBlob ? `${id}:cover` : undefined
  const theme = { ...input.theme, coverAssetId }
  const volumes = [...new Set(input.result.chapters.map(chapter => chapter.volume).filter(Boolean))]
  const book: LocalBook = {
    id,
    title: input.result.metadata.title,
    author: input.result.metadata.author || '佚名',
    description: input.result.metadata.description,
    sourceName: input.result.metadata.sourceName,
    sourceSize: input.result.metadata.sourceSize,
    encoding: input.result.metadata.encoding,
    chapterCount: input.result.chapters.length,
    totalWords: input.result.chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
    volumes,
    theme,
    parseOptions: { ...input.options },
    currentChapter: Math.min(previous?.currentChapter ?? 1, input.result.chapters.length),
    progress: previous?.progress ?? 0,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    lastReadAt: previous?.lastReadAt ?? now
  }

  const tx = db.transaction(['books', 'chapters', 'assets'], 'readwrite')
  tx.objectStore('books').put(book)
  if (coverBlob) tx.objectStore('assets').put({ id: coverAssetId!, bookId: id, kind: 'cover', name: 'cover', blob: coverBlob })
  for (const chapter of input.result.chapters) {
    tx.objectStore('chapters').put({ ...chapter, id: `${id}:${chapter.number}`, bookId: id })
  }
  await tx.done
  return book
}

export async function getBooks() {
  const books = await (await getDB()).getAll('books')
  return books.sort((a, b) => b.lastReadAt - a.lastReadAt)
}

export async function getBook(id: string) { return (await getDB()).get('books', id) }
export async function getChapter(bookId: string, number: number) { return (await getDB()).getFromIndex('chapters', 'by-book-number', [bookId, number]) }

export async function getChapters(bookId: string) {
  const chapters = await (await getDB()).getAllFromIndex('chapters', 'by-book', bookId)
  return chapters.sort((a, b) => a.number - b.number)
}

export async function getAsset(bookId: string, kind: LocalAsset['kind']) {
  const assets = await (await getDB()).getAllFromIndex('assets', 'by-book', bookId)
  return assets.find(asset => asset.kind === kind)
}

export async function updateBookProgress(bookId: string, chapter: number, progress: number) {
  const db = await getDB()
  const book = await db.get('books', bookId)
  if (!book) return
  const overallProgress = calculateOverallProgress(chapter, progress, book.chapterCount)
  await db.put('books', { ...book, currentChapter: chapter, progress: overallProgress, lastReadAt: Date.now() })
}

export async function updateBookTheme(bookId: string, theme: ThemeSettings, cover?: Blob) {
  const db = await getDB()
  const book = await db.get('books', bookId)
  if (!book) return
  const tx = db.transaction(['books', 'assets'], 'readwrite')
  let coverAssetId = theme.coverAssetId
  if (cover) {
    coverAssetId = `${bookId}:cover`
    tx.objectStore('assets').put({ id: coverAssetId, bookId, kind: 'cover', name: 'cover', blob: cover })
  } else if (!coverAssetId) {
    tx.objectStore('assets').delete(`${bookId}:cover`)
  }
  tx.objectStore('books').put({ ...book, theme: { ...theme, coverAssetId }, updatedAt: Date.now() })
  await tx.done
}

export async function deleteBook(bookId: string) {
  const db = await getDB()
  await removeBookRecords(db, bookId)
  await db.delete('books', bookId)
}

function blobToDataURL(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

function dataURLToBlob(data: string) {
  const [header, payload] = data.split(',')
  const mime = header.match(/data:([^;]+)/)?.[1] ?? 'application/octet-stream'
  const bytes = Uint8Array.from(atob(payload), character => character.charCodeAt(0))
  return new Blob([bytes], { type: mime })
}

export async function exportLibrary() {
  const db = await getDB()
  const [books, chapters, assets] = await Promise.all([db.getAll('books'), db.getAll('chapters'), db.getAll('assets')])
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    books,
    chapters,
    assets: await Promise.all(assets.map(async asset => ({ ...asset, blob: await blobToDataURL(asset.blob) })))
  }
}

export async function importLibraryBackup(payload: unknown) {
  const backup = payload as { version?: number; books?: LocalBook[]; chapters?: LocalChapter[]; assets?: Array<Omit<LocalAsset, 'blob'> & { blob: string }> }
  if (backup?.version !== 1 || !Array.isArray(backup.books) || !Array.isArray(backup.chapters)) throw new Error('不是有效的本地书架备份')
  const db = await getDB()
  const tx = db.transaction(['books', 'chapters', 'assets'], 'readwrite')
  for (const book of backup.books) tx.objectStore('books').put(book)
  for (const chapter of backup.chapters) tx.objectStore('chapters').put(chapter)
  for (const asset of backup.assets ?? []) tx.objectStore('assets').put({ ...asset, blob: dataURLToBlob(asset.blob) })
  await tx.done
}

export async function clearLibrary() {
  const db = await getDB()
  const tx = db.transaction(['books', 'chapters', 'assets'], 'readwrite')
  await Promise.all([tx.objectStore('books').clear(), tx.objectStore('chapters').clear(), tx.objectStore('assets').clear()])
  await tx.done
}

export async function getLibraryStats(): Promise<StorageStats> {
  const db = await getDB()
  const [books, chapters, estimate] = await Promise.all([
    db.count('books'),
    db.count('chapters'),
    globalThis.navigator?.storage?.estimate?.() ?? Promise.resolve({ usage: 0, quota: 0 })
  ])
  return { books, chapters, usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 }
}

export const indexedDbLibraryRepository: LibraryRepository = {
  saveImportedBook,
  getBooks,
  getBook,
  getChapter,
  getChapters,
  getAsset,
  updateBookProgress,
  updateBookTheme,
  deleteBook
}

export const indexedDbMaintenanceService: LibraryMaintenanceService = {
  exportLibrary,
  importLibraryBackup,
  clearLibrary,
  getLibraryStats
}
