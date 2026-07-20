import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { defaultParseOptions, defaultTheme } from '@novel-library/reader-core'
import { clearLibrary, deleteBook, exportBook, exportLibrary, getBook, getBooks, getChapter, getChapters, importLibraryBackup, saveImportedBook, searchLibrary, updateBookProgress } from './index'

beforeEach(async () => {
  await clearLibrary()
})

describe('IndexedDB library repository', () => {
  it('stores a parsed book and its chapters', async () => {
    const book = await saveImportedBook({
      options: defaultParseOptions,
      theme: defaultTheme,
      result: {
        metadata: {
          title: '测试书',
          author: '测试作者',
          description: '',
          encoding: 'utf-8',
          sourceName: '测试书.txt',
          sourceSize: 100,
          sourceFormat: 'txt'
        },
        warnings: [],
        chapters: [
          { number: 1, originalLabel: '一', title: '开始', volume: '第一卷', content: '正文', contentText: '正文', contentFormat: 'text', wordCount: 2 },
          { number: 2, originalLabel: '二', title: '继续', volume: '第一卷', content: '更多正文', contentText: '更多正文', contentFormat: 'text', wordCount: 4 }
        ]
      }
    })

    expect(await getBooks()).toHaveLength(1)
    expect(await getBook(book.id)).toMatchObject({ title: '测试书', chapterCount: 2, totalWords: 6 })
    expect(await getChapters(book.id)).toHaveLength(2)
    expect(await getChapter(book.id, 2)).toMatchObject({ title: '继续' })
  })

  it('updates reading progress and deletes related records', async () => {
    const book = await saveImportedBook({
      options: defaultParseOptions,
      theme: defaultTheme,
      result: {
        metadata: { title: '进度测试', author: '', description: '', encoding: 'utf-8', sourceName: 'progress.txt', sourceSize: 10, sourceFormat: 'txt' },
        warnings: [],
        chapters: [
          { number: 1, originalLabel: '一', title: '一', volume: '', content: '一', contentText: '一', contentFormat: 'text', wordCount: 1 },
          { number: 2, originalLabel: '二', title: '二', volume: '', content: '二', contentText: '二', contentFormat: 'text', wordCount: 1 }
        ]
      }
    })

    await updateBookProgress(book.id, 2, 50)
    expect(await getBook(book.id)).toMatchObject({ currentChapter: 2, progress: 75 })

    await deleteBook(book.id)
    expect(await getBook(book.id)).toBeUndefined()
    expect(await getChapters(book.id)).toEqual([])
  })

  it('searches chapter content and round-trips full and single-book backups', async () => {
    const first = await saveImportedBook({
      options: defaultParseOptions,
      theme: defaultTheme,
      result: {
        metadata: { title: '青山录', author: '无名', description: '', encoding: 'utf-8', sourceName: 'book.txt', sourceSize: 20, sourceFormat: 'txt' },
        warnings: [],
        chapters: [{ number: 1, originalLabel: '一', title: '入山', volume: '', content: '山门前有一条青石长阶', contentText: '山门前有一条青石长阶', contentFormat: 'text', wordCount: 10 }]
      }
    })
    await saveImportedBook({
      options: defaultParseOptions,
      theme: defaultTheme,
      result: {
        metadata: { title: '别卷', author: '', description: '', encoding: 'utf-8', sourceName: 'other.txt', sourceSize: 10, sourceFormat: 'txt' },
        warnings: [],
        chapters: [{ number: 1, originalLabel: '一', title: '正文', volume: '', content: '没有命中', contentText: '没有命中', contentFormat: 'text', wordCount: 4 }]
      }
    })

    expect(await searchLibrary('青石长阶')).toMatchObject([{ bookId: first.id, chapterTitle: '入山' }])
    const single = await exportBook(first.id)
    expect(single).toMatchObject({ format: 'novel-library-book', books: [{ id: first.id }] })
    const full = await exportLibrary()
    expect(full).toMatchObject({ format: 'novel-library-backup', version: 1 })

    await clearLibrary()
    await importLibraryBackup(single)
    expect(await getBooks()).toHaveLength(1)
    expect((await getBooks())[0].title).toBe('青山录')
  })
})
