<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Check, ChevronRight, Copy, ExternalLink, RefreshCw, Type } from 'lucide-vue-next'
import { closeBrowserMenu, copyBrowserLink, initializeWebBrowser, webBrowser, webBrowserAction, zoomWebPage } from '../services/web-browser'
const error = ref('')
const zoomOpen = ref(false)
watch(() => webBrowser.value.menuOpen, () => { zoomOpen.value = false; clearTimeout(zoomTimer); clearTimeout(closeTimer); zoomTimer = undefined })
let closeTimer: ReturnType<typeof setTimeout> | undefined, zoomTimer: ReturnType<typeof setTimeout> | undefined
function keepMenu() { clearTimeout(closeTimer) }
function leaveMenu() { clearTimeout(closeTimer); closeTimer = setTimeout(() => { zoomOpen.value = false; void closeBrowserMenu() }, 160) }
function trackPointer(event: PointerEvent) {
  const element = event.target as Element
  if (element.closest('.browser-menu')) keepMenu(); else leaveMenu()
  if (element.closest('[data-zoom-trigger],.browser-zoom-menu')) { clearTimeout(zoomTimer); zoomTimer = undefined }
  else if (zoomOpen.value && !zoomTimer) zoomTimer = setTimeout(() => { zoomOpen.value = false; zoomTimer = undefined }, 120)
}
function outside(event: PointerEvent) { if (!(event.target as Element).closest('.browser-menu')) void closeBrowserMenu() }
async function run(work: () => Promise<unknown>) { try { await work(); await closeBrowserMenu() } catch (cause) { error.value = String(cause) } }
const keys = (event: KeyboardEvent) => { if (event.key === 'Escape') void closeBrowserMenu() }
onMounted(() => { void initializeWebBrowser(); window.addEventListener('keydown', keys); window.addEventListener('blur', closeBrowserMenu); document.addEventListener('pointerdown', outside, true) })
onBeforeUnmount(() => { window.removeEventListener('keydown', keys); window.removeEventListener('blur', closeBrowserMenu); document.removeEventListener('pointerdown', outside, true); clearTimeout(closeTimer); clearTimeout(zoomTimer) })
</script>
<template><div class="browser-menu-shell" @pointerleave="leaveMenu" @pointerenter="keepMenu" @pointermove="trackPointer"><div class="browser-menu" role="menu" aria-label="网页操作">
  <button type="button" role="menuitem" @click="run(() => webBrowserAction('reload'))"><RefreshCw :size="14" /><span>刷新</span><kbd>Ctrl+R</kbd></button>
  <button type="button" role="menuitem" @click="run(copyBrowserLink)"><Copy :size="14" /><span>复制链接</span></button>
  <button type="button" role="menuitem" data-zoom-trigger aria-haspopup="menu" :aria-expanded="zoomOpen" @pointerenter="zoomOpen = true" @keydown.right.prevent="zoomOpen = true" @keydown.left.prevent="zoomOpen = false"><Type :size="14" /><span>调整文字大小</span><kbd>{{ Math.round((webBrowser.zoomFactor || 1) * 100) }}%</kbd><ChevronRight :size="12" /></button>
  <div v-if="zoomOpen" class="browser-zoom-menu" role="menu" aria-label="调整文字大小">
    <button type="button" role="menuitem" @click="run(() => zoomWebPage('reset'))"><span>标准大小</span><Check v-if="Math.abs((webBrowser.zoomFactor || 1) - 1) < .01" :size="13" /></button>
    <button type="button" role="menuitem" :disabled="(webBrowser.zoomFactor || 1) <= .5" @click="run(() => zoomWebPage('out'))">缩小</button>
    <button type="button" role="menuitem" :disabled="(webBrowser.zoomFactor || 1) >= 2" @click="run(() => zoomWebPage('in'))">放大</button>
  </div>
  <hr />
  <button type="button" role="menuitem" @click="run(() => webBrowserAction('external'))"><ExternalLink :size="14" /><span>默认浏览器打开</span></button>
  <small v-if="error" role="alert">{{ error }}</small>
</div></div></template>
<style scoped>
.browser-menu-shell { position: relative; width: 100vw; height: 100vh; }
.browser-menu { position: absolute; top: 5px; right: 8px; width: 216px; padding: 7px; border: 1px solid var(--ui-border); border-radius: 7px; color: var(--ui-text); background: var(--ui-surface); box-shadow: 0 8px 24px rgb(0 0 0 / 16%); }
.browser-menu > button { display: flex; align-items: center; gap: 11px; width: 100%; height: 37px; padding: 0 12px; border: 0; border-radius: 4px; color: var(--ui-text); background: transparent; font-size: 12px; text-align: left; cursor: pointer; }
.browser-menu > button:hover,.browser-menu > button:focus-visible { background: var(--ui-hover); outline: 0; }
.browser-menu svg { color: var(--ui-text-2); flex-shrink: 0; }
.browser-menu span { flex: 1; }
.browser-menu kbd { color: var(--ui-text-3); font-size: 10px; font-family: inherit; white-space: nowrap; }
.browser-menu hr { height: 1px; margin: 6px 7px; border: 0; background: var(--ui-border); }
.browser-menu small { display: block; color: var(--ui-danger); font-size: 11px; }
.browser-zoom-menu { position: absolute; top: 78px; right: calc(100% + 5px); width: 126px; padding: 5px; border: 1px solid var(--ui-border); border-radius: 7px; color: var(--ui-text); background: var(--ui-surface); box-shadow: 0 8px 24px rgb(0 0 0 / 16%); animation: zoom-menu-in 120ms ease-out; }
.browser-zoom-menu > button { display: flex; align-items: center; justify-content: space-between; width: 100%; height: 31px; padding: 0 11px; border: 0; border-radius: 4px; background: transparent; color: inherit; text-align: left; font-size: 12px; cursor: pointer; }
.browser-zoom-menu > button:hover { background: var(--ui-hover); }
.browser-zoom-menu > button:disabled { opacity: .35; cursor: default; }
@keyframes zoom-menu-in { from { opacity: 0; transform: translateX(4px); } to { opacity: 1; transform: translateX(0); } }
</style>
