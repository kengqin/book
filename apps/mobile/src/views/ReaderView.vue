<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { App as NativeApp } from '@capacitor/app'
import type { PluginListenerHandle } from '@capacitor/core'
import { AlignJustify, ArrowLeft, BookOpen, ChevronLeft, ChevronRight, List, Minus, Moon, Plus, Sun, Type } from 'lucide-vue-next'
import { formatChapterLabel, type LocalBook, type LocalChapter } from '@novel-library/reader-core'
import { getBook, getChapter, getChapters, updateBookProgress } from '../services/mobile-library'
import { sanitizeReaderHtml } from '../services/sanitize-reader-html'

const route = useRoute()
const router = useRouter()
const book = ref<LocalBook>()
const chapter = ref<LocalChapter>()
const chapters = ref<LocalChapter[]>([])
const loading = ref(true)
const error = ref('')
const controlsVisible = ref(true)
const catalogueVisible = ref(false)
const settingsVisible = ref(false)
const fontSize = ref(19)
const lineHeight = ref(2)
const palette = ref<'paper' | 'light' | 'night'>('paper')
const readerRoot = ref<HTMLElement>()
const bookId = computed(() => String(route.params.bookId))
const chapterNumber = computed(() => Number(route.params.chapterNumber))
const chapterIndex = computed(() => chapters.value.findIndex(item => item.number === chapter.value?.number))
const previous = computed(() => chapters.value[chapterIndex.value - 1])
const next = computed(() => chapters.value[chapterIndex.value + 1])
const paragraphs = computed(() => chapter.value?.content.split(/\n{2,}/u).filter(Boolean) ?? [])
const richContent = computed(() => chapter.value?.contentFormat === 'html' ? sanitizeReaderHtml(chapter.value.content) : '')
let saveTimer = 0
let stateListener: PluginListenerHandle | undefined
let touchStartX = 0
let touchStartY = 0

function readerSettings() {
  return { fontSize: fontSize.value, lineHeight: lineHeight.value, palette: palette.value }
}

function persistSettings() {
  localStorage.setItem('mobile-reader-settings', JSON.stringify(readerSettings()))
}

function progress() {
  const root = readerRoot.value
  if (!root) return 0
  const scrollable = root.scrollHeight - root.clientHeight
  return scrollable > 0 ? Math.min(100, Math.max(0, root.scrollTop / scrollable * 100)) : 100
}

function saveProgress(immediate = false) {
  if (!chapter.value) return
  window.clearTimeout(saveTimer)
  const run = () => updateBookProgress(bookId.value, chapter.value!.number, progress())
  if (immediate) void run()
  else saveTimer = window.setTimeout(() => void run(), 400)
}

async function load() {
  saveProgress(true)
  loading.value = true
  error.value = ''
  try {
    const [nextBook, nextChapter, nextChapters] = await Promise.all([getBook(bookId.value), getChapter(bookId.value, chapterNumber.value), getChapters(bookId.value)])
    if (!nextBook || !nextChapter) throw new Error('章节不存在或已经删除')
    book.value = nextBook
    chapter.value = nextChapter
    chapters.value = nextChapters
    await nextTick()
    const restored = nextBook.currentChapter === nextChapter.number ? nextBook.chapterProgress : 0
    requestAnimationFrame(() => {
      const root = readerRoot.value
      if (root) root.scrollTop = (root.scrollHeight - root.clientHeight) * restored / 100
    })
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { loading.value = false }
}

async function openChapter(number: number) {
  await router.replace(`/read/${bookId.value}/${number}`)
  catalogueVisible.value = false
}

function touchStart(event: TouchEvent) {
  touchStartX = event.changedTouches[0]?.screenX ?? 0
  touchStartY = event.changedTouches[0]?.screenY ?? 0
}

function touchEnd(event: TouchEvent) {
  const x = (event.changedTouches[0]?.screenX ?? 0) - touchStartX
  const y = (event.changedTouches[0]?.screenY ?? 0) - touchStartY
  if (Math.abs(x) < 80 || Math.abs(x) < Math.abs(y) * 1.4) return
  if (x < 0 && next.value) void openChapter(next.value.number)
  if (x > 0 && previous.value) void openChapter(previous.value.number)
}

onMounted(async () => {
  try {
    const stored = JSON.parse(localStorage.getItem('mobile-reader-settings') || '{}') as Partial<ReturnType<typeof readerSettings>>
    if (stored.fontSize) fontSize.value = stored.fontSize
    if (stored.lineHeight) lineHeight.value = stored.lineHeight
    if (stored.palette) palette.value = stored.palette
  } catch { /* Ignore damaged local preferences. */ }
  stateListener = await NativeApp.addListener('appStateChange', ({ isActive }) => { if (!isActive) saveProgress(true) })
  await load()
})

onBeforeUnmount(() => { saveProgress(true); window.clearTimeout(saveTimer); void stateListener?.remove() })
watch(() => route.params.chapterNumber, load)
watch([fontSize, lineHeight, palette], persistSettings)
</script>

<template>
  <section class="reader-page" :class="`reader-page--${palette}`" :style="{ '--reader-size': `${fontSize}px`, '--reader-line': lineHeight }">
    <header v-show="controlsVisible" class="reader-toolbar"><button type="button" @click="router.replace('/library')"><ArrowLeft :size="21" /></button><div><strong>{{ book?.title }}</strong><small>{{ chapter ? `${formatChapterLabel(chapter)} · ${chapter.title}` : '' }}</small></div><button type="button" @click="catalogueVisible = true"><List :size="21" /></button></header>
    <main ref="readerRoot" class="reader-scroll" @scroll.passive="saveProgress()" @touchstart.passive="touchStart" @touchend.passive="touchEnd" @click="controlsVisible = !controlsVisible">
      <div v-if="loading" class="reader-status">正在打开章节…</div>
      <div v-else-if="error" class="reader-status reader-error">{{ error }}</div>
      <article v-else-if="chapter"><p class="reader-volume">{{ chapter.volume || book?.title }}</p><h1>{{ chapter.title }}</h1><div v-if="chapter.contentFormat === 'html'" class="epub-content" v-html="richContent" /><template v-else><p v-for="(paragraph, index) in paragraphs" :key="index">{{ paragraph }}</p></template><footer><button type="button" :disabled="!previous" @click.stop="previous && openChapter(previous.number)"><ChevronLeft :size="19" />上一章</button><button type="button" :disabled="!next" @click.stop="next && openChapter(next.number)">下一章<ChevronRight :size="19" /></button></footer></article>
    </main>
    <footer v-show="controlsVisible" class="reader-bottom"><button type="button" @click="catalogueVisible = true"><BookOpen :size="19" />目录</button><button type="button" @click="settingsVisible = true"><Type :size="19" />阅读设置</button></footer>

    <div v-if="catalogueVisible || settingsVisible" class="sheet-backdrop" @click="catalogueVisible = false; settingsVisible = false" />
    <aside v-if="catalogueVisible" class="bottom-sheet catalogue-sheet"><header><strong>目录</strong><button type="button" @click="catalogueVisible = false">完成</button></header><div><button v-for="item in chapters" :key="item.id" type="button" :class="{ active: item.number === chapter?.number }" @click="openChapter(item.number)"><small>{{ formatChapterLabel(item) }}</small><span>{{ item.title }}</span></button></div></aside>
    <aside v-if="settingsVisible" class="bottom-sheet settings-sheet"><header><strong>阅读设置</strong><button type="button" @click="settingsVisible = false">完成</button></header><div class="setting-row"><Type :size="19" /><button type="button" @click="fontSize = Math.max(15, fontSize - 1)"><Minus :size="17" /></button><output>{{ fontSize }}</output><button type="button" @click="fontSize = Math.min(30, fontSize + 1)"><Plus :size="17" /></button></div><div class="setting-row"><AlignJustify :size="19" /><button v-for="value in [1.7, 2, 2.3]" :key="value" type="button" :class="{ active: lineHeight === value }" @click="lineHeight = value">{{ value === 1.7 ? '紧' : value === 2 ? '中' : '松' }}</button></div><div class="palette-row"><button type="button" :class="{ active: palette === 'light' }" @click="palette = 'light'"><Sun :size="18" />明亮</button><button type="button" :class="{ active: palette === 'paper' }" @click="palette = 'paper'"><BookOpen :size="18" />纸张</button><button type="button" :class="{ active: palette === 'night' }" @click="palette = 'night'"><Moon :size="18" />夜间</button></div></aside>
  </section>
</template>
