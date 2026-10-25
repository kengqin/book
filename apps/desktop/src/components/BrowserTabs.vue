<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ChevronLeft, ChevronRight, Globe2, RefreshCw, X } from 'lucide-vue-next'
import { closeBrowserTab, selectBrowserTab, webBrowser, type WebBrowserTab } from '../services/web-browser'
import { showGlobalError } from '../services/global-message'
const props = defineProps<{ compact?: boolean }>()
const emit = defineEmits<{ edit: [] }>()
const root = ref<HTMLElement>(), viewport = ref<HTMLElement>()
const tabs = computed(() => webBrowser.value.tabs || [])
const maximum = computed(() => props.compact ? 196 : 224)
const width = ref(196), overflowing = ref(false), left = ref(false), right = ref(false)
const failedIcons = ref<Record<number,string>>({})
let observer: ResizeObserver | undefined
const title = (tab: WebBrowserTab) => tab.title || new URL(tab.url).hostname
function edges() { const v = viewport.value; if (v) { left.value = v.scrollLeft > 1; right.value = v.scrollLeft + v.clientWidth < v.scrollWidth - 1 } }
function revealActive() { viewport.value?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }
function layout() {
  const available = root.value?.clientWidth || maximum.value, count = tabs.value.length || 1
  overflowing.value = count * 36 + 16 + (count-1)*2 > available
  width.value = Math.min(maximum.value - 16, Math.max(36, (available - (overflowing.value ? 36 : 0) - 16 - (count-1)*2) / count))
  void nextTick(edges)
}
function scroll(amount: number) { viewport.value?.scrollBy({ left: amount, behavior: 'smooth' }) }
function wheel(event: WheelEvent) { if (overflowing.value) { event.preventDefault(); scroll(Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) } }
async function choose(tab: WebBrowserTab) {
  if (tab.id === webBrowser.value.activeTab) { emit('edit'); return }
  try { await selectBrowserTab(tab.id) } catch (cause) { showGlobalError(cause, '网页切换失败') }
}
async function close(id: number) { try { await closeBrowserTab(id) } catch (cause) { showGlobalError(cause, '网页关闭失败') } }
function keys(event: KeyboardEvent) {
  if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return
  event.preventDefault()
  const index = tabs.value.findIndex(tab => tab.id === webBrowser.value.activeTab)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.value.length-1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.value.length) % tabs.value.length
  const tab = tabs.value[next]; if (tab) void selectBrowserTab(tab.id).catch(cause => showGlobalError(cause, '网页切换失败'))
}
watch([() => webBrowser.value.activeTab, () => tabs.value.length, () => props.compact], async () => {
  await nextTick(); layout(); await nextTick()
  revealActive()
})
onMounted(() => { observer = new ResizeObserver(() => { layout(); void nextTick(revealActive) }); if (root.value) observer.observe(root.value); layout() })
onBeforeUnmount(() => observer?.disconnect())
</script>
<template>
  <div ref="root" class="browser-tabs" :class="{ 'has-overflow': overflowing, 'is-compact': compact, 'is-condensed': width < 72 }" :style="{ flexBasis: `${tabs.length * maximum}px`, '--browser-tab-width': `${width}px`, '--browser-tab-max': `${maximum}px` }" @wheel="wheel">
    <button v-if="overflowing" type="button" class="browser-tabs-arrow" aria-label="向左滚动标签" :disabled="!left" @click="scroll(-120)"><ChevronLeft :size="13" /></button>
    <div ref="viewport" class="browser-tabs-viewport" role="tablist" aria-label="网页标签" @scroll="edges" @keydown="keys">
      <div v-for="tab in tabs" :key="tab.id" class="browser-tab" :class="{ 'is-active': tab.id === webBrowser.activeTab }" :data-tab-id="tab.id" :title="title(tab)" data-tooltip-variant="page-title" @click="choose(tab)">
        <RefreshCw v-if="tab.loading" :size="14" class="spinning" />
        <img v-else-if="tab.favicon && failedIcons[tab.id] !== tab.favicon" :src="tab.favicon" alt="" draggable="false" referrerpolicy="no-referrer" @error="failedIcons[tab.id] = tab.favicon" />
        <Globe2 v-else :size="14" />
        <button type="button" class="browser-tab-title" role="tab" :aria-label="title(tab)" :aria-selected="tab.id === webBrowser.activeTab" :tabindex="tab.id === webBrowser.activeTab ? 0 : -1" @click.stop="choose(tab)">{{ title(tab) }}</button>
        <button type="button" class="browser-tab-close" :aria-label="tab.id === webBrowser.activeTab ? '关闭网页' : `关闭网页：${title(tab)}`" title="关闭网页" @click.stop="close(tab.id)"><X :size="11" /></button>
      </div>
    </div>
    <button v-if="overflowing" type="button" class="browser-tabs-arrow" aria-label="向右滚动标签" :disabled="!right" @click="scroll(120)"><ChevronRight :size="13" /></button>
  </div>
</template>
<style scoped>
.browser-tabs { display: flex; align-items: center; flex: 0 1 auto; min-width: 52px; height: 30px; position: relative; }
.browser-tabs.is-compact::after { content: ''; position: absolute; right: -6px; top: 7px; bottom: 7px; width: 1px; background: var(--ui-border); pointer-events: none; }
.browser-tabs-viewport { display: flex; align-items: center; gap: 2px; flex: 1; min-width: 0; height: 30px; overflow: hidden; scroll-behavior: smooth; }
.browser-tab { position: relative; display: flex; align-items: center; gap: 4px; flex: 0 0 var(--browser-tab-width); min-width: 36px; height: 28px; padding: 0 5px; border: 1px solid color-mix(in srgb,var(--ui-border) 65%,transparent); border-radius: 4px; background: var(--ui-surface-2); color: var(--ui-text-2); }
.browser-tab.is-active { flex-basis: min(var(--browser-tab-max),calc(var(--browser-tab-width) + 16px)); border-color: var(--ui-border); background: var(--ui-surface); }
.browser-tab > svg,.browser-tab > img { width: 14px; height: 14px; flex: 0 0 14px; object-fit: contain; }
.browser-tab > svg { color: var(--ui-accent); }
.browser-tab-title { flex: 1; min-width: 0; padding: 0; border: 0; background: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: inherit; text-align: left; font-size: 11px; cursor: pointer; }
.browser-tab-close { position: absolute; right: 4px; display: grid; place-items: center; width: 15px; height: 15px; padding: 0; border: 1px solid color-mix(in srgb,var(--ui-text-3) 55%,transparent); border-radius: 50%; background: var(--ui-surface); color: var(--ui-text-2); opacity: 0; pointer-events: none; cursor: pointer; }
.browser-tab.is-active .browser-tab-close { position: static; flex: 0 0 15px; opacity: 1; pointer-events: auto; }
.browser-tab:hover .browser-tab-close,.browser-tab:focus-within .browser-tab-close { opacity: 1; pointer-events: auto; }
.browser-tabs.is-condensed .browser-tab:not(.is-active) .browser-tab-close { display: none; }
.browser-tab-close:hover { color: var(--ui-text); background: var(--ui-hover); }
.browser-tabs-arrow { display: grid; place-items: center; flex: 0 0 18px; height: 26px; padding: 0; border: 0; border-radius: 4px; color: var(--ui-text-2); background: transparent; cursor: pointer; }
.browser-tabs-arrow:hover:not(:disabled) { background: var(--ui-hover); }
.browser-tabs-arrow:disabled { opacity: .3; cursor: default; }
</style>
