<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, BookOpen, ChevronRight, Trash2 } from 'lucide-vue-next'
import { formatChapterLabel, isNumberedChapter } from '@novel-library/reader-core'
import { deleteDesktopBook, getDesktopBook, listDesktopChapters, type DesktopBook, type DesktopChapterSummary } from '../services/desktop-library'

const route = useRoute()
const router = useRouter()
const book = ref<DesktopBook>()
const chapters = ref<DesktopChapterSummary[]>([])
const loading = ref(true)
const error = ref('')
const bookId = computed(() => String(route.params.bookId))
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
  if (!book.value || !window.confirm(`确认删除《${book.value.title}》及全部章节吗？`)) return
  await deleteDesktopBook(book.value.id)
  await router.push('/library')
}

onMounted(load)
</script>

<template>
  <section class="workspace-view book-detail-view">
    <button type="button" class="text-command" @click="router.push('/library')"><ArrowLeft :size="16" />返回书架</button>
    <div v-if="loading" class="view-status">正在读取书籍...</div>
    <div v-else-if="error" class="inline-error">{{ error }}</div>
    <template v-else-if="book">
      <header class="book-detail-header" :style="{ '--book-accent': book.theme.accent, '--book-bg': book.theme.background, '--book-text': book.theme.text }">
        <div class="book-detail-seal" :class="{ 'book-detail-seal--image': book.coverDataUrl }"><img v-if="book.coverDataUrl" :src="book.coverDataUrl" alt="" /><template v-else>{{ book.title.slice(0, 1) }}</template></div>
        <div><p>{{ book.sourceFormat.toUpperCase() }} · {{ numberedChapterCount }} CHAPTERS · {{ book.totalWords.toLocaleString() }} WORDS</p><h1>{{ book.title }}</h1><span>{{ book.author || '佚名' }}</span><blockquote>{{ book.description || '暂无简介' }}</blockquote><div class="header-actions"><button type="button" class="primary-command" @click="router.push(`/read/${book.id}/${book.currentChapter}`)"><BookOpen :size="17" />{{ book.progress ? '继续阅读' : '开始阅读' }}</button><button type="button" class="secondary-command danger-command" @click="removeBook"><Trash2 :size="16" />删除</button></div></div>
      </header>

      <section class="chapter-catalogue">
        <header><p>TABLE OF CONTENTS</p><h2>章节目录</h2></header>
        <section v-for="group in chapterGroups" :key="group.name" class="chapter-group"><h3>{{ group.name }} <span v-if="group.chapterCount">{{ group.chapterCount }} 章</span><span v-if="group.extraCount">{{ group.chapterCount ? ' · ' : '' }}{{ group.extraCount }} 项</span></h3><div><button v-for="chapter in group.items" :key="chapter.id" type="button" @click="router.push(`/read/${book.id}/${chapter.number}`)"><small>{{ isNumberedChapter(chapter) ? formatChapterLabel(chapter) : chapter.kind === 'volume' ? '分卷' : chapter.kind === 'frontmatter' ? '前置' : '附加' }}</small><span>{{ chapter.title }}</span><ChevronRight :size="15" /></button></div></section>
      </section>
    </template>
  </section>
</template>
