<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { BookOpen, FilePlus2, RefreshCw } from 'lucide-vue-next'
import { defaultParseOptions, defaultTheme } from '@novel-library/reader-core'
import { getCachedDesktopBooks, listDesktopBooks, readDesktopExternalFile, saveDesktopBook, type DesktopBookSummary } from '../services/desktop-library'
import BookCard from '../components/library/BookCard.vue'
import PageHeader from '../components/ui/PageHeader.vue'
import { parseNovelFile } from '../services/parse-novel-file'
import { parseEpubFile } from '../services/parse-epub-file'

const router = useRouter()
const cachedBooks = getCachedDesktopBooks()
const books = ref<DesktopBookSummary[]>(cachedBooks || [])
const loading = ref(cachedBooks === undefined)
const refreshing = ref(false)
const error = ref('')
const importing = ref(false)
const importProgress = ref(0)
const importMessage = ref('')
const fileInput = ref<HTMLInputElement>()

async function loadBooks() {
  const hasVisibleBooks = books.value.length > 0
  loading.value = !hasVisibleBooks
  refreshing.value = hasVisibleBooks
  error.value = ''
  try {
    books.value = await listDesktopBooks({ forceRefresh: true })
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

async function importFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    await importBook(file)
  } finally {
    input.value = ''
  }
}

async function importBook(file: File, existingId?: string) {
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
    const book = await saveDesktopBook({ result, options, theme: { ...defaultTheme }, existingId })
    await loadBooks()
    await router.push(`/book/${book.id}`)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    importing.value = false
  }
}

async function importExternalFile(event: Event) {
  const detail = (event as CustomEvent<{ path: string; existingId?: string }>).detail
  if (!detail?.path) return
  try {
    const external = await readDesktopExternalFile(detail.path)
    await importBook(new File([new Uint8Array(external.bytes)], external.name), detail.existingId)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

onMounted(() => {
  void loadBooks()
  window.addEventListener('novel-library-import', importExternalFile)
})
onBeforeUnmount(() => window.removeEventListener('novel-library-import', importExternalFile))
</script>

<template>
  <section class="workspace-view">
    <PageHeader title="我的书架">
      <template #actions>
        <button type="button" class="icon-button" title="刷新书架" :disabled="loading || refreshing" @click="loadBooks"><RefreshCw :size="18" :class="{ spinning: refreshing }" /></button>
        <button type="button" class="primary-command" :disabled="importing" @click="fileInput?.click()"><FilePlus2 :size="18" />{{ importing ? '正在导入' : '导入书籍' }}</button>
        <input ref="fileInput" type="file" accept=".txt,.epub,text/plain,application/epub+zip" hidden @change="importFile" />
      </template>
    </PageHeader>

    <div v-if="importing" class="import-status" role="status"><div><span :style="{ width: `${importProgress}%` }" /></div><strong>{{ importMessage }}</strong><small>{{ importProgress }}%</small></div>
    <div v-if="error" class="inline-error" role="alert">{{ error }}</div>
    <div v-if="loading" class="view-status" role="status">正在读取本地书架...</div>
    <div v-else-if="!books.length && !importing" class="empty-library">
      <BookOpen :size="34" />
      <h2>书架为空</h2>
      <button type="button" class="primary-command" @click="fileInput?.click()"><FilePlus2 :size="17" />导入第一本书</button>
    </div>
    <div v-else class="book-grid">
      <BookCard v-for="book in books" :key="book.id" :book="book" @open="router.push(`/book/${book.id}`)" @read="router.push(`/read/${book.id}/${book.currentChapter}`)" />
    </div>
  </section>
</template>
