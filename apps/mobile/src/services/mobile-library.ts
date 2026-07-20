import { defaultParseOptions, defaultTheme, type LocalBook, type LocalChapter, type ParseResult } from '@novel-library/reader-core'
import { Capacitor } from '@capacitor/core'
import {
  clearLibrary as webClearLibrary,
  deleteBook as webDeleteBook,
  exportBook as webExportBook,
  exportLibrary as webExportLibrary,
  getBook as webGetBook,
  getBooks as webGetBooks,
  getChapter as webGetChapter,
  getChapters as webGetChapters,
  getLibraryStats as webGetLibraryStats,
  importLibraryBackup as webImportLibraryBackup,
  saveImportedBook as webSaveImportedBook,
  searchLibrary as webSearchLibrary,
  updateBookProgress as webUpdateBookProgress,
  updateBookTheme as webUpdateBookTheme
} from '@novel-library/storage-web'
import * as native from './native-library'

export type MobileBook = LocalBook
export type MobileChapter = LocalChapter

export async function saveMobileBook(result: ParseResult, existingId?: string) {
  return backend.saveImportedBook({ result, existingId, options: { ...defaultParseOptions }, theme: { ...defaultTheme } })
}

const backend = Capacitor.isNativePlatform() ? native : {
  saveImportedBook: webSaveImportedBook,
  clearLibrary: webClearLibrary,
  deleteBook: webDeleteBook,
  exportBook: webExportBook,
  exportLibrary: webExportLibrary,
  getBook: webGetBook,
  getBooks: webGetBooks,
  getChapter: webGetChapter,
  getChapters: webGetChapters,
  getLibraryStats: webGetLibraryStats,
  importLibraryBackup: webImportLibraryBackup,
  searchLibrary: webSearchLibrary,
  updateBookProgress: webUpdateBookProgress,
  updateBookTheme: webUpdateBookTheme
}

export const clearLibrary = (...args: Parameters<typeof backend.clearLibrary>) => backend.clearLibrary(...args)
export const deleteBook = (...args: Parameters<typeof backend.deleteBook>) => backend.deleteBook(...args)
export const exportBook = (...args: Parameters<typeof backend.exportBook>) => backend.exportBook(...args)
export const exportLibrary = (...args: Parameters<typeof backend.exportLibrary>) => backend.exportLibrary(...args)
export const getBook = (...args: Parameters<typeof backend.getBook>) => backend.getBook(...args)
export const getBooks = (...args: Parameters<typeof backend.getBooks>) => backend.getBooks(...args)
export const getChapter = (...args: Parameters<typeof backend.getChapter>) => backend.getChapter(...args)
export const getChapters = (...args: Parameters<typeof backend.getChapters>) => backend.getChapters(...args)
export const getLibraryStats = (...args: Parameters<typeof backend.getLibraryStats>) => backend.getLibraryStats(...args)
export const importLibraryBackup = (...args: Parameters<typeof backend.importLibraryBackup>) => backend.importLibraryBackup(...args)
export const searchLibrary = (...args: Parameters<typeof backend.searchLibrary>) => backend.searchLibrary(...args)
export const updateBookProgress = (...args: Parameters<typeof backend.updateBookProgress>) => backend.updateBookProgress(...args)
export const updateBookTheme = (...args: Parameters<typeof backend.updateBookTheme>) => backend.updateBookTheme(...args)
