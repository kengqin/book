<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { BookOpen, FilePlus2, FileText, RefreshCw } from 'lucide-vue-next'
import { defaultParseOptions, defaultTheme } from '@novel-library/reader-core'
import { deleteDesktopBook, getCachedDesktopBooks, listDesktopBooks, readDesktopExternalFile, saveDesktopBook, type DesktopBookSummary } from '../services/desktop-library'
import BookCard from '../components/library/BookCard.vue'
import PageHeader from '../components/ui/PageHeader.vue'
import UiConfirmDialog from '../components/ui/UiConfirmDialog.vue'
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
const importDialogOpen = ref(false)
const pendingImportFiles = ref<File[]>([])
const pendingDeleteBook = ref<DesktopBookSummary>()
const deleting = ref(false)

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

function openImportDialog() {
  if (importing.value) return
  error.value = ''
  pendingImportFiles.value = []
  if (fileInput.value) fileInput.value.value = ''
  importDialogOpen.value = true
}

function closeImportDialog() {
  importDialogOpen.value = false
  pendingImportFiles.value = []
  if (fileInput.value) fileInput.value.value = ''
}

function chooseImportFile() {
  if (fileInput.value) fileInput.value.value = ''
  fileInput.value?.click()
}

function selectImportFile(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files || [])
  if (!files.length) return
  pendingImportFiles.value = files
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function confirmImport() {
  const files = [...pendingImportFiles.value]
  if (!files.length) return
  importDialogOpen.value = false
  pendingImportFiles.value = []
  if (fileInput.value) fileInput.value.value = ''
  void importBooks(files)
}

function importSelectionTitle() {
  if (!pendingImportFiles.value.length) return '尚未选择文件'
  if (pendingImportFiles.value.length === 1) return pendingImportFiles.value[0].name
  return `已选择 ${pendingImportFiles.value.length} 个文件`
}

function importSelectionDetail() {
  const files = pendingImportFiles.value
  if (!files.length) return '支持 TXT、EPUB 格式'
  const epubCount = files.filter(file => file.name.toLowerCase().endsWith('.epub')).length
  const txtCount = files.length - epubCount
  const formats = [
    txtCount ? `TXT ${txtCount}` : '',
    epubCount ? `EPUB ${epubCount}` : ''
  ].filter(Boolean).join(' · ')
  const totalBytes = files.reduce((total, file) => total + file.size, 0)
  return `${formatFileSize(totalBytes)} · ${formats}`
}

async function parseAndSaveBook(file: File, existingId: string | undefined, onProgress: (progress: number, message: string) => void) {
  const options = { ...defaultParseOptions }
  const parse = file.name.toLowerCase().endsWith('.epub')
    ? (selectedFile: File) => parseEpubFile(selectedFile, onProgress)
    : (selectedFile: File) => parseNovelFile(selectedFile, options, onProgress)
  const result = await parse(file)
  return saveDesktopBook({ result, options, theme: { ...defaultTheme }, existingId })
}

async function importBooks(files: File[], existingId?: string) {
  if (!files.length) return
  importing.value = true
  importProgress.value = 0
  importMessage.value = '正在读取文件'
  error.value = ''
  const importedIds: string[] = []
  const failures: Array<{ file: File, message: string }> = []
  try {
    for (const [index, file] of files.entries()) {
      const prefix = files.length > 1 ? `${index + 1}/${files.length} · ${file.name} · ` : ''
      try {
        const book = await parseAndSaveBook(
          file,
          files.length === 1 ? existingId : undefined,
          (progress, message) => {
            importProgress.value = Math.round((index + progress / 100) / files.length * 100)
            importMessage.value = `${prefix}${message}`
          }
        )
        importedIds.push(book.id)
      } catch (cause) {
        failures.push({ file, message: cause instanceof Error ? cause.message : String(cause) })
      }
      importProgress.value = Math.round((index + 1) / files.length * 100)
    }
    importMessage.value = '正在刷新书架'
    await loadBooks()
    if (failures.length) {
      const details = failures.slice(0, 3).map(item => `${item.file.name}：${item.message}`).join('；')
      const remaining = failures.length > 3 ? `；另有 ${failures.length - 3} 个文件失败` : ''
      error.value = `已导入 ${importedIds.length}/${files.length} 本书。${details}${remaining}`
    } else if (files.length === 1 && importedIds[0]) {
      await router.push(`/book/${importedIds[0]}`)
    }
  } finally {
    importing.value = false
  }
}

async function importExternalFile(event: Event) {
  const detail = (event as CustomEvent<{ path: string; existingId?: string }>).detail
  if (!detail?.path) return
  closeImportDialog()
  try {
    const external = await readDesktopExternalFile(detail.path)
    await importBooks([new File([new Uint8Array(external.bytes)], external.name)], detail.existingId)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

async function removeBook() {
  const book = pendingDeleteBook.value
  if (!book) return
  deleting.value = true
  error.value = ''
  try {
    await deleteDesktopBook(book.id)
    books.value = books.value.filter(item => item.id !== book.id)
    pendingDeleteBook.value = undefined
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    deleting.value = false
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
        <button type="button" class="primary-command" :disabled="importing" @click="openImportDialog"><FilePlus2 :size="18" />{{ importing ? '正在导入' : '导入书籍' }}</button>
        <input ref="fileInput" type="file" accept=".txt,.epub,text/plain,application/epub+zip" multiple hidden @change="selectImportFile" />
      </template>
    </PageHeader>

    <div v-if="importing" class="import-status" role="status"><div><span :style="{ width: `${importProgress}%` }" /></div><strong>{{ importMessage }}</strong><small>{{ importProgress }}%</small></div>
    <div v-if="error" class="inline-error" role="alert">{{ error }}</div>
    <div v-if="loading" class="view-status" role="status">正在读取本地书架...</div>
    <div v-else-if="!books.length && !importing" class="empty-library">
      <BookOpen :size="34" />
      <h2>书架为空</h2>
      <button type="button" class="primary-command" @click="openImportDialog"><FilePlus2 :size="17" />导入第一本书</button>
    </div>
    <div v-else class="book-grid">
      <BookCard v-for="book in books" :key="book.id" :book="book" @open="router.push(`/book/${book.id}`)" @read="router.push(`/read/${book.id}/${book.currentChapter}`)" @request-delete="pendingDeleteBook = book" />
    </div>
    <UiConfirmDialog
      :open="importDialogOpen"
      title="导入书籍"
      description="选择文件后不会立即解析；确认导入后弹框会关闭，并在书架页继续显示解析和写入进度。"
      :confirm-label="pendingImportFiles.length > 1 ? `确认导入（${pendingImportFiles.length}）` : '确认导入'"
      cancel-label="取消"
      :confirm-disabled="!pendingImportFiles.length"
      @close="closeImportDialog"
      @confirm="confirmImport"
    >
      <div class="book-import-file" :class="{ selected: pendingImportFiles.length }">
        <span class="book-import-file-icon"><FileText :size="22" /></span>
        <div>
          <strong :title="pendingImportFiles.map(file => file.name).join('\n')">{{ importSelectionTitle() }}</strong>
          <small>{{ importSelectionDetail() }}</small>
        </div>
        <button type="button" class="secondary-command" @click="chooseImportFile">{{ pendingImportFiles.length ? '重新选择' : '选择文件' }}</button>
      </div>
    </UiConfirmDialog>
    <UiConfirmDialog
      :open="Boolean(pendingDeleteBook)"
      :busy="deleting"
      danger
      title="删除这本书？"
      :description="`《${pendingDeleteBook?.title || ''}》及其全部章节、阅读进度将从本机删除，此操作无法撤销。`"
      confirm-label="删除书籍"
      @close="pendingDeleteBook = undefined"
      @confirm="removeBook"
    />
  </section>
</template>
