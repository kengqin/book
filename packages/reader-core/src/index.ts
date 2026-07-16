export type TextEncoding = 'auto' | 'utf-8' | 'gb18030' | 'utf-16le' | 'utf-16be'

export interface ParseOptions {
  encoding: TextEncoding
  chapterPattern: string
  adPatterns: string
  mergeWrapped: boolean
  removeAds: boolean
}

export interface ThemeSettings {
  preset: string
  accent: string
  background: string
  text: string
  overlay: number
  positionX: number
  positionY: number
  coverAssetId?: string
}

export type ChapterKind = 'frontmatter' | 'volume' | 'chapter' | 'appendix'

export interface ParsedChapter {
  number: number
  originalLabel: string
  title: string
  volume: string
  kind: ChapterKind
  content: string
  contentText: string
  contentFormat: 'text' | 'html'
  wordCount: number
}

export interface ParseResult {
  metadata: {
    title: string
    author: string
    description: string
    encoding: Exclude<TextEncoding, 'auto'>
    sourceName: string
    sourceSize: number
    sourceFormat: 'txt' | 'epub'
    coverDataUrl?: string
  }
  chapters: ParsedChapter[]
  warnings: string[]
}

export interface LocalBook {
  id: string
  title: string
  author: string
  description: string
  sourceName: string
  sourceSize: number
  encoding: string
  sourceFormat: 'txt' | 'epub'
  coverDataUrl?: string
  chapterCount: number
  totalWords: number
  volumes: string[]
  theme: ThemeSettings
  parseOptions: ParseOptions
  currentChapter: number
  progress: number
  createdAt: number
  updatedAt: number
  lastReadAt: number
}

export interface LocalChapter extends ParsedChapter {
  id: string
  bookId: string
}

export interface LocalAsset {
  id: string
  bookId: string
  kind: 'cover'
  name: string
  blob: Blob
}

export interface ParserRequest {
  buffer: ArrayBuffer
  filename: string
  options: ParseOptions
}

export type ParserResponse =
  | { type: 'progress'; progress: number; message: string }
  | { type: 'complete'; result: ParseResult }
  | { type: 'error'; message: string }

export const defaultParseOptions: ParseOptions = {
  encoding: 'auto',
  chapterPattern: '',
  adPatterns: [
    '更多精彩小说.*',
    '手机用户请访问.*',
    '请记住本书首发域名.*',
    '本章未完.*点击下一页'
  ].join('\n'),
  mergeWrapped: true,
  removeAds: true
}

export const defaultTheme: ThemeSettings = {
  preset: 'ink',
  accent: '#c9a866',
  background: '#101719',
  text: '#f1f2ef',
  overlay: 48,
  positionX: 50,
  positionY: 50
}

export function formatChapterLabel(chapter: Pick<ParsedChapter, 'number' | 'originalLabel'>) {
  const label = chapter.originalLabel.trim()
  if (/^\d+$/u.test(label)) return `第${Number(label)}章`
  if (/^[零〇一二两三四五六七八九十百千万两]+$/u.test(label)) return `第${label}章`
  return label || `第${chapter.number}章`
}

export function isNumberedChapter(chapter: Pick<ParsedChapter, 'kind'>) {
  return chapter.kind === 'chapter'
}

export function calculateOverallProgress(chapterNumber: number, chapterProgress: number, chapterCount: number) {
  const normalizedChapter = Math.max(1, chapterNumber)
  const normalizedProgress = Math.min(100, Math.max(0, chapterProgress))
  return Math.min(100, ((normalizedChapter - 1) + normalizedProgress / 100) / Math.max(1, chapterCount) * 100)
}

export interface SaveImportedBookInput {
  result: ParseResult
  cover?: Blob
  theme: ThemeSettings
  options: ParseOptions
  existingId?: string
}

export interface LibraryRepository {
  saveImportedBook(input: SaveImportedBookInput): Promise<LocalBook>
  getBooks(): Promise<LocalBook[]>
  getBook(id: string): Promise<LocalBook | undefined>
  getChapter(bookId: string, number: number): Promise<LocalChapter | undefined>
  getChapters(bookId: string): Promise<LocalChapter[]>
  getAsset(bookId: string, kind: LocalAsset['kind']): Promise<LocalAsset | undefined>
  updateBookProgress(bookId: string, chapter: number, progress: number): Promise<void>
  updateBookTheme(bookId: string, theme: ThemeSettings, cover?: Blob): Promise<void>
  deleteBook(bookId: string): Promise<void>
}

export interface StorageStats {
  books: number
  chapters: number
  usage: number
  quota: number
}

export interface LibraryMaintenanceService {
  exportLibrary(): Promise<unknown>
  importLibraryBackup(payload: unknown): Promise<void>
  clearLibrary(): Promise<void>
  getLibraryStats(): Promise<StorageStats>
}
