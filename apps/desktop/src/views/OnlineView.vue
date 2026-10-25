<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { ArrowLeft, ArrowUpRight, BookOpen, ChevronLeft, ChevronRight, Download, Globe2, MoreHorizontal, Pause, Pencil, Play, RefreshCw, Search, Trash2, X } from 'lucide-vue-next'
import PageHeader from '../components/ui/PageHeader.vue'
import UiConfirmDialog from '../components/ui/UiConfirmDialog.vue'
import UiSelect from '../components/ui/UiSelect.vue'
import UiDialog from '../components/ui/UiDialog.vue'
import OnlineSearchEmpty from '../components/OnlineSearchEmpty.vue'
import OnlineSearchLoading from '../components/OnlineSearchLoading.vue'
import { showGlobalError, showGlobalMessage } from '../services/global-message'
import { deleteDesktopBook, getDesktopBook } from '../services/desktop-library'
import { httpUrl } from '../services/online-parser'
import { activeDiscovery, beginOnlineDiscovery } from '../services/online-discovery'
import { onlineSearchSession } from '../services/online-search-state'
import { onlineVerifications, showOnlineVerification } from '../services/online-browser'
import { isNovelSearchHit, loadSearchBatch, searchBrowserUrl, searchEngineOptions, type SearchEngine } from '../services/online-search'
import { openWebPage } from '../services/web-browser'
import { cancelBrowserSearch, checkOnlineUpdates, downloadOnlineBook, onlineBooks, onlineSearchSettings, pauseOnlineBook, refreshOnlineBooks, removeOnlineTask, restoreOnlineTask, searchOnlineBooks, toggleOnlineUpdates, type OnlineBook } from '../services/online-library'

const route = useRoute()
const router = useRouter()
const query = toRef(onlineSearchSession, 'query')
const resultPages = toRef(onlineSearchSession, 'pages')
const hits = computed(() => resultPages.value[onlineSearchSession.page - 1] || [])
const hasNextPage = computed(() => onlineSearchSession.page < resultPages.value.length || Boolean(onlineSearchSession.cursor) || Boolean(onlineSearchSession.pendingHits.length))
const pageNumbers = computed(() => {
  const last = resultPages.value.length + (onlineSearchSession.cursor || onlineSearchSession.pendingHits.length ? 1 : 0)
  const pages = new Set([1, last])
  for (let n = Math.max(1, onlineSearchSession.page - 2); n <= Math.min(last, onlineSearchSession.page + 2); n++) pages.add(n)
  const sorted = [...pages].filter(n => n > 0).sort((a, b) => a - b)
  return sorted.flatMap((n, i) => i && n > sorted[i - 1] + 1 ? [0, n] : [n])
})
const searched = toRef(onlineSearchSession, 'searched')
const searchError = ref('')
const pageError = ref('')
const searching = ref(false)
const searchingWithBrowser = ref(false)
const browserConfirmation = ref(false)
const starting = ref(false)
const loadingMore = ref(false)
const busy = computed(() => searching.value || starting.value || loadingMore.value)
const wantsPreview = ref(false)
const catalog = computed(() => onlineSearchSession.preview ? activeDiscovery.value?.state.catalog : undefined)
const parsing = computed(() => Boolean(activeDiscovery.value && !activeDiscovery.value.state.finished))
const parsePopupVisible = computed(() => parsing.value && wantsPreview.value && !catalog.value)
let parsePopupId = Date.now() * 1000 + Math.floor(Math.random() * 1000), popupQueue = Promise.resolve(), alive = true
let popupListeners: UnlistenFn[] = []
const metadataDialog = ref<HTMLDialogElement>()
const metadataTitle = ref('')
const metadataAuthor = ref('')
const selectedUrl = ref('')
const parseVerification = computed(() => {
  const source = activeDiscovery.value?.url
  return source ? onlineVerifications.value.find(item => new URL(item.url).hostname.replace(/^www\./u, '') === new URL(source).hostname.replace(/^www\./u, '')) : undefined
})
const parseStatus = computed(() => {
  if (parseVerification.value) return '等待网页验证'
  const progress = activeDiscovery.value?.state.progress
  return !progress || !progress.pages ? '正在读取网页' : progress.chapters ? `已识别 ${progress.chapters} 章 · 正在整理目录` : `正在识别第 ${progress.pages} 页`
})
watch(() => [parsePopupVisible.value, parseStatus.value, activeDiscovery.value?.url, Boolean(parseVerification.value)], () => {
  if (!isTauri()) return
  const id = parsePopupId
  const input = { id, text: activeDiscovery.value ? new URL(activeDiscovery.value.url).hostname : '', subtitle: parseStatus.value, action: parseVerification.value ? '打开验证窗口' : undefined }
  popupQueue = popupQueue.then(async () => {
    if (alive && parsePopupVisible.value && parsePopupId === id) { if (parseStatus.value === input.subtitle) await invoke('show_floating_layer', { kind: 'progress', input }) }
    else await invoke('hide_floating_layer', { kind: 'progress', id })
  }).catch(cause => showGlobalError(cause, '解析弹框打开失败'))
}, { flush: 'post' })
const description = computed(() => {
  const text = (catalog.value?.description || '').replace(/\\[nr]/gu, ' ')
  return /第\d+页|本页收录|最新章节.*列表|保证无.*广告/u.test(text) ? '' : text
})
const showTasks = computed({
  get: () => route.query.tab === 'tasks' || Boolean(route.query.book),
  set: value => { void router.replace({ query: value ? { ...route.query, tab: 'tasks' } : { ...route.query, tab: undefined, book: undefined } }) }
})
const checking = ref('')
const apiKeyInput = ref<HTMLInputElement>()
const pendingDelete = ref<OnlineBook>()
const deleting = ref(false)
const taskFilter = ref<'all' | 'active' | 'paused' | 'complete'>('all')
const clearing = ref(false)
const hostname = (url: string) => new URL(url).hostname.replace(/^www\./u, '')
const visibleTasks = computed(() => {
  const id = String(route.query.book || '')
  return onlineBooks.value.filter(book => book.taskVisible !== false).sort((a, b) => Number(b.bookId === id) - Number(a.bookId === id))
})
const completed = (book: OnlineBook) => book.catalogComplete !== false && book.chapters.every(chapter => chapter.status === 'cached')
const taskBooks = computed(() => visibleTasks.value.filter(book => taskFilter.value === 'all'
  || (taskFilter.value === 'active' && book.state === 'downloading')
  || (taskFilter.value === 'paused' && book.state === 'paused')
  || (taskFilter.value === 'complete' && completed(book))))
const completedCount = computed(() => visibleTasks.value.filter(completed).length)
const activeCount = computed(() => onlineBooks.value.filter(b => b.state === 'downloading').length)
const labels: Record<string, string> = { idle: '按需阅读', downloading: '下载中', paused: '已暂停', cancelled: '已取消', complete: '已下载', failed: '下载未完成' }
const cached = (id: string) => onlineBooks.value.find(b => b.bookId === id)?.chapters.filter(c => c.status === 'cached').length || 0

async function analyze(url: string) {
  if (busy.value) return
  onlineSearchSession.scrollTop = document.querySelector('.app-workspace')?.scrollTop || 0
  onlineSearchSession.preview = false
  wantsPreview.value = true
  pageError.value = ''
  selectedUrl.value = url
  parsePopupId++
  beginOnlineDiscovery(url)
  await nextTick()
  document.querySelector('.app-workspace')?.scrollTo({ top: 0 })
}

async function submit(useBrowser = false) {
  const value = query.value.trim()
  if (!value || busy.value) return
  if (httpUrl(value)) return analyze(value)
  if (/^\w+:\/\//u.test(value)) { showGlobalMessage('请输入 HTTP 或 HTTPS 网页链接', 'warning'); return }
  if (onlineSearchSettings.provider === 'brave' && !onlineSearchSettings.apiKey.trim()) {
    apiKeyInput.value?.focus()
    showGlobalMessage('请填写搜索密钥', 'warning')
    return
  }
  searching.value = true
  searchingWithBrowser.value = useBrowser
  browserConfirmation.value = useBrowser
  searchError.value = ''
  pageError.value = ''
  wantsPreview.value = false
  if (activeDiscovery.value && !activeDiscovery.value.state.bookId) activeDiscovery.value.cancel()
  activeDiscovery.value = undefined
  onlineSearchSession.preview = false
  resultPages.value = []
  onlineSearchSession.page = 1
  onlineSearchSession.pendingHits = []
  searched.value = false
  try {
    const page = await loadSearchBatch(cursor => searchOnlineBooks(value, onlineSearchSettings.apiKey, onlineSearchSettings.provider, cursor, { browser: useBrowser && !cursor, onBrowser: interactive => { searchingWithBrowser.value = true; browserConfirmation.value = interactive } }), { initial: true })
    resultPages.value = [page.hits]
    onlineSearchSession.pendingHits = page.pending
    onlineSearchSession.cursor = page.next
    pageError.value = page.warning
    onlineSearchSession.submittedQuery = value
    onlineSearchSession.engine = onlineSearchSettings.provider
    onlineSearchSession.recent = [value, ...onlineSearchSession.recent.filter(query => query !== value)].slice(0, 6)
    searched.value = true
  } catch (cause) { searchError.value = cause instanceof Error ? cause.message : String(cause) }
  finally { searching.value = false; searchingWithBrowser.value = false }
}

async function changePage(number: number) {
  if (busy.value || number < 1) return
  pageError.value = ''
  if (number <= resultPages.value.length) {
    onlineSearchSession.page = number
    await nextTick()
    document.querySelector('.app-workspace')?.scrollTo({ top: 0 })
    return
  }
  if (!hasNextPage.value) return
  loadingMore.value = true
  searchingWithBrowser.value = false
  browserConfirmation.value = false
  await nextTick()
  document.querySelector('.app-workspace')?.scrollTo({ top: 0 })
  try {
    const page = await loadSearchBatch(cursor => searchOnlineBooks(onlineSearchSession.submittedQuery, onlineSearchSettings.apiKey, onlineSearchSession.engine, cursor, { onBrowser: interactive => { searchingWithBrowser.value = true; browserConfirmation.value = interactive } }), { cursor: onlineSearchSession.cursor, pending: onlineSearchSession.pendingHits })
    onlineSearchSession.pendingHits = page.pending
    onlineSearchSession.cursor = page.next
    pageError.value = page.warning
    if (page.hits.length || page.next) {
      resultPages.value.push(page.hits)
      onlineSearchSession.page = resultPages.value.length
      await nextTick()
      document.querySelector('.app-workspace')?.scrollTo({ top: 0 })
    } else showGlobalMessage('没有更多结果', 'info')
  } catch (cause) { pageError.value = cause instanceof Error ? cause.message : String(cause) }
  finally { loadingMore.value = false; searchingWithBrowser.value = false; browserConfirmation.value = false }
}

function editMetadata() {
  if (!catalog.value) return
  metadataTitle.value = catalog.value.title
  metadataAuthor.value = catalog.value.author || ''
  metadataDialog.value?.showModal()
}
function saveMetadata() {
  activeDiscovery.value?.setMetadata(metadataTitle.value, metadataAuthor.value)
  metadataDialog.value?.close()
}

async function returnToResults() {
  wantsPreview.value = false
  if (activeDiscovery.value && !activeDiscovery.value.state.bookId && !activeDiscovery.value.state.finished) activeDiscovery.value.cancel()
  onlineSearchSession.preview = false
  if (resultPages.value.length) query.value = onlineSearchSession.submittedQuery
  await nextTick()
  document.querySelector('.app-workspace')?.scrollTo({ top: onlineSearchSession.scrollTop })
}

function cancelParse() { wantsPreview.value = false; activeDiscovery.value?.cancel(); selectedUrl.value = '' }

function clear() {
  wantsPreview.value = false
  searchError.value = ''
  pageError.value = ''
  query.value = ''
  resultPages.value = []
  onlineSearchSession.page = 1
  onlineSearchSession.pendingHits = []
  if (activeDiscovery.value && !activeDiscovery.value.state.bookId) activeDiscovery.value.cancel()
  activeDiscovery.value = undefined
  onlineSearchSession.preview = false
  onlineSearchSession.cursor = undefined
  searched.value = false
}

async function start(read: boolean, number?: number) {
  if (!catalog.value || busy.value) return
  starting.value = true
  try {
    const bookId = await activeDiscovery.value!.adopt()
    if (read) {
      const book = await getDesktopBook(bookId)
      await router.push({ path: `/read/${bookId}/${number || book?.currentChapter || 1}`, query: { from: 'online' } })
    }
    else {
      void downloadOnlineBook(bookId)
      showTasks.value = true
      showGlobalMessage('已开始下载')
    }
  } catch (cause) { showGlobalError(cause, '加入书架失败') }
  finally { starting.value = false }
}

async function check(bookId: string) {
  checking.value = bookId
  try {
    const count = await checkOnlineUpdates(bookId)
    if (!onlineBooks.value.find(book => book.bookId === bookId)?.taskVisible) return
    showGlobalMessage(count ? `新增 ${count} 章，已开始下载` : '目录已是最新')
    if (count) void downloadOnlineBook(bookId)
  } catch (cause) { if (!(cause instanceof DOMException && cause.name === 'AbortError')) showGlobalError(cause, '检查更新失败') }
  finally { checking.value = '' }
}

async function action(work: () => Promise<unknown>) {
  try { await work() } catch (cause) { showGlobalError(cause, '操作失败，请稍后重试') }
}
async function external(url: string) {
  await action(() => openWebPage(url))
}
function closeMenu(event: Event) {
  const menu = (event.currentTarget as HTMLElement).closest('details')
  if (menu) menu.open = false
}
async function removeTask(book: OnlineBook, event: Event) {
  closeMenu(event)
  await action(async () => {
    await removeOnlineTask(book.bookId)
    if (route.query.book === book.bookId) await router.replace({ query: { ...route.query, book: undefined, tab: 'tasks' } })
    showGlobalMessage('任务已移除，书籍已保留')
  })
}
async function deleteBook() {
  if (!pendingDelete.value) return
  deleting.value = true
  try {
    await deleteDesktopBook(pendingDelete.value.bookId)
    pendingDelete.value = undefined
    showGlobalMessage('书籍已删除')
  } catch (cause) { showGlobalError(cause, '删除失败，请重试') }
  finally { deleting.value = false }
}
async function clearCompleted() {
  clearing.value = true
  await action(async () => {
    const ids = visibleTasks.value.filter(completed).map(book => book.bookId)
    for (const id of ids) await removeOnlineTask(id)
    if (ids.includes(String(route.query.book))) await router.replace({ query: { ...route.query, book: undefined, tab: 'tasks' } })
    showGlobalMessage('已清除完成任务，书籍已保留')
  })
  clearing.value = false
}
function dismissMenus(event: Event) {
  document.querySelectorAll<HTMLDetailsElement>('.online-task-menu[open]').forEach(menu => {
    if (!menu.contains(event.target as Node)) menu.open = false
  })
}
onMounted(() => { void action(async () => {
  if (isTauri()) {
    const listeners = await Promise.all([
      listen<number>('floating-progress-cancelled', event => { if (event.payload === parsePopupId) cancelParse() }),
      listen<number>('floating-progress-verify', event => { if (event.payload === parsePopupId && parseVerification.value) void action(() => showOnlineVerification(parseVerification.value!.requestId)) })
    ])
    if (alive) popupListeners = listeners; else listeners.forEach(unlisten => unlisten())
  }
  await refreshOnlineBooks()
  if (route.query.book) await restoreOnlineTask(String(route.query.book))
  if (!showTasks.value && !onlineSearchSession.preview) { await nextTick(); document.querySelector('.app-workspace')?.scrollTo({ top: onlineSearchSession.scrollTop }) }
}); document.addEventListener('pointerdown', dismissMenus) })
watch(() => route.query.book, id => {
  if (id) void action(async () => { await refreshOnlineBooks(); await restoreOnlineTask(String(id)) })
})
watch(() => activeDiscovery.value?.state.catalog, value => {
  if (!value || !wantsPreview.value) return
  const entering = !onlineSearchSession.preview
  onlineSearchSession.preview = true
  if (entering) document.querySelector('.app-workspace')?.scrollTo({ top: 0 })
})
watch(() => activeDiscovery.value?.state.finished, finished => {
  if (!finished) return
  const job = activeDiscovery.value
  if (job?.state.error) {
    onlineSearchSession.failures[job.url] = job.state.error
    if (/未能可靠识别目录或正文|这是网站首页/u.test(job.state.error)) void external(job.url)
    else showGlobalError(job.state.error, '网页解析失败')
  }
})
watch(() => onlineSearchSettings.provider, value => {
  searchError.value = ''
  pageError.value = ''
  localStorage.setItem('novel-library-search-engine', value)
  if (!onlineSearchSession.preview) { resultPages.value = []; onlineSearchSession.page = 1; onlineSearchSession.pendingHits = []; searched.value = false; onlineSearchSession.cursor = undefined }
})
watch(() => onlineSearchSettings.novelOnly, value => {
  localStorage.setItem('novel-library-search-novel-only', String(value))
  if (searched.value && !onlineSearchSession.preview) { query.value = onlineSearchSession.submittedQuery; void submit() }
})
onBeforeUnmount(() => { alive = false; popupListeners.forEach(unlisten => unlisten()); if (isTauri()) popupQueue = popupQueue.then(() => invoke('hide_floating_layer', { kind: 'progress', id: parsePopupId })).then(() => {}, () => {}); metadataDialog.value?.close(); if (activeDiscovery.value && !activeDiscovery.value.state.bookId) activeDiscovery.value.cancel(); document.removeEventListener('pointerdown', dismissMenus) })
</script>

<template>
  <section class="workspace-view online-view">
    <PageHeader :title="showTasks ? '下载任务' : '在线找书'">
      <template #actions>
        <button v-if="!showTasks" type="button" class="icon-button" title="打开网页" aria-label="打开网页" @click="external('https://cn.bing.com/')"><Globe2 :size="17" /></button>
        <button type="button" class="secondary-command" @click="showTasks = !showTasks">
          <ArrowLeft v-if="showTasks" :size="16" /><Download v-else :size="16" />
          {{ showTasks ? '返回找书' : '下载任务' }}<span v-if="!showTasks && activeCount" class="task-count">{{ activeCount }}</span>
        </button>
      </template>
    </PageHeader>

    <div v-if="!showTasks" class="search-stage">
      <div class="online-search-row"><form class="search-control" role="search" @submit.prevent="submit()">
        <Search :size="19" />
        <input v-model="query" aria-label="书名、作者或网页链接" placeholder="搜索书名、作者，或粘贴网页链接" :disabled="busy" />
        <button v-if="query && !busy" type="button" class="clear-search" title="清空" aria-label="清空搜索" @click="clear"><X :size="16" /></button>
        <button type="submit" class="primary-command" :disabled="busy || !query.trim()">{{ searching ? '搜索中' : httpUrl(query.trim()) ? '解析' : '搜索' }}</button>
      </form><UiSelect class="online-engine" :model-value="onlineSearchSettings.provider" :options="searchEngineOptions" label="搜索引擎" :disabled="busy" @update:model-value="onlineSearchSettings.provider = $event as SearchEngine" /><label v-if="!catalog" class="online-search-options"><input v-model="onlineSearchSettings.novelOnly" type="checkbox" :disabled="busy" />仅看小说</label></div>
      <input v-if="onlineSearchSettings.provider === 'brave'" ref="apiKeyInput" v-model="onlineSearchSettings.apiKey" class="online-api-key" type="password" autocomplete="off" aria-label="Brave Search API 密钥" placeholder="Brave Search API 密钥" />


      <section v-if="catalog" class="online-book">
        <button type="button" class="text-command online-back" @click="returnToResults"><ArrowLeft :size="14" />{{ hits.length ? '返回搜索结果' : '返回找书' }}</button>
        <div class="online-book-heading">
          <div class="online-cover">{{ catalog.title.slice(0, 1) }}</div>
          <div class="online-book-copy"><div class="online-book-title"><h2>{{ catalog.title }}</h2><button v-if="!activeDiscovery?.state.bookId" type="button" class="icon-button online-edit" aria-label="编辑书籍信息" title="编辑书籍信息" @click="editMetadata"><Pencil :size="13" /></button></div><p>{{ [catalog.author, `${catalog.chapters.length}${catalog.complete === false ? '+' : ''} 章`, hostname(catalog.catalogUrl)].filter(Boolean).join(' · ') }}</p></div>
          <button type="button" class="icon-button" title="打开来源网页" aria-label="打开来源网页" @click="external(catalog.catalogUrl)"><ArrowUpRight :size="18" /></button>
        </div>
        <p v-if="description" class="online-description">{{ description }}</p>
        <div v-if="parsing" class="online-catalog-progress" role="status"><RefreshCw :size="13" class="spinning" />{{ parseStatus }}<button type="button" class="text-command" @click="cancelParse">停止解析</button><button v-if="parseVerification" type="button" class="text-command" @click="action(() => showOnlineVerification(parseVerification!.requestId))">打开验证窗口</button></div>
        <p v-if="catalog.warnings.length" class="online-book-hint">{{ catalog.chapters.length === 1 ? '仅识别到当前章节' : catalog.warnings.join('；') }}</p>
        <div class="online-book-actions"><button type="button" class="primary-command" :disabled="busy || !catalog.title.trim()" @click="start(true)"><BookOpen :size="16" />开始阅读</button><button type="button" class="secondary-command" :disabled="busy || !catalog.title.trim()" @click="start(false)"><Download :size="16" />下载到书架</button></div>
        <details class="online-directory"><summary>章节目录 <span>{{ catalog.chapters.length }}</span></summary><ol><li v-for="(chapter, index) in catalog.chapters" :key="chapter.url"><button type="button" :disabled="starting" @click="start(true, index + 1)">{{ chapter.title }}</button></li></ol></details>
      </section>

      <OnlineSearchLoading v-else-if="searching || loadingMore" class="online-results" :label="browserConfirmation ? '请在网页窗口完成确认' : loadingMore ? `正在加载第 ${onlineSearchSession.page + 1} 页` : '正在搜索'" :cancellable="searchingWithBrowser" @cancel="action(cancelBrowserSearch)" />
      <section v-else-if="hits.length || (searched && hasNextPage)" class="online-results" aria-label="网络搜索结果">
        <header class="search-result-heading"><span>本页 {{ hits.length }} 条结果</span><button type="button" class="text-command" @click="external(searchBrowserUrl(onlineSearchSession.engine, onlineSearchSession.submittedQuery))">在浏览器中搜索<ArrowUpRight :size="13" /></button></header>
        <div v-if="pageError" class="online-page-error" role="alert"><span>{{ pageError }}</span><button type="button" class="text-command" :disabled="busy" @click="changePage(onlineSearchSession.page + 1)">重试</button></div>
        <div v-if="!hits.length" class="online-no-matches"><span>{{ onlineSearchSettings.novelOnly ? '本页暂无小说结果' : '本页暂无结果' }}</span><button v-if="onlineSearchSettings.novelOnly" type="button" class="text-command" @click="onlineSearchSettings.novelOnly = false">显示全部结果</button></div>
        <article v-for="(hit, index) in hits" :key="`${index}:${hit.url}`" class="online-result" :class="{ 'is-parsing': parsing && selectedUrl === hit.url }" :aria-busy="parsing && selectedUrl === hit.url">
          <button type="button" class="online-result-copy" :disabled="busy" @click="isNovelSearchHit(hit) ? analyze(hit.url) : external(hit.url)"><small>{{ hostname(hit.url) }}</small><strong :title="hit.title">{{ hit.title }}</strong><p v-if="hit.description">{{ hit.description }}</p></button>
          <div class="online-result-actions"><button v-if="isNovelSearchHit(hit)" type="button" class="secondary-command online-read-action" :disabled="busy || (parsing && selectedUrl === hit.url)" :title="onlineSearchSession.failures[hit.url]" @click="analyze(hit.url)"><RefreshCw v-if="parsing && selectedUrl === hit.url" :size="14" class="spinning" />{{ parsing && selectedUrl === hit.url ? '解析中' : onlineSearchSession.failures[hit.url] ? '重试' : '阅读' }}</button>
          <button type="button" class="secondary-command online-view-page" title="查看原网页" aria-label="查看原网页" @click="external(hit.url)">查看网页</button>
          </div>
        </article>
      </section>
      <div v-else-if="searchError && !busy" class="online-search-error" role="alert"><p>{{ searchError }}</p><div><button v-if="onlineSearchSettings.provider !== 'brave'" type="button" class="text-command" @click="submit(true)">打开搜索窗口<ArrowUpRight :size="13" /></button><button type="button" class="text-command" @click="external(searchBrowserUrl(onlineSearchSettings.provider, query))">在浏览器中搜索<ArrowUpRight :size="13" /></button></div></div>
      <div v-else-if="searched && !busy" class="search-empty" role="status">{{ onlineSearchSettings.novelOnly ? '没有找到小说结果' : '没有找到相关来源' }}<button v-if="onlineSearchSettings.novelOnly" type="button" class="text-command" @click="onlineSearchSettings.novelOnly = false">显示全部结果</button><button type="button" class="text-command" @click="external(searchBrowserUrl(onlineSearchSettings.provider, query))">在浏览器中搜索<ArrowUpRight :size="13" /></button></div>
      <OnlineSearchEmpty v-else-if="!parsing && !searching && !catalog && !hits.length" :recent="onlineSearchSession.recent" @search="query = $event; submit()" @remove="onlineSearchSession.recent = onlineSearchSession.recent.filter(query => query !== $event)" @clear="onlineSearchSession.recent = []" />
      <nav v-if="!catalog && !searching && resultPages.length && (searched || loadingMore)" class="online-pagination" :aria-busy="loadingMore" aria-label="搜索结果分页"><button type="button" class="secondary-command" :disabled="busy || onlineSearchSession.page === 1" @click="changePage(onlineSearchSession.page - 1)"><ChevronLeft :size="14" />上一页</button><template v-for="(number, index) in pageNumbers" :key="index"><button v-if="number" type="button" class="online-page-number" :aria-label="`第 ${number} 页`" :aria-current="number === onlineSearchSession.page ? 'page' : undefined" :disabled="busy" @click="changePage(number)">{{ number }}</button><span v-else aria-hidden="true">…</span></template><button type="button" class="secondary-command" :disabled="busy || !hasNextPage" @click="changePage(onlineSearchSession.page + 1)">下一页<ChevronRight :size="14" /></button></nav>
    </div>

    <div v-else class="online-task-list">
      <div v-if="visibleTasks.length" class="online-task-toolbar">
        <div class="online-task-filters" role="group" aria-label="筛选下载任务">
          <button type="button" :aria-pressed="taskFilter === 'all'" @click="taskFilter = 'all'">全部 <span>{{ visibleTasks.length }}</span></button>
          <button type="button" :aria-pressed="taskFilter === 'active'" @click="taskFilter = 'active'">下载中</button>
          <button type="button" :aria-pressed="taskFilter === 'paused'" @click="taskFilter = 'paused'">已暂停</button>
          <button type="button" :aria-pressed="taskFilter === 'complete'" @click="taskFilter = 'complete'">已完成</button>
        </div>
        <button type="button" class="text-command" :disabled="!completedCount || clearing" @click="clearCompleted"><Trash2 :size="13" />清除已完成</button>
      </div>
      <div v-if="!taskBooks.length" class="search-empty" role="status">{{ taskFilter === 'active' && visibleTasks.length ? '暂无进行中的下载' : taskFilter === 'paused' && visibleTasks.length ? '暂无已暂停任务' : taskFilter === 'complete' && visibleTasks.length ? '暂无已完成任务' : '暂无下载任务' }}</div>
      <article v-for="book in taskBooks" :key="book.bookId" class="online-task">
        <button type="button" class="online-task-cover" :aria-label="`阅读《${book.title}》`" @click="router.push(`/book/${book.bookId}`)">{{ book.title.slice(0, 1) }}</button>
        <div class="online-task-body">
          <div class="online-task-title"><button type="button" class="online-task-book" @click="router.push(`/book/${book.bookId}`)">{{ book.title }}</button><span :class="{ 'is-active': book.state === 'downloading', 'is-complete': cached(book.bookId) === book.chapters.length && book.catalogComplete !== false }">{{ book.catalogComplete === false && ['idle', 'downloading', 'failed'].includes(book.state) ? book.error ? '目录未完整' : '目录整理中' : labels[book.state] || book.state }}</span></div>
          <div class="online-task-progress"><progress :value="cached(book.bookId)" :max="book.chapters.length" :aria-label="`${book.title}下载进度`" /><small>{{ cached(book.bookId) }} / {{ book.chapters.length }} 章</small></div>
          <button type="button" class="online-task-source" @click="external(book.catalogUrl)">{{ hostname(book.catalogUrl) }}<ArrowUpRight :size="11" /></button>
          <details v-if="book.error || book.chapters.some(c => c.status === 'failed')" class="online-failures"><summary>查看未完成原因</summary><p v-if="book.error">{{ book.error }}</p><p v-for="chapter in book.chapters.filter(c => c.status === 'failed')" :key="chapter.number">{{ chapter.title }}：{{ chapter.error }}</p></details>
        </div>
        <div class="online-task-actions">
          <button type="button" class="secondary-command" @click="router.push(`/book/${book.bookId}`)"><BookOpen :size="15" />阅读</button>
          <button v-if="book.state === 'downloading'" type="button" class="icon-button" title="暂停下载" aria-label="暂停下载" @click="action(() => pauseOnlineBook(book.bookId))"><Pause :size="16" /></button>
          <button v-else-if="cached(book.bookId) < book.chapters.length || book.catalogComplete === false" type="button" class="secondary-command" @click="action(() => downloadOnlineBook(book.bookId))"><Play :size="14" />{{ book.state === 'failed' ? '重试' : book.state === 'idle' ? '下载' : '继续' }}</button>
          <details class="online-task-menu" @keydown.esc="($event.currentTarget as HTMLDetailsElement).open = false">
            <summary aria-label="更多任务操作" title="更多任务操作"><MoreHorizontal :size="18" /></summary>
            <div>
              <button type="button" :disabled="Boolean(checking) || book.state === 'downloading'" @click="closeMenu($event); check(book.bookId)"><RefreshCw :size="14" />检查更新</button>
              <label class="online-follow"><input type="checkbox" :checked="book.autoUpdate" @change="action(() => toggleOnlineUpdates(book.bookId, ($event.target as HTMLInputElement).checked))" />自动追更</label>
              <button v-if="book.state === 'downloading' || book.state === 'paused'" type="button" @click="closeMenu($event); action(() => pauseOnlineBook(book.bookId, true))"><X :size="14" />取消下载</button>
              <hr />
              <button type="button" @click="removeTask(book, $event)">移除任务</button>
              <button type="button" class="online-delete" @click="closeMenu($event); pendingDelete = book"><Trash2 :size="14" />删除书籍</button>
            </div>
          </details>
        </div>
      </article>
    </div>

    <Teleport to="body">
      <dialog ref="metadataDialog" class="ui-dialog online-metadata-dialog">
        <form @submit.prevent="saveMetadata"><header><h2>书籍信息</h2><button type="button" class="icon-button" aria-label="关闭书籍信息" @click="metadataDialog?.close()"><X :size="16" /></button></header><label for="online-book-title">书名</label><input id="online-book-title" v-model="metadataTitle" autocomplete="off" required /><label for="online-book-author">作者</label><input id="online-book-author" v-model="metadataAuthor" autocomplete="off" /><footer class="ui-dialog-actions"><button type="button" class="secondary-command" @click="metadataDialog?.close()">取消</button><button type="submit" class="primary-command" :disabled="!metadataTitle.trim()">保存</button></footer></form>
      </dialog>
    </Teleport>
    <UiDialog v-if="!isTauri()" :open="parsePopupVisible" title="正在解析" @close="cancelParse"><div class="online-parse-site" role="status"><RefreshCw :size="18" class="spinning" /><div><strong>{{ activeDiscovery ? hostname(activeDiscovery.url) : '' }}</strong><span>{{ parseStatus }}</span></div></div><div class="online-parse-track"><span /></div><footer class="ui-dialog-actions"><button type="button" class="secondary-command" @click="cancelParse">取消</button></footer></UiDialog>
    <UiConfirmDialog :open="Boolean(pendingDelete)" :busy="deleting" danger title="删除这本书？" :description="`《${pendingDelete?.title || ''}》的本地正文、阅读进度和下载任务将一起删除。`" confirm-label="删除书籍" @close="pendingDelete = undefined" @confirm="deleteBook" />
  </section>
</template>

<style scoped>
.online-view { width: min(1200px, 100%); padding: 26px 32px 36px; container-type: inline-size; }
.online-view :deep(.workspace-header) { margin-bottom: 16px; }
.online-view :deep(.workspace-header h1) { font-size: 26px; }
.online-view .search-stage { width: 100%; }
.online-search-row { display: flex; align-items: center; gap: 12px; }
.online-search-row .search-control { flex: 1; width: auto; height: 38px; border-radius: 7px; }
.online-engine { min-width: 110px; max-width: 140px; }
.online-engine :deep(.ui-select-trigger) { min-width: 110px; border-color: transparent; padding-left: 9px; }
.online-engine :deep(.ui-select-menu) { max-height: min(288px, 45vh); overflow-y: auto; }
.online-pagination { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 22px 0; }
.online-page-number { width: 30px; height: 30px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--ui-text-3); cursor: pointer; font-variant-numeric: tabular-nums; }
.online-page-number:hover { background: var(--ui-hover); color: var(--ui-text); }
.online-page-number[aria-current=page] { background: var(--ui-hover); color: var(--ui-accent); font-weight: 600; }
.online-pagination > .secondary-command:first-child { margin-right: 8px; }
.online-pagination > .secondary-command:last-child { margin-left: 8px; }
.online-api-key { display: block; width: 340px; max-width: 100%; height: 34px; margin-top: 12px; padding: 0 10px; border: 1px solid var(--ui-border); border-radius: 6px; background: var(--ui-surface); color: var(--ui-text); font-size: 12px; }
.online-pagination > span { color: var(--ui-text-3); font-size: 12px; font-variant-numeric: tabular-nums; }
.online-pagination > button { font-size: 12px; }
.online-search-options { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 6px; color: var(--ui-text-2); font-size: 12px; cursor: pointer; white-space: nowrap; }
.online-search-options input { width: 13px; height: 13px; margin: 0; accent-color: var(--ui-accent); }
.online-no-matches { display: grid; justify-items: center; gap: 12px; padding: 32px 0; color: var(--ui-text-3); font-size: 12px; }
.online-no-matches button { font-size: 12px; }
.online-page-error { display: flex; align-items: center; gap: 14px; margin: 14px 0; padding: 12px 14px; border-radius: 8px; background: var(--ui-hover); color: var(--ui-text-2); font-size: 12px; }
.online-page-error > span { flex: 1; }
.online-page-error > button { flex-shrink: 0; font-size: 12px; }
.online-result.is-parsing { background: var(--ui-hover); border-radius: 8px; }
.online-back { margin: 0 0 22px -6px; font-size: 12px; }
.online-catalog-progress { display: flex; gap: 7px; align-items: center; margin-top: 18px; color: var(--ui-text-3); font-size: 12px; }
.online-catalog-progress button { flex: 0 0 auto; margin-left: 4px; font-size: 11px; }
.online-directory li > button { width: 100%; padding: 6px; border: 0; border-radius: 6px; text-align: left; color: var(--ui-text); background: none; font-size: 12px; cursor: pointer; }
.online-directory li > button:hover { background: var(--ui-hover); }
.online-settings { overflow: visible; }
.online-settings :deep(.ui-select-trigger) { height: 36px; }
.online-settings :deep(.ui-select-menu) { max-height: min(260px, 30vh); overflow-y: auto; }
.online-parse-progress { margin-top: 24px; padding: 16px; border: 1px solid var(--ui-border); border-radius: 8px; background: var(--ui-surface); }
.online-parse-site { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 14px; }
.online-parse-site > svg { flex-shrink: 0; color: var(--ui-accent); }
.online-parse-site > div { display: grid; gap: 7px; }
.online-parse-site strong { font-size: 13px; font-weight: 600; }
.online-parse-site strong > span { margin-left: 6px; font-weight: 400; }
.online-parse-site button { font-size: 12px; }
.online-parse-site span { font-size: 12px; color: var(--ui-text-3); }
.online-parse-track { height: 3px; overflow: hidden; border-radius: 3px; background: var(--ui-border); }
.online-parse-track > span { display: block; width: 36%; height: 100%; background: var(--ui-accent); border-radius: inherit; animation: online-parsing 1.3s ease-in-out infinite; }
@keyframes online-parsing { from { transform: translateX(-110%); } to { transform: translateX(390%); } }
.online-loading { display: flex; align-items: center; gap: 8px; min-height: 58px; color: var(--ui-text-3); font-size: 12px; }
.online-search-error { display: grid; justify-items: start; gap: 9px; margin-top: 28px; padding: 16px; border-radius: 9px; background: var(--ui-hover); }
.online-search-error p { margin: 0; color: var(--ui-text-2); font-size: 12px; line-height: 1.8; }
.online-search-error button { font-size: 12px; }
.online-search-error > div { display: flex; gap: 20px; }
.task-count { font-size: 11px; color: var(--ui-text-3); }
.online-results { margin-top: 20px; }
.online-results .search-result-heading { margin-bottom: 0; min-height: 28px; padding: 0; }
.online-results .search-result-heading button { min-height: 26px; padding-right: 0; font-size: 11px; }
.online-result { display: flex; align-items: center; gap: 24px; padding: 14px 0; border-bottom: 1px solid color-mix(in srgb,var(--ui-text) 10%,transparent); }
.online-result-copy { display: grid; gap: 5px; flex: 1; min-width: 0; padding: 0; text-align: left; border: 0; background: transparent; cursor: pointer; }
.online-result-copy small { color: var(--ui-text-3); font-size: 11px; }
.online-result-copy strong { overflow: hidden; color: var(--ui-text); font-size: 14px; font-weight: 600; line-height: 1.5; text-overflow: ellipsis; white-space: nowrap; }
.online-result-copy p { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 1; overflow: hidden; margin: 0; color: var(--ui-text-3); font-size: 12px; line-height: 1.6; }
.online-result-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 8px; }
.online-result-actions button { height: 28px; min-height: 28px; padding: 0 8px; border-radius: 5px; font-size: 12px; font-weight: 400; }
.online-result-actions .online-read-action { color: var(--ui-accent); }
@container (max-width: 640px) { .online-search-row { flex-wrap: wrap; gap: 8px; } .online-search-row .search-control { flex-basis: 100%; } .online-engine { min-width: 96px; } }
@container (max-width: 480px) { .online-result { flex-wrap: wrap; gap: 7px; } .online-result-copy { flex-basis: 100%; } .online-result-actions { margin-left: auto; } }
.online-book { max-width: 720px; margin-top: 30px; }
.online-book-heading { display: flex; align-items: center; gap: 16px; }
.online-cover { width: 72px; height: 98px; flex-shrink: 0; display: grid; place-items: center; border: 1px solid var(--ui-border); border-radius: 8px; background: var(--ui-surface-2); color: var(--ui-text-2); font-family: SimSun, serif; font-size: 29px; }
.online-book-copy { flex: 1; min-width: 0; }
.online-book-title { display: flex; align-items: center; gap: 8px; margin-bottom: 9px; }
.online-book h2 { margin: 0; color: var(--ui-text); font-size: 23px; line-height: 1.4; font-weight: 650; }
.online-edit { flex-shrink: 0; color: var(--ui-text-3); opacity: .65; }
.online-edit:hover,.online-edit:focus-visible { opacity: 1; }
.online-book-copy p,.online-book-hint { margin: 0; color: var(--ui-text-3); font-size: 12px; }
.online-description { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; color: var(--ui-text-2); font-size: 13px; line-height: 1.9; margin: 22px 0; }
.online-book-hint { margin-top: 14px; }
.online-book-actions { display: flex; gap: 10px; margin: 20px 0 25px; }
.online-directory { border-top: 1px solid var(--ui-border); }
summary { padding: 13px 0; color: var(--ui-text-2); cursor: pointer; font-size: 12px; }
summary span { margin-left: 5px; color: var(--ui-text-3); }
.online-directory ol { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px 10px; max-height: 310px; overflow-y: auto; padding: 0; list-style: none; font-size: 12px; line-height: 2.1; color: var(--ui-text-2); }
.online-metadata-dialog header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
.online-metadata-dialog h2 { margin: 0; }
.online-metadata-dialog label { display: block; margin: 16px 0 8px; font-size: 12px; color: var(--ui-text-2); }
.online-metadata-dialog input,.online-settings input { min-width: 0; width: 100%; padding: 9px 11px; color: var(--ui-text); border: 1px solid var(--ui-border); border-radius: 7px; background: var(--ui-surface); }
.online-task-list { max-width: 960px; }
.online-task-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding-bottom: 15px; border-bottom: 1px solid var(--ui-border); }
.online-task-filters { display: flex; align-items: center; gap: 3px; }
.online-task-filters button { min-height: 30px; padding: 0 11px; border: 0; border-radius: 7px; color: var(--ui-text-3); background: transparent; cursor: pointer; font-size: 12px; }
.online-task-filters button[aria-pressed=true] { color: var(--ui-text); background: var(--ui-hover); font-weight: 600; }
.online-task-filters span { margin-left: 4px; font-size: 10px; color: var(--ui-text-3); }
.online-task-toolbar > button { font-size: 11px; }
.online-task { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; align-items: center; gap: 17px; padding: 22px 0; border-bottom: 1px solid var(--ui-border); }
.online-task-cover { align-self: start; width: 44px; height: 60px; display: grid; place-items: center; margin-top: 2px; border: 1px solid color-mix(in srgb, var(--ui-text-2) 9%, transparent); border-radius: 6px; color: var(--ui-text-2); background: var(--ui-surface-2); font-family: SimSun, serif; font-size: 22px; cursor: pointer; }
.online-task-body { min-width: 0; }
.online-task-title { display: flex; align-items: center; gap: 10px; }
.online-task-book { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0; text-align: left; color: var(--ui-text); font-size: 13px; font-weight: 600; border: 0; background: none; cursor: pointer; }
.online-task-title > span { flex-shrink: 0; color: var(--ui-text-3); font-size: 10px; }
.online-task-title .is-active,.online-task-title .is-complete { color: var(--ui-accent); }
.online-task-source { display: inline-flex; align-items: center; gap: 3px; margin-top: 8px; padding: 0; border: 0; background: none; color: var(--ui-text-3); font-size: 10px; cursor: pointer; }
.online-task-source:hover { color: var(--ui-text); }
.online-task-menu { position: relative; }
.online-task-menu > summary { width: 30px; height: 30px; display: grid; place-items: center; padding: 0; list-style: none; border-radius: 7px; }
.online-task-menu > summary::-webkit-details-marker { display: none; }
.online-task-menu > summary:hover { background: var(--ui-hover); }
.online-task-menu > div { position: absolute; z-index: 3; right: 0; top: 34px; width: 154px; padding: 5px; border: 1px solid var(--ui-border); border-radius: 9px; background: var(--ui-surface); box-shadow: var(--ui-shadow); }
.online-task-menu > div button { width: 100%; display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 8px 10px; text-align: left; border: 0; border-radius: 5px; background: none; font-size: 12px; cursor: pointer; }
.online-task-menu > div button:hover { background: var(--ui-hover); }
.online-task-menu > div button:disabled { color: var(--ui-text-3); opacity: .6; cursor: not-allowed; }
.online-task-menu hr { height: 1px; margin: 5px 3px; border: 0; background: var(--ui-border); }
.online-task-menu .online-delete { color: var(--ui-danger); }
.online-task-progress { display: flex; align-items: center; gap: 11px; max-width: 430px; margin-top: 11px; }
.online-task-progress progress { flex: 1; width: 0; height: 3px; appearance: none; border: 0; border-radius: 3px; overflow: hidden; background: var(--ui-border); }
.online-task-progress progress::-webkit-progress-bar { background: var(--ui-border); border-radius: 3px; }
.online-task-progress progress::-webkit-progress-value { background: var(--ui-accent); border-radius: 3px; }
.online-task-progress small { color: var(--ui-text-3); font-size: 10px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.online-task-actions { display: flex; gap: 3px; align-items: center; }
.online-task-actions .secondary-command { padding-inline: 9px; font-size: 11.5px; }
.online-follow { display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 8px 10px; font-size: 12px; color: var(--ui-text); cursor: pointer; border-radius: 5px; }
.online-follow:hover { background: var(--ui-hover); }
.online-follow input { accent-color: var(--ui-accent); }
.online-failures { margin-top: 8px; }
.online-failures p { color: var(--ui-warning); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.online-settings header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
.online-settings h2 { margin: 0; }
.online-settings > label { display: block; color: var(--ui-text-2); font-size: 12px; margin: 15px 0 8px; }
.online-settings select { width: 100%; border-radius: 7px; border-color: var(--ui-border); color: var(--ui-text); background-color: var(--ui-surface); }
.online-settings small { display: block; margin-top: 9px; color: var(--ui-text-3); font-size: 11px; }
@media(max-width: 900px) { .online-result { gap: 5px; } .online-task { gap: 10px; } }
</style>
