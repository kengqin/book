export const READER_PROTOCOL_VERSION = 1

export interface BridgeManifest {
  protocolVersion: number
  appVersion: string
  port: number
  sessionId: string
  capabilities: string[]
}

export interface BridgeBook {
  id: string
  title: string
  author: string
  description: string
  sourceName: string
  sourceFormat: 'txt' | 'epub'
  chapterCount: number
  totalWords: number
  currentChapter: number
  progress: number
  chapterProgress: number
  updatedAt: number
  lastReadAt: number
}

export interface BridgeChapterSummary {
  id: string
  bookId: string
  number: number
  originalLabel: string
  title: string
  volume: string
  kind: string
  wordCount: number
  contentFormat: 'text' | 'html'
}

export interface BridgeChapter extends BridgeChapterSummary {
  content: string
  contentText: string
}

export interface ProgressUpdate {
  bookId: string
  chapterNumber: number
  chapterProgress: number
  anchorOffset?: number
  paragraphIndex?: number
  lineIndex?: number
  updatedAt?: number
}

export interface ImportRequest {
  path: string
  existingId?: string
}

export interface OpenRequest {
  bookId: string
  chapterNumber?: number
}

export type BridgeEvent =
  | { type: 'book-updated'; bookId: string }
  | { type: 'progress-updated'; update: ProgressUpdate }
  | { type: 'import-requested'; request: ImportRequest }
  | { type: 'open-requested'; request: OpenRequest }

export function bridgeUrl(port: number, path: string) {
  return `http://127.0.0.1:${port}${path}`
}
