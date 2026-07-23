import { invoke } from '@tauri-apps/api/core'
import type { ChapterKind, LocalBook, ParseOptions, ParseResult, ThemeSettings } from '@novel-library/reader-core'

export type DesktopBook = LocalBook & { chapterProgress: number }

export interface DesktopBookSummary {
  id: string
  title: string
  author: string
  sourceFormat: 'txt' | 'epub'
  coverDataUrl?: string
  chapterCount: number
  totalWords: number
  currentChapter: number
  progress: number
  chapterProgress: number
}

export interface SavedBookResult {
  id: string
}

export interface DesktopChapterSummary {
  id: string
  bookId: string
  number: number
  originalLabel: string
  title: string
  volume: string
  kind: ChapterKind
  wordCount: number
  contentFormat: 'text' | 'html'
}

export interface DesktopChapter extends DesktopChapterSummary {
  content: string
  contentText: string
}

export interface DesktopSearchResult {
  bookId: string
  bookTitle: string
  chapterNumber: number
  originalLabel: string
  kind: ChapterKind
  chapterTitle: string
  snippet: string
}

export interface DesktopStorageStatus {
  databaseReady: boolean
  dataDirectory: string
  databasePath: string
}

export interface DesktopBackupResult {
  path: string
  books: number
  chapters: number
  notes: number
}

export interface DesktopExternalFile {
  name: string
  bytes: number[]
}

export type CloseBehavior = 'ask' | 'minimizeToTray' | 'quit'

export interface BundledIdePlugin {
  id: string
  label: string
  kind: 'vscode' | 'jetbrains' | 'visual-studio'
  version: string
  identifier: string
  description: string
  packageType: string
  supportedIdes: string[]
  available: boolean
}

export interface IdeTarget {
  id: string
  label: string
  kind: BundledIdePlugin['kind']
  path: string
  installed: boolean
  installedVersion?: string
  canUninstall: boolean
}

export interface IdeIntegrationStatus {
  plugins: BundledIdePlugin[]
  targets: IdeTarget[]
}

export interface IdeInstallResult {
  target: string
  plugin: string
  installed: boolean
  verified: boolean
  installedVersion?: string
  message: string
}

let bookSummaryCache: DesktopBookSummary[] | undefined
let bookSummaryRequest: Promise<DesktopBookSummary[]> | undefined

export function getCachedDesktopBooks() {
  return bookSummaryCache ? [...bookSummaryCache] : undefined
}

export function invalidateDesktopBookCache() {
  bookSummaryCache = undefined
}

export function listDesktopBooks(options: { forceRefresh?: boolean } = {}) {
  if (!options.forceRefresh && bookSummaryCache) return Promise.resolve([...bookSummaryCache])
  if (bookSummaryRequest) return bookSummaryRequest
  bookSummaryRequest = invoke<DesktopBookSummary[]>('list_book_summaries')
    .then(books => {
      bookSummaryCache = books
      return [...books]
    })
    .finally(() => {
      bookSummaryRequest = undefined
    })
  return bookSummaryRequest
}

export function getDesktopBook(bookId: string) {
  return invoke<DesktopBook | null>('get_book', { bookId })
}

export function listDesktopChapters(bookId: string) {
  return invoke<DesktopChapterSummary[]>('list_chapters', { bookId })
}

export function getDesktopChapter(bookId: string, number: number) {
  return invoke<DesktopChapter | null>('get_chapter', { bookId, number })
}

export function saveDesktopBook(input: {
  result: ParseResult
  theme: ThemeSettings
  options: ParseOptions
  existingId?: string
}) {
  return invoke<SavedBookResult>('save_imported_book', { input }).then(book => {
    invalidateDesktopBookCache()
    return book
  })
}

export function saveDesktopProgress(bookId: string, chapterNumber: number, chapterProgress: number) {
  return invoke<void>('save_reading_progress', { input: { bookId, chapterNumber, chapterProgress } }).then(() => {
    invalidateDesktopBookCache()
  })
}

export function deleteDesktopBook(bookId: string) {
  return invoke<void>('delete_book', { bookId }).then(() => {
    invalidateDesktopBookCache()
  })
}

export function searchDesktopLibrary(query: string) {
  return invoke<DesktopSearchResult[]>('search_library', { query })
}

export function getDesktopStorageStatus() {
  return invoke<DesktopStorageStatus>('get_storage_status')
}

export function changeDesktopDataDirectory(dataDirectory: string) {
  return invoke<DesktopStorageStatus>('change_data_directory', { dataDirectory }).then(status => {
    invalidateDesktopBookCache()
    return status
  })
}

export function resetDesktopDataDirectory() {
  return invoke<DesktopStorageStatus>('reset_data_directory').then(status => {
    invalidateDesktopBookCache()
    return status
  })
}

export function changeDesktopDatabaseFile(databasePath: string) {
  return invoke<DesktopStorageStatus>('change_database_file', { databasePath }).then(status => {
    invalidateDesktopBookCache()
    return status
  })
}

export function exportDesktopBackup(targetPath: string) {
  return invoke<DesktopBackupResult>('export_backup', { targetPath })
}

export function importDesktopBackup(sourcePath: string) {
  return invoke<DesktopBackupResult>('import_backup', { sourcePath }).then(result => {
    invalidateDesktopBookCache()
    return result
  })
}

export function readDesktopExternalFile(path: string) {
  return invoke<DesktopExternalFile>('read_external_file', { path })
}

export function getCloseBehavior() {
  return invoke<CloseBehavior>('get_close_behavior')
}

export function setCloseBehavior(behavior: CloseBehavior) {
  return invoke<CloseBehavior>('set_close_behavior', { behavior })
}

export function resolveCloseBehavior(behavior: Exclude<CloseBehavior, 'ask'>, remember: boolean) {
  return invoke<void>('resolve_close_behavior', { behavior, remember })
}

export function cancelCloseBehaviorPrompt() {
  return invoke<void>('cancel_close_behavior_prompt')
}

export function getIdeIntegrationStatus() {
  return invoke<IdeIntegrationStatus>('get_ide_integration_status')
}

export function installIdePlugin(targetId: string, pluginId: string, closeRunningIde = false) {
  return invoke<IdeInstallResult>('install_ide_plugin', { input: { targetId, pluginId, closeRunningIde } })
}

export function uninstallIdePlugin(targetId: string, pluginId: string) {
  return invoke<IdeInstallResult>('uninstall_ide_plugin', { input: { targetId, pluginId } })
}
