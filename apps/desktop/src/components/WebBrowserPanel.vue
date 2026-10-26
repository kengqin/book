<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { ArrowLeft, ArrowRight, CircleEllipsis, Copy, Minus, RefreshCw, Search, Square, X } from 'lucide-vue-next'
import BrowserModeIcon from './BrowserModeIcon.vue'
import BrowserTabs from './BrowserTabs.vue'
import { browserAddressRequest, browserSideWidth, changeWebBrowserMode, closeBrowserMenu, closeWebBrowser, initializeWebBrowser, navigateWebPage, refreshWebBrowser, saveBrowserWidth, webBrowser, webBrowserAction } from '../services/web-browser'
const props = defineProps<{ standalone?: boolean }>()
const panel = ref<HTMLElement>(), surface = ref<HTMLElement>(), addressInput = ref<HTMLInputElement>(), addressForm = ref<HTMLFormElement>()
const address = ref(''), error = ref('')
const editing = ref(false), busy = ref(false), maximized = ref(false), resizing = ref(false), maximumWidth = ref(760)
let resize: ResizeObserver | undefined, dialogs: MutationObserver | undefined, interval: ReturnType<typeof setInterval> | undefined
let pageFocusListener: UnlistenFn | undefined
let frame = 0, alive = true, dragStart = 0, dragWidth = 0
const active = () => webBrowser.value.open && (props.standalone ? webBrowser.value.mode === 'window' : webBrowser.value.mode === 'side')
async function action(work: () => Promise<unknown>) { error.value = ''; try { await work() } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) } }
function limits() {
  if (props.standalone) return
  const available = panel.value?.parentElement?.clientWidth || innerWidth
  maximumWidth.value = Math.max(320, Math.min(760, Math.floor(innerWidth * .65), available - 280))
  browserSideWidth.value = Math.max(320, Math.min(maximumWidth.value, browserSideWidth.value))
}
function layout() {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(() => {
    if (!alive || !isTauri() || !active() || !surface.value) return
    limits()
    const r = surface.value.getBoundingClientRect()
    const visible = !resizing.value && !document.querySelector('dialog[open]') && r.width > 1 && r.height > 1
    void invoke('set_web_browser_bounds', { bounds: { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.max(1, r.width), height: Math.max(1, r.height) }, visible }).catch(cause => { if (alive) error.value = String(cause) })
  })
}
async function editAddress() { editing.value = true; address.value = webBrowser.value.url; await nextTick(); addressInput.value?.focus(); addressInput.value?.select() }
function dismissAddress() { editing.value = false }
function addressFocusOut(event: FocusEvent) {
  if (!addressForm.value?.contains(event.relatedTarget as Node | null)) dismissAddress()
}
function addressOutside(event: PointerEvent) {
  const target = event.target as Element
  if (webBrowser.value.menuOpen && !target.closest('.browser-tools')) void closeBrowserMenu()
  if (editing.value && !target.closest('.browser-address,.browser-tab-title,.browser-search')) dismissAddress()
}
async function navigate() { busy.value = true; await action(async () => { await navigateWebPage(address.value); editing.value = false }); busy.value = false }
function more(event: MouseEvent) {
  const r = (event.currentTarget as HTMLElement).getBoundingClientRect()
  void action(async () => {
    const area = surface.value?.getBoundingClientRect()
    if (!area) return
    await invoke('set_web_browser_bounds', { bounds: { x: Math.max(0, area.x), y: Math.max(0, area.y), width: Math.max(1, area.width), height: Math.max(1, area.height) }, visible: true })
    await invoke('show_web_browser_menu', { x: Math.max(0, r.right - 368), y: r.bottom + 1 })
  })
}
function drag(event: PointerEvent) {
  if (event.button !== 0) return
  limits(); dragStart = event.clientX; dragWidth = browserSideWidth.value; resizing.value = true
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  document.documentElement.style.cursor = 'col-resize'; document.documentElement.style.userSelect = 'none'; layout()
}
function move(event: PointerEvent) { if (resizing.value) browserSideWidth.value = Math.max(320, Math.min(maximumWidth.value, dragWidth + dragStart - event.clientX)) }
function stopDrag() { if (!resizing.value) return; resizing.value = false; saveBrowserWidth(browserSideWidth.value); document.documentElement.style.removeProperty('cursor'); document.documentElement.style.removeProperty('user-select'); layout() }
function resizeKey(event: KeyboardEvent) {
  limits()
  const width = event.key === 'Home' ? 320 : event.key === 'End' ? maximumWidth.value : browserSideWidth.value + (event.key === 'ArrowLeft' ? 24 : event.key === 'ArrowRight' ? -24 : 0)
  if (width !== browserSideWidth.value) { event.preventDefault(); saveBrowserWidth(Math.max(320, Math.min(maximumWidth.value, width))) }
}
function startDragging(event: MouseEvent) { if (props.standalone && event.button === 0 && !(event.target as Element).closest('button,input,form,.browser-tabs')) void action(() => getCurrentWindow().startDragging()) }
async function maximize() { await getCurrentWindow().toggleMaximize(); maximized.value = await getCurrentWindow().isMaximized() }
function keys(event: KeyboardEvent) {
  if (event.key === 'Escape' && webBrowser.value.menuOpen) { event.preventDefault(); void closeBrowserMenu(); return }
  if (event.key === 'Escape' && editing.value) { editing.value = false; return }
  if (!active() || !(event.ctrlKey || event.metaKey)) return
  if (event.key.toLowerCase() === 'l') { event.preventDefault(); void editAddress() }
  if (event.key.toLowerCase() === 'r') { event.preventDefault(); void action(() => webBrowserAction('reload')) }
}
watch(browserAddressRequest, () => { if (active()) void editAddress() })
watch(() => webBrowser.value.activeTab, dismissAddress)
watch([() => webBrowser.value.open, () => webBrowser.value.mode, () => webBrowser.value.url, () => webBrowser.value.activeTab, () => webBrowser.value.sideSuspended, error, resizing], () => { void nextTick(layout) })
onMounted(async () => {
  await action(initializeWebBrowser); if (!alive) return
  if (isTauri()) {
    const unlisten = await listen('web-browser-page-focused', dismissAddress)
    if (!alive) { unlisten(); return }
    pageFocusListener = unlisten
  }
  limits(); resize = new ResizeObserver(layout); if (surface.value) resize.observe(surface.value)
  dialogs = new MutationObserver(layout); dialogs.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] })
  window.addEventListener('resize', layout); window.addEventListener('keydown', keys); window.addEventListener('blur', dismissAddress)
  document.addEventListener('pointerdown', addressOutside, true)
  interval = setInterval(() => { if (active()) void refreshWebBrowser().catch(() => {}) }, 850); layout()
})
onBeforeUnmount(() => {
  alive = false; resize?.disconnect(); dialogs?.disconnect(); clearInterval(interval); cancelAnimationFrame(frame); stopDrag()
  pageFocusListener?.()
  window.removeEventListener('resize', layout); window.removeEventListener('keydown', keys); window.removeEventListener('blur', dismissAddress)
  document.removeEventListener('pointerdown', addressOutside, true)
  if (!props.standalone && isTauri()) void invoke('set_web_browser_bounds', { bounds: { x: 0, y: 0, width: 1, height: 1 }, visible: false }).catch(() => {})
})
</script>
<template>
  <section ref="panel" class="web-browser-panel" :class="{ 'web-browser-panel--side': !standalone, 'is-resizing': resizing }" :style="!standalone ? { width: `${browserSideWidth}px` } : undefined" aria-label="内置网页浏览器">
    <div v-if="!standalone" class="browser-splitter" role="separator" tabindex="0" aria-label="调整网页侧栏宽度" aria-orientation="vertical" :aria-valuenow="browserSideWidth" :aria-valuemin="320" :aria-valuemax="maximumWidth" @pointerdown.prevent="drag" @pointermove="move" @pointerup="stopDrag" @pointercancel="stopDrag" @lostpointercapture="stopDrag" @keydown="resizeKey" />
    <header class="web-browser-toolbar" :class="{ 'is-editing': editing }" @mousedown="startDragging" @dblclick.self="standalone && action(maximize)">
      <div v-if="standalone" class="browser-navigation">
        <button type="button" class="browser-icon" aria-label="后退" title="后退" :disabled="!webBrowser.canGoBack" @click="action(() => webBrowserAction('back'))"><ArrowLeft :size="15" /></button>
        <button type="button" class="browser-icon" aria-label="前进" title="前进" :disabled="!webBrowser.canGoForward" @click="action(() => webBrowserAction('forward'))"><ArrowRight :size="15" /></button>
        <button type="button" class="browser-icon" :aria-label="webBrowser.loading ? '停止加载' : '刷新网页'" :title="webBrowser.loading ? '停止加载' : '刷新网页'" @click="action(() => webBrowserAction(webBrowser.loading ? 'stop' : 'reload'))"><X v-if="webBrowser.loading" :size="15" /><RefreshCw v-else :size="14" /></button>
      </div>
      <BrowserTabs :compact="!standalone" @edit="editAddress" />
      <form v-if="editing" ref="addressForm" class="browser-address" @submit.prevent="navigate" @focusout="addressFocusOut"><Search :size="14" /><input ref="addressInput" v-model="address" aria-label="网址或搜索关键词" placeholder="搜索，或输入网址" :disabled="busy" /><button type="submit" class="browser-icon" aria-label="前往" :disabled="busy"><ArrowRight :size="14" /></button></form>
      <button v-else-if="standalone" type="button" class="browser-search browser-icon" aria-label="输入网址或搜索" title="输入网址或搜索" @click="editAddress"><Search :size="15" /></button>
      <div class="browser-toolbar-space" @dblclick="standalone && action(maximize)" />
      <div class="browser-tools">
        <button type="button" class="browser-icon" :aria-label="standalone ? '侧边打开' : '独立窗口打开'" :title="standalone ? '侧边打开' : '独立窗口打开'" @click="action(() => changeWebBrowserMode(standalone ? 'side' : 'window'))"><BrowserModeIcon :docked="!standalone" /></button>
        <button type="button" class="browser-icon" aria-label="网页更多操作" title="更多" :aria-expanded="Boolean(webBrowser.menuOpen)" @click="more"><CircleEllipsis :size="18" :stroke-width="1.5" /></button>
      </div>
      <div v-if="standalone" class="browser-window-controls"><button type="button" aria-label="最小化" title="最小化" @click="action(() => getCurrentWindow().minimize())"><Minus :size="14" /></button><button type="button" :aria-label="maximized ? '还原' : '最大化'" :title="maximized ? '还原' : '最大化'" @click="action(maximize)"><Copy v-if="maximized" :size="12" /><Square v-else :size="12" /></button><button type="button" class="browser-window-close" aria-label="关闭窗口" title="关闭" @click="action(closeWebBrowser)"><X :size="16" /></button></div>
    </header>
    <div v-if="webBrowser.loading" class="browser-progress" aria-label="网页加载中"><span /></div>
    <div v-if="error" class="browser-error" role="alert"><span>{{ error }}</span><button type="button" class="browser-icon" aria-label="关闭提示" @click="error = ''"><X :size="13" /></button></div>
    <div ref="surface" class="web-browser-surface" />
  </section>
</template>
<style scoped>
.web-browser-panel { position: relative; display: flex; flex-direction: column; min-height: 0; height: 100%; color: var(--ui-text); background: var(--ui-surface); }
.web-browser-panel--side { flex: 0 0 auto; margin-left: 4px; border: 1px solid var(--ui-border); border-radius: 8px; animation: browser-side-in 160ms ease-out; }
.browser-splitter { position: absolute; top: 0; bottom: 0; left: -5px; width: 4px; cursor: col-resize; touch-action: none; outline: none; }
.browser-splitter::after { content: ''; position: absolute; top: 0; bottom: 0; left: 1px; width: 2px; border-radius: 2px; background: var(--ui-accent); opacity: 0; transition: opacity 130ms; }
.browser-splitter:hover::after,.browser-splitter:focus-visible::after,.is-resizing .browser-splitter::after { opacity: .55; }
.web-browser-toolbar { display: flex; align-items: center; gap: 5px; height: 42px; min-height: 42px; padding: 0 8px; border-bottom: 1px solid var(--ui-border); border-radius: inherit; background: var(--ui-titlebar-background, var(--ui-surface-2)); user-select: none; }
.browser-navigation,.browser-tools { display: flex; align-items: center; gap: 1px; flex-shrink: 0; }
.browser-icon { display: inline-grid; place-items: center; width: 27px; height: 28px; padding: 0; color: var(--ui-text-2); border: 0; border-radius: 5px; background: transparent; cursor: pointer; }
.browser-icon:hover { background: var(--ui-hover); }
.browser-icon:disabled { opacity: .3; cursor: default; }
.browser-tab { display: flex; align-items: center; gap: 6px; width: 224px; min-width: 70px; height: 28px; padding: 0 7px 0 9px; border: 1px solid var(--ui-border); border-radius: 5px; background: var(--ui-surface); }
.browser-tab > svg { flex-shrink: 0; color: var(--ui-accent); }
.browser-tab-title { flex: 1; min-width: 0; padding: 0; border: 0; background: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ui-text-2); text-align: left; font-size: 11px; cursor: text; }
.browser-tab-close { display: grid; place-items: center; width: 16px; height: 16px; flex-shrink: 0; padding: 0; border: 1px solid color-mix(in srgb,var(--ui-text-3) 55%,transparent); border-radius: 50%; background: none; color: var(--ui-text-2); cursor: pointer; }
.browser-tab-close:hover { color: var(--ui-text); background: var(--ui-hover); }
.browser-search { position: relative; margin-left: 8px; border: 0; border-radius: 5px; }
.browser-search::before { content: ''; position: absolute; left: -7px; top: 6px; bottom: 6px; width: 1px; background: var(--ui-border); pointer-events: none; }
.browser-address { display: flex; align-items: center; gap: 6px; width: 320px; min-width: 110px; height: 28px; padding: 0 5px 0 9px; border: 1px solid var(--ui-accent); border-radius: 5px; background: var(--ui-surface); }
.browser-address > svg { flex-shrink: 0; color: var(--ui-text-3); }
.browser-address input { flex: 1; min-width: 0; width: 0; height: 24px; padding: 0; border: 0; outline: 0; box-shadow: none; background: transparent; color: var(--ui-text); font-size: 11px; }
.browser-toolbar-space { flex: 1; min-width: 8px; align-self: stretch; }
.browser-window-controls { display: flex; align-self: stretch; margin-right: -8px; margin-left: 1px; }
.browser-window-controls > button { display: grid; place-items: center; width: 38px; border: 0; background: none; color: var(--ui-text-2); cursor: pointer; }
.browser-window-controls > button:hover { background: var(--ui-hover); }
.browser-window-controls > .browser-window-close:hover { color: white; background: #c42b1c; }
.web-browser-surface { flex: 1; min-height: 1px; background: white; }
.browser-progress { position: absolute; top: 41px; z-index: 1; left: 0; right: 0; height: 2px; overflow: hidden; }
.browser-progress span { display: block; width: 28%; height: 100%; background: var(--ui-accent); animation: browser-progress 1.2s ease-in-out infinite; }
.browser-error { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 12px; font-size: 12px; color: var(--ui-danger); background: var(--ui-surface-2); }
.browser-error span { overflow-wrap: anywhere; }
.web-browser-panel--side .web-browser-toolbar { gap: 8px; height: 46px; min-height: 46px; padding-inline: 12px; border-radius: 7px 7px 0 0; background: var(--ui-surface); }
.web-browser-panel--side .web-browser-surface { margin: 0 0 4px 4px; }
.web-browser-panel--side .browser-progress { top: 45px; left: 4px; right: 4px; }
.web-browser-panel--side .browser-toolbar-space { display: block; }
.web-browser-panel--side .is-editing :deep(.browser-tabs) { display: none; }
.web-browser-panel--side .browser-address { flex: 1; width: 0; min-width: 70px; }
@keyframes browser-progress { from { transform: translateX(-110%); } to { transform: translateX(450%); } }
@keyframes browser-side-in { from { opacity: 0; transform: translateX(12px); } to { opacity: 1; transform: translateX(0); } }
@media(max-width: 850px) { .browser-tab { width: 180px; } .browser-address { width: 240px; } .is-editing .browser-tab { display: none; } }
@media(prefers-reduced-motion: reduce) { .web-browser-panel--side,.browser-progress span { animation: none; } }
</style>
