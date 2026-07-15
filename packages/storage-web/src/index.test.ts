import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { defaultParseOptions, defaultTheme } from '@novel-library/reader-core'
import { clearLibrary, deleteBook, getBook, getBooks, getChapter, getChapters, saveImportedBook, updateBookProgress } from './index'

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
          sourceSize: 100
        },
        warnings: [],
        chapters: [
          { number: 1, originalLabel: '一', title: '开始', volume: '第一卷', content: '正文', wordCount: 2 },
          { number: 2, originalLabel: '二', title: '继续', volume: '第一卷', content: '更多正文', wordCount: 4 }
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
        metadata: { title: '进度测试', author: '', description: '', encoding: 'utf-8', sourceName: 'progress.txt', sourceSize: 10 },
        warnings: [],
        chapters: [
          { number: 1, originalLabel: '一', title: '一', volume: '', content: '一', wordCount: 1 },
          { number: 2, originalLabel: '二', title: '二', volume: '', content: '二', wordCount: 1 }
        ]
      }
    })

    await updateBookProgress(book.id, 2, 50)
    expect(await getBook(book.id)).toMatchObject({ currentChapter: 2, progress: 75 })

    await deleteBook(book.id)
    expect(await getBook(book.id)).toBeUndefined()
    expect(await getChapters(book.id)).toEqual([])
  })
})
