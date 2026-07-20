<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, BookOpen, ChevronRight, Download, Trash2 } from 'lucide-vue-next'
import { formatChapterLabel, type LocalBook, type LocalChapter } from '@novel-library/reader-core'
import { deleteBook, exportBook, getBook, getChapters } from '../services/mobile-library'
import { exportAndShareJson } from '../services/backup-transfer'

const route = useRoute()
const router = useRouter()
const book = ref<LocalBook>()
const chapters = ref<LocalChapter[]>([])
const loading = ref(true)
const error = ref('')
const busy = ref(false)
const bookId = computed(() => String(route.params.bookId))
const groups = computed(() => {
  const output = new Map<string, LocalChapter[]>()
  for (const chapter of chapters.value) {
    const key = chapter.volume || (chapter.kind === 'frontmatter' ? '前置内容' : chapter.kind === 'appendix' ? '附加内容' : '正文')
    output.set(key, [...(output.get(key) ?? []), chapter])
  }
  return [...output.entries()].map(([name, items]) => ({ name, items }))
})

async function load() {
  loading.value = true
  try {
    const [nextBook, nextChapters] = await Promise.all([getBook(bookId.value), getChapters(bookId.value)])
    if (!nextBook) throw new Error('书籍不存在或已删除')
    book.value = nextBook
    chapters.value = nextChapters
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { loading.value = false }
}

async function remove() {
  if (!book.value || !window.confirm(`确定删除《${book.value.title}》及全部章节吗？`)) return
  busy.value = true
  try { await deleteBook(book.value.id); await router.replace('/library') }
  finally { busy.value = false }
}

async function exportSingle() {
  if (!book.value) return
  busy.value = true
  try { await exportAndShareJson(await exportBook(book.value.id), `${book.value.title}-小说书库备份`, `导出《${book.value.title}》`) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { busy.value = false }
}

onMounted(load)
</script>

<template>
  <section class="page detail-page">
    <header class="compact-header"><button class="icon-button" type="button" @click="router.replace('/library')"><ArrowLeft :size="20" /></button><strong>书籍详情</strong><span /></header>
    <div v-if="loading" class="status-card">正在读取书籍…</div>
    <p v-else-if="error" class="error-card">{{ error }}</p>
    <template v-else-if="book">
      <section class="book-hero">
        <div class="hero-cover"><img v-if="book.coverDataUrl" :src="book.coverDataUrl" alt="" /><span v-else>{{ book.title.slice(0, 1) }}</span></div>
        <div><h1>{{ book.title }}</h1><p>{{ book.author || '佚名' }}</p><small>{{ book.sourceFormat.toUpperCase() }} · {{ book.chapterCount }} 项 · {{ book.totalWords.toLocaleString() }} 字</small></div>
      </section>
      <p v-if="book.description" class="book-description">{{ book.description }}</p>
      <div class="detail-actions"><button class="primary-button" type="button" @click="router.push(`/read/${book.id}/${book.currentChapter}`)"><BookOpen :size="18" />{{ book.progress ? '继续阅读' : '开始阅读' }}</button><button class="secondary-button" type="button" :disabled="busy" @click="exportSingle"><Download :size="18" />导出</button><button class="danger-button" type="button" :disabled="busy" @click="remove"><Trash2 :size="18" /></button></div>
      <section class="catalogue">
        <div v-for="group in groups" :key="group.name" class="catalogue-group"><h2>{{ group.name }} <small>{{ group.items.length }}</small></h2><button v-for="chapter in group.items" :key="chapter.id" type="button" @click="router.push(`/read/${book.id}/${chapter.number}`)"><span><small>{{ formatChapterLabel(chapter) }}</small><strong>{{ chapter.title }}</strong></span><ChevronRight :size="17" /></button></div>
      </section>
    </template>
  </section>
</template>
