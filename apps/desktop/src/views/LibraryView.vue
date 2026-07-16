<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { BookOpen, FilePlus2, RefreshCw, Trash2 } from 'lucide-vue-next'
import { defaultParseOptions, defaultTheme } from '@novel-library/reader-core'
import { deleteDesktopBook, listDesktopBooks, saveDesktopBook, type DesktopBook } from '../services/desktop-library'
import { parseNovelFile } from '../services/parse-novel-file'
import { parseEpubFile } from '../services/parse-epub-file'

const router = useRouter()
const books = ref<DesktopBook[]>([])
const loading = ref(true)
const error = ref('')
const importing = ref(false)
const importProgress = ref(0)
const importMessage = ref('')
const fileInput = ref<HTMLInputElement>()

async function loadBooks() {
  loading.value = true
  error.value = ''
  try {
    books.value = await listDesktopBooks()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

async function importFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  importing.value = true
  importProgress.value = 0
  importMessage.value = '正在读取文件'
  error.value = ''
  try {
    const options = { ...defaultParseOptions }
    const parse = file.name.toLowerCase().endsWith('.epub')
      ? (selectedFile: File) => parseEpubFile(selectedFile, (progress, message) => {
          importProgress.value = progress
          importMessage.value = message
        })
      : (selectedFile: File) => parseNovelFile(selectedFile, options, (progress, message) => {
          importProgress.value = progress
          importMessage.value = message
        })
    const result = await parse(file)
    importMessage.value = '正在写入本地数据库'
    const book = await saveDesktopBook({ result, options, theme: { ...defaultTheme } })
    await loadBooks()
    await router.push(`/book/${book.id}`)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    importing.value = false
    input.value = ''
  }
}

async function removeBook(book: DesktopBook) {
  if (!window.confirm(`确认删除《${book.title}》及全部章节吗？`)) return
  await deleteDesktopBook(book.id)
  await loadBooks()
}

onMounted(loadBooks)
</script>

<template>
  <section class="workspace-view">
    <header class="workspace-header">
      <div>
        <p>LOCAL LIBRARY</p>
        <h1>我的书架</h1>
      </div>
      <div class="header-actions">
        <button type="button" class="icon-button" title="刷新书架" :disabled="loading" @click="loadBooks"><RefreshCw :size="18" /></button>
        <button type="button" class="primary-command" :disabled="importing" @click="fileInput?.click()"><FilePlus2 :size="18" />{{ importing ? '正在导入' : '导入书籍' }}</button>
        <input ref="fileInput" type="file" accept=".txt,.epub,text/plain,application/epub+zip" hidden @change="importFile" />
      </div>
    </header>

    <div v-if="importing" class="import-status"><div><span :style="{ width: `${importProgress}%` }" /></div><strong>{{ importMessage }}</strong><small>{{ importProgress }}%</small></div>
    <div v-if="error" class="inline-error">{{ error }}</div>
    <div v-if="loading" class="view-status">正在读取本地书架...</div>
    <div v-else-if="!books.length && !importing" class="empty-library">
      <BookOpen :size="34" />
      <h2>书架为空</h2>
      <p>导入 TXT 或 EPUB 后，书籍和阅读进度将保存在本机。</p>
    </div>
    <div v-else class="book-list">
      <article v-for="book in books" :key="book.id">
        <button type="button" class="book-seal" @click="router.push(`/book/${book.id}`)"><img v-if="book.coverDataUrl" :src="book.coverDataUrl" alt="" /><template v-else>{{ book.title.slice(0, 1) }}</template></button>
        <button type="button" class="book-copy" @click="router.push(`/book/${book.id}`)"><strong>{{ book.title }}</strong><span>{{ book.author || '佚名' }}</span></button>
        <span><b class="format-badge">{{ book.sourceFormat.toUpperCase() }}</b> {{ book.chapterCount }} 章</span>
        <span>{{ book.totalWords.toLocaleString() }} 字</span>
        <div class="book-progress" :title="`阅读进度 ${book.progress.toFixed(1)}%`"><span :style="{ width: `${book.progress}%` }" /></div>
        <div class="row-actions"><button type="button" class="icon-button" title="继续阅读" @click="router.push(`/read/${book.id}/${book.currentChapter}`)"><BookOpen :size="17" /></button><button type="button" class="icon-button danger-icon" title="删除书籍" @click="removeBook(book)"><Trash2 :size="16" /></button></div>
      </article>
    </div>
  </section>
</template>
