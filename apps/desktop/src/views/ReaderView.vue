<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { AlignJustify, ArrowLeft, ChevronLeft, ChevronRight, Minus, Plus, Sun, Type } from 'lucide-vue-next'
import { formatChapterLabel } from '@novel-library/reader-core'
import { getDesktopBook, getDesktopChapter, listDesktopChapters, saveDesktopProgress, type DesktopBook, type DesktopChapter, type DesktopChapterSummary } from '../services/desktop-library'

const route = useRoute()
const router = useRouter()
const book = ref<DesktopBook>()
const chapter = ref<DesktopChapter>()
const chapters = ref<DesktopChapterSummary[]>([])
const loading = ref(true)
const error = ref('')
const fontSize = ref(18)
const lineHeight = ref(2.05)
const palette = ref<'light' | 'paper' | 'night'>('paper')
let scrollRoot: HTMLElement | null = null
let progressTimer = 0

const bookId = computed(() => String(route.params.bookId))
const chapterNumber = computed(() => Number(route.params.chapterNumber))
const chapterIndex = computed(() => chapters.value.findIndex(item => item.number === chapter.value?.number))
const previous = computed(() => chapters.value[chapterIndex.value - 1])
const next = computed(() => chapters.value[chapterIndex.value + 1])
const paragraphs = computed(() => chapter.value?.content.split(/\n{2,}/).filter(Boolean) ?? [])
const isRichContent = computed(() => chapter.value?.contentFormat === 'html')

function saveSettings() {
  localStorage.setItem('desktop-reader-settings', JSON.stringify({ fontSize: fontSize.value, lineHeight: lineHeight.value, palette: palette.value }))
}

function updateProgress() {
  if (!scrollRoot || !chapter.value) return
  const scrollable = scrollRoot.scrollHeight - scrollRoot.clientHeight
  const progress = scrollable > 0 ? Math.min(100, Math.max(0, scrollRoot.scrollTop / scrollable * 100)) : 0
  window.clearTimeout(progressTimer)
  progressTimer = window.setTimeout(() => saveDesktopProgress(bookId.value, chapter.value!.number, progress), 450)
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [nextBook, nextChapters, nextChapter] = await Promise.all([
      getDesktopBook(bookId.value),
      listDesktopChapters(bookId.value),
      getDesktopChapter(bookId.value, chapterNumber.value)
    ])
    if (!nextBook || !nextChapter) throw new Error('章节不存在或已被删除')
    book.value = nextBook
    chapters.value = nextChapters
    chapter.value = nextChapter
    const restoredProgress = nextBook.currentChapter === nextChapter.number ? nextBook.chapterProgress : 0
    await nextTick()
    window.requestAnimationFrame(() => {
      if (!scrollRoot) return
      const scrollable = scrollRoot.scrollHeight - scrollRoot.clientHeight
      scrollRoot.scrollTo({ top: scrollable * restoredProgress / 100 })
    })
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

function openChapter(number: number) {
  router.push(`/read/${bookId.value}/${number}`)
}

onMounted(() => {
  try {
    const stored = JSON.parse(localStorage.getItem('desktop-reader-settings') || '{}')
    if (stored.fontSize) fontSize.value = stored.fontSize
    if (stored.lineHeight) lineHeight.value = stored.lineHeight
    if (stored.palette) palette.value = stored.palette
  } catch {}
  scrollRoot = document.querySelector('.app-workspace')
  scrollRoot?.addEventListener('scroll', updateProgress, { passive: true })
  load()
})
onBeforeUnmount(() => {
  scrollRoot?.removeEventListener('scroll', updateProgress)
  window.clearTimeout(progressTimer)
})
watch([fontSize, lineHeight, palette], saveSettings)
watch(() => route.params.chapterNumber, load)
</script>

<template>
  <section class="desktop-reader" :class="`desktop-reader--${palette}`" :style="{ '--reader-font-size': `${fontSize}px`, '--reader-line-height': lineHeight }">
    <header class="desktop-reader-toolbar"><button type="button" class="icon-button" title="返回目录" @click="router.push(`/book/${bookId}`)"><ArrowLeft :size="18" /></button><div v-if="book && chapter"><strong>{{ book.title }}</strong><span>{{ formatChapterLabel(chapter) }} · {{ chapterIndex + 1 }} / {{ chapters.length }}</span></div><div class="reader-controls"><label title="字号"><Type :size="16" /><button type="button" @click="fontSize = Math.max(15, fontSize - 1)"><Minus :size="14" /></button><output>{{ fontSize }}</output><button type="button" @click="fontSize = Math.min(26, fontSize + 1)"><Plus :size="14" /></button></label><label title="行距"><AlignJustify :size="16" /><button v-for="value in [1.8, 2.05, 2.3]" :key="value" type="button" :class="{ active: lineHeight === value }" @click="lineHeight = value">{{ value === 1.8 ? '紧' : value === 2.05 ? '中' : '松' }}</button></label><label title="纸张"><Sun :size="16" /><button v-for="item in ([['light','白'],['paper','纸'],['night','夜']] as const)" :key="item[0]" type="button" :class="{ active: palette === item[0] }" @click="palette = item[0]">{{ item[1] }}</button></label></div></header>
    <div v-if="loading" class="view-status">正在加载章节...</div>
    <div v-else-if="error" class="inline-error">{{ error }}</div>
    <main v-else-if="book && chapter" class="desktop-reader-content"><article><p class="reader-volume">{{ chapter.volume || book.title }}</p><h1>{{ formatChapterLabel(chapter) }} {{ chapter.title }}</h1><div v-if="isRichContent" class="epub-content" v-html="chapter.content" /><template v-else><p v-for="(paragraph, index) in paragraphs" :key="index">{{ paragraph }}</p></template></article><footer><button type="button" :disabled="!previous" @click="previous && openChapter(previous.number)"><ChevronLeft :size="18" /><span><small>上一章</small>{{ previous?.title || '已经是第一章' }}</span></button><button type="button" :disabled="!next" @click="next && openChapter(next.number)"><span><small>下一章</small>{{ next?.title || '已经是最后一章' }}</span><ChevronRight :size="18" /></button></footer></main>
  </section>
</template>
