<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, BookOpen, ChevronRight, Trash2 } from 'lucide-vue-next'
import { formatChapterLabel, isNumberedChapter } from '@novel-library/reader-core'
import { deleteDesktopBook, getDesktopBook, listDesktopChapters, type DesktopBook, type DesktopChapterSummary } from '../services/desktop-library'
import { sanitizeReaderHtml } from '../services/sanitize-reader-html'
import UiConfirmDialog from '../components/ui/UiConfirmDialog.vue'

const route = useRoute()
const router = useRouter()
const book = ref<DesktopBook>()
const chapters = ref<DesktopChapterSummary[]>([])
const loading = ref(true)
const error = ref('')
const deleteDialogOpen = ref(false)
const deleting = ref(false)
const bookId = computed(() => String(route.params.bookId))
const safeDescription = computed(() => sanitizeReaderHtml(book.value?.description || '', { preserveStyles: true }))
const chapterGroups = computed(() => {
  const groups = new Map<string, DesktopChapterSummary[]>()
  for (const chapter of chapters.value) {
    const name = chapter.volume || '正文'
    const items = groups.get(name) ?? []
    items.push(chapter)
    groups.set(name, items)
  }
  return [...groups.entries()].map(([name, items]) => ({
    name,
    items,
    chapterCount: items.filter(isNumberedChapter).length,
    extraCount: items.filter(chapter => !isNumberedChapter(chapter)).length
  }))
})
const numberedChapterCount = computed(() => chapters.value.filter(isNumberedChapter).length)

function chapterMetaLabel(chapter: DesktopChapterSummary) {
  if (chapter.kind === 'chapter') {
    const label = formatChapterLabel(chapter)
    if (label !== chapter.title) return label
    const originalLabel = chapter.originalLabel.trim()
    if (/^(?:番外|楔子|序章|尾声)/u.test(originalLabel)) return originalLabel
    return ''
  }
  return chapter.kind === 'volume' ? '分卷' : chapter.kind === 'frontmatter' ? '前置' : '附加'
}

async function load() {
  loading.value = true
  try {
    const [nextBook, nextChapters] = await Promise.all([getDesktopBook(bookId.value), listDesktopChapters(bookId.value)])
    if (!nextBook) throw new Error('书籍不存在或已被删除')
    book.value = nextBook
    chapters.value = nextChapters
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

async function removeBook() {
  if (!book.value) return
  deleting.value = true
  try {
    await deleteDesktopBook(book.value.id)
    deleteDialogOpen.value = false
    await router.push('/library')
  } finally {
    deleting.value = false
  }
}

onMounted(load)
</script>

<template>
  <section class="workspace-view book-detail-view">
    <button type="button" class="text-command" @click="router.push('/library')"><ArrowLeft :size="16" />返回书架</button>
    <div v-if="loading" class="view-status" role="status">正在读取书籍...</div>
    <div v-else-if="error" class="inline-error" role="alert">{{ error }}</div>
    <template v-else-if="book">
      <header class="book-detail-header" :style="{ '--book-accent': book.theme.accent }">
        <div class="book-detail-seal" :class="{ 'book-detail-seal--image': book.coverDataUrl }"><img v-if="book.coverDataUrl" :src="book.coverDataUrl" alt="" /><template v-else>{{ book.title.slice(0, 1) }}</template></div>
        <div class="book-detail-copy"><h1>{{ book.title }}</h1><span>{{ book.author || '佚名' }}</span><blockquote v-if="book.description" v-html="safeDescription" /><blockquote v-else>暂无简介</blockquote></div>
        <aside class="book-detail-side"><div class="book-detail-stats"><span>{{ book.sourceFormat.toUpperCase() }}</span><span>{{ numberedChapterCount }} 章</span><span>{{ book.totalWords.toLocaleString() }} 字</span></div><div class="book-action-panel"><dl><div><dt>阅读进度</dt><dd>{{ book.progress.toFixed(0) }}%</dd></div><div><dt>当前章节</dt><dd>第 {{ book.currentChapter }} 章</dd></div></dl><div class="book-action-buttons"><button type="button" class="primary-command" @click="router.push(`/read/${book.id}/${book.currentChapter}`)"><BookOpen :size="17" />{{ book.progress ? '继续阅读' : '开始阅读' }}</button><button type="button" class="book-delete-button" @click="deleteDialogOpen = true"><Trash2 :size="15" />删除书籍</button></div></div></aside>
      </header>

      <section class="chapter-catalogue">
        <header><h2>章节目录</h2></header>
        <section v-for="group in chapterGroups" :key="group.name" class="chapter-group"><h3>{{ group.name }} <span v-if="group.chapterCount">{{ group.chapterCount }} 章</span><span v-if="group.extraCount">{{ group.chapterCount ? ' · ' : '' }}{{ group.extraCount }} 项</span></h3><div><button v-for="chapter in group.items" :key="chapter.id" type="button" :class="{ 'chapter-entry--plain': !chapterMetaLabel(chapter) }" @click="router.push(`/read/${book.id}/${chapter.number}`)"><small v-if="chapterMetaLabel(chapter)">{{ chapterMetaLabel(chapter) }}</small><span>{{ chapter.title }}</span><ChevronRight :size="15" /></button></div></section>
      </section>
    </template>
    <UiConfirmDialog :open="deleteDialogOpen" :busy="deleting" danger title="删除这本书？" :description="`《${book?.title || ''}》及其全部章节、阅读进度将从本机删除，此操作无法撤销。`" confirm-label="删除书籍" @close="deleteDialogOpen = false" @confirm="removeBook" />
  </section>
</template>
