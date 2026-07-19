<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { AlignJustify, ArrowLeft, ChevronLeft, ChevronRight, Minus, Plus, Sun, Type } from 'lucide-vue-next'
import { formatChapterLabel, getCompactReaderWindow, isNumberedChapter } from '@novel-library/reader-core'
import { getDesktopBook, getDesktopChapter, listDesktopChapters, saveDesktopProgress, type DesktopBook, type DesktopChapter, type DesktopChapterSummary } from '../services/desktop-library'
import { sanitizeReaderHtml } from '../services/sanitize-reader-html'

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
const compactMode = ref(false)
const compactLines = ref(5)
const compactColumns = ref(36)
const compactAnchor = ref(0)
let scrollRoot: HTMLElement | null = null
let progressTimer = 0

const bookId = computed(() => String(route.params.bookId))
const chapterNumber = computed(() => Number(route.params.chapterNumber))
const chapterIndex = computed(() => chapters.value.findIndex(item => item.number === chapter.value?.number))
const previous = computed(() => chapters.value[chapterIndex.value - 1])
const next = computed(() => chapters.value[chapterIndex.value + 1])
const volumeChapters = computed(() => chapter.value && isNumberedChapter(chapter.value)
  ? chapters.value.filter(item => isNumberedChapter(item) && item.volume === chapter.value?.volume)
  : [])
const volumeChapterIndex = computed(() => volumeChapters.value.findIndex(item => item.number === chapter.value?.number))
const paragraphs = computed(() => chapter.value?.content.split(/\n{2,}/).filter(Boolean) ?? [])
const isRichContent = computed(() => chapter.value?.contentFormat === 'html')
const safeRichContent = computed(() => isRichContent.value ? sanitizeReaderHtml(chapter.value?.content || '') : '')
const compactText = computed(() => chapter.value?.contentText || chapter.value?.content.replace(/<[^>]+>/gu, ' ') || '')
const compactWindow = computed(() => getCompactReaderWindow(compactText.value, compactAnchor.value, compactLines.value, compactColumns.value))

function chapterDisplayLabel() {
  if (!chapter.value) return ''
  const label = formatChapterLabel(chapter.value)
  if (label !== chapter.value.title) return label
  const originalLabel = chapter.value.originalLabel.trim()
  if (/^(?:番外|楔子|序章|尾声)/u.test(originalLabel)) return originalLabel
  return ''
}

function chapterPositionLabel() {
  if (!chapter.value) return ''
  if (isNumberedChapter(chapter.value)) {
    const label = chapterDisplayLabel()
    return (label ? label + ' · ' : '') + '本卷 ' + (volumeChapterIndex.value + 1) + ' / ' + volumeChapters.value.length
  }
  const kindLabel = chapter.value.kind === 'volume' ? '分卷' : chapter.value.kind === 'frontmatter' ? '前置内容' : '附加内容'
  return kindLabel + ' · 全书 ' + (chapterIndex.value + 1) + ' / ' + chapters.value.length + ' 项'
}

function chapterHeading() {
  if (!chapter.value) return ''
  if (!isNumberedChapter(chapter.value)) return chapter.value.title
  const label = chapterDisplayLabel()
  return label ? `${label} ${chapter.value.title}` : chapter.value.title
}

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

function saveCompactProgress() {
  if (!chapter.value) return
  const progress = compactText.value.length ? compactAnchor.value / compactText.value.length * 100 : 0
  window.clearTimeout(progressTimer)
  progressTimer = window.setTimeout(() => saveDesktopProgress(bookId.value, chapter.value!.number, progress), 300)
}

function moveCompactWindow(direction: -1 | 1, page = false) {
  if (!compactMode.value || !compactWindow.value.lines.length) return
  const step = page ? compactLines.value : 1
  const target = compactWindow.value.startLine + direction * step
  const allLines = getCompactReaderWindow(compactText.value, Number.MAX_SAFE_INTEGER, 1, compactColumns.value)
  const maxLine = Math.max(0, allLines.totalLines - compactLines.value)
  const targetLine = Math.min(maxLine, Math.max(0, target))
  const line = getCompactReaderWindow(compactText.value, 0, maxLine + 1, compactColumns.value).lines[targetLine]
  if (line) {
    compactAnchor.value = line.start
    saveCompactProgress()
  }
}

function handleReaderKeydown(event: KeyboardEvent) {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
  if (event.ctrlKey && event.key === 'ArrowRight') {
    event.preventDefault()
    if (next.value) openChapter(next.value.number)
    return
  }
  if (event.ctrlKey && event.key === 'ArrowLeft') {
    event.preventDefault()
    if (previous.value) openChapter(previous.value.number)
    return
  }
  if (!compactMode.value) return
  if (event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === ' ') {
    event.preventDefault()
    moveCompactWindow(1, event.key !== 'ArrowDown')
  } else if (event.key === 'ArrowUp' || event.key === 'PageUp') {
    event.preventDefault()
    moveCompactWindow(-1, event.key !== 'ArrowUp')
  } else if (event.key === 'Escape') {
    compactMode.value = false
  }
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
    compactAnchor.value = Math.floor(compactText.value.length * restoredProgress / 100)
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
  window.addEventListener('keydown', handleReaderKeydown)
  load()
})
onBeforeUnmount(() => {
  scrollRoot?.removeEventListener('scroll', updateProgress)
  window.removeEventListener('keydown', handleReaderKeydown)
  window.clearTimeout(progressTimer)
})
watch([fontSize, lineHeight, palette], saveSettings)
watch(() => route.params.chapterNumber, load)
</script>

<template>
  <section class="desktop-reader" :class="[`desktop-reader--${palette}`, { 'desktop-reader--compact': compactMode }]" :style="{ '--reader-font-size': `${fontSize}px`, '--reader-line-height': lineHeight }">
    <header class="desktop-reader-toolbar"><button type="button" class="icon-button" title="返回目录" @click="router.push(`/book/${bookId}`)"><ArrowLeft :size="18" /></button><div v-if="book && chapter"><strong>{{ book.title }}</strong><span>{{ chapterPositionLabel() }}</span></div><div class="reader-controls"><button type="button" :class="{ active: compactMode }" title="紧凑阅读模式" @click="compactMode = !compactMode">{{ compactMode ? '完整' : '紧凑' }}</button><label v-if="compactMode" class="reader-compact-lines" title="显示行数"><button v-for="value in [4, 5, 8]" :key="value" type="button" :class="{ active: compactLines === value }" @click="compactLines = value">{{ value }} 行</button></label><label class="reader-font-size" title="字号"><Type :size="16" /><button type="button" @click="fontSize = Math.max(15, fontSize - 1)"><Minus :size="14" /></button><output>{{ fontSize }}</output><button type="button" @click="fontSize = Math.min(26, fontSize + 1)"><Plus :size="14" /></button></label><label class="reader-line-height" title="行距"><AlignJustify :size="16" /><button v-for="value in [1.8, 2.05, 2.3]" :key="value" type="button" :class="{ active: lineHeight === value }" @click="lineHeight = value">{{ value === 1.8 ? '紧' : value === 2.05 ? '中' : '松' }}</button></label><label class="reader-palette" title="纸张"><Sun :size="16" /><button v-for="item in ([['light','白'],['paper','纸'],['night','夜']] as const)" :key="item[0]" type="button" :class="{ active: palette === item[0] }" @click="palette = item[0]">{{ item[1] }}</button></label></div></header>
    <div v-if="loading" class="view-status" role="status">正在加载章节...</div>
    <div v-else-if="error" class="inline-error" role="alert">{{ error }}</div>
    <main v-else-if="book && chapter" :class="compactMode ? 'desktop-reader-compact-content' : 'desktop-reader-content'"><article><p v-if="chapter.kind !== 'volume'" class="reader-volume">{{ chapter.volume || book.title }}</p><h1>{{ chapterHeading() }}</h1><section v-if="compactMode" class="compact-reader-window"><p v-for="line in compactWindow.lines" :key="line.start">{{ line.text || ' ' }}</p><small>{{ compactWindow.startLine + 1 }} - {{ compactWindow.endLine }} / {{ compactWindow.totalLines }} 行</small></section><template v-else><div v-if="isRichContent" class="epub-content" v-html="safeRichContent" /><template v-else><p v-for="(paragraph, index) in paragraphs" :key="index">{{ paragraph }}</p></template></template></article><footer><button type="button" :disabled="!previous" @click="previous && openChapter(previous.number)"><ChevronLeft :size="18" /><span><small>上一章</small>{{ previous?.title || '已经是第一章' }}</span></button><button type="button" :disabled="!next" @click="next && openChapter(next.number)"><span><small>下一章</small>{{ next?.title || '已经是最后一章' }}</span><ChevronRight :size="18" /></button></footer></main>
  </section>
</template>
