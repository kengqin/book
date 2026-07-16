import { invoke } from '@tauri-apps/api/core'
import type { LocalBook, ParseOptions, ParseResult, ThemeSettings } from '@novel-library/reader-core'

export type DesktopBook = LocalBook & { chapterProgress: number }

export interface DesktopChapterSummary {
  id: string
  bookId: string
  number: number
  originalLabel: string
  title: string
  volume: string
  wordCount: number
}

export interface DesktopChapter extends DesktopChapterSummary {
  content: string
}

export interface DesktopSearchResult {
  bookId: string
  bookTitle: string
  chapterNumber: number
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

export function listDesktopBooks() {
  return invoke<DesktopBook[]>('list_books')
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
  return invoke<DesktopBook>('save_imported_book', { input })
}

export function saveDesktopProgress(bookId: string, chapterNumber: number, chapterProgress: number) {
  return invoke<void>('save_reading_progress', { input: { bookId, chapterNumber, chapterProgress } })
}

export function deleteDesktopBook(bookId: string) {
  return invoke<void>('delete_book', { bookId })
}

export function searchDesktopLibrary(query: string) {
  return invoke<DesktopSearchResult[]>('search_library', { query })
}

export function getDesktopStorageStatus() {
  return invoke<DesktopStorageStatus>('get_storage_status')
}

export function changeDesktopDataDirectory(dataDirectory: string) {
  return invoke<DesktopStorageStatus>('change_data_directory', { dataDirectory })
}

export function resetDesktopDataDirectory() {
  return invoke<DesktopStorageStatus>('reset_data_directory')
}

export function changeDesktopDatabaseFile(databasePath: string) {
  return invoke<DesktopStorageStatus>('change_database_file', { databasePath })
}

export function exportDesktopBackup(targetPath: string) {
  return invoke<DesktopBackupResult>('export_backup', { targetPath })
}

export function importDesktopBackup(sourcePath: string) {
  return invoke<DesktopBackupResult>('import_backup', { sourcePath })
}
