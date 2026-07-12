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

export interface ParsedChapter {
  number: number
  originalLabel: string
  title: string
  volume: string
  content: string
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
