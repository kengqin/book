<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Code2, Ellipsis, Globe, Globe2, LibraryBig, NotebookPen, Search, Settings } from 'lucide-vue-next'
import { openSettingsWindow } from '../../services/settings-window'
import { showGlobalError } from '../../services/global-message'
import { openWebPage } from '../../services/web-browser'

defineProps<{
  hasUpdate?: boolean
}>()

const route = useRoute(), router = useRouter()
const categories = [
  { to: '/library', label: '书架', icon: LibraryBig },
  { to: '/search', label: '搜索', icon: Search },
  { to: '/online', label: '在线找书', icon: Globe },
  { to: '/tools/notes', label: '本地笔记', icon: NotebookPen },
  { to: '/tools/ide-integration', label: 'IDE 插件', icon: Code2 }
]
const primaryCategories = categories.slice(0, 5)
const extraCategories = categories.slice(5)
const moreOpen = ref(false), moreAnchor = ref<HTMLElement>(), moreMenu = ref<HTMLElement>()
const menuPosition = ref({ left: '52px', top: '0px' })
const moreActive = computed(() => moreOpen.value || route.path === '/tools' || extraCategories.some(category => route.path.startsWith(category.to)))
let openTimer: ReturnType<typeof setTimeout> | undefined, closeTimer: ReturnType<typeof setTimeout> | undefined
function clearTimers() { clearTimeout(openTimer); clearTimeout(closeTimer) }
function keepOpen() { clearTimeout(closeTimer) }
function closeMore(restoreFocus = false) {
  clearTimers(); moreOpen.value = false
  if (restoreFocus) moreAnchor.value?.querySelector('button')?.focus()
}
async function openMore(focus = false) {
  clearTimers()
  const anchor = moreAnchor.value?.getBoundingClientRect()
  if (!anchor) return
  menuPosition.value = { left: `${anchor.right + 4}px`, top: `${Math.min(anchor.top, innerHeight - (extraCategories.length + 1) * 36 - 20)}px` }
  moreOpen.value = true
  await nextTick()
  if (focus) moreMenu.value?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
}
function scheduleOpen() { keepOpen(); clearTimeout(openTimer); openTimer = setTimeout(() => void openMore(), 80) }
function scheduleClose() { clearTimers(); closeTimer = setTimeout(() => closeMore(), 160) }
function outside(event: PointerEvent) {
  const target = event.target as Node
  if (!moreAnchor.value?.contains(target) && !moreMenu.value?.contains(target)) closeMore()
}
function menuKeys(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); closeMore(true); return }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const items = [...moreMenu.value!.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  const index = items.indexOf(document.activeElement as HTMLElement)
  items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
}
function navigate(to: string) { closeMore(); void router.push(to) }
function browse() { closeMore(); void openWebPage('https://cn.bing.com/').catch(cause => showGlobalError(cause, '网页打开失败')) }
const closeOnBlur = () => closeMore()
watch(() => route.fullPath, () => closeMore())
onMounted(() => { document.addEventListener('pointerdown', outside, true); window.addEventListener('blur', closeOnBlur); window.addEventListener('resize', closeOnBlur) })
onBeforeUnmount(() => { clearTimers(); document.removeEventListener('pointerdown', outside, true); window.removeEventListener('blur', closeOnBlur); window.removeEventListener('resize', closeOnBlur) })
</script>

<template>
  <aside class="app-sidebar app-sidebar--collapsed">
    <nav id="sidebar-navigation" class="sidebar-primary" aria-label="主导航">
      <RouterLink v-for="category in primaryCategories" :key="category.to" :to="category.to" :title="category.label" :aria-label="category.label"><component :is="category.icon" :size="18" :stroke-width="1.65" /><span>{{ category.label }}</span></RouterLink>
      <div ref="moreAnchor" class="sidebar-more" @pointerenter="scheduleOpen" @pointerleave="scheduleClose">
        <button type="button" class="sidebar-more-trigger" :class="{ 'is-active': moreActive }" aria-label="更多" aria-haspopup="menu" :aria-expanded="moreOpen" @click="openMore(true)" @keydown.down.prevent="openMore(true)" @keydown.esc.stop="closeMore(true)"><Ellipsis :size="20" :stroke-width="1.65" /></button>
      </div>
    </nav>

    <nav class="sidebar-secondary" aria-label="应用设置">
      <button type="button" title="设置" aria-label="设置" @click="openSettingsWindow().catch(cause => showGlobalError(cause, '设置打开失败'))"><Settings :size="18" :stroke-width="1.65" /><span>设置</span><i v-if="hasUpdate" class="update-badge" /></button>
    </nav>
  </aside>
  <Teleport to="body">
    <Transition name="sidebar-more">
      <div v-if="moreOpen" ref="moreMenu" class="sidebar-more-menu" :style="menuPosition" role="menu" aria-label="更多功能" @pointerenter="keepOpen" @pointerleave="scheduleClose" @keydown="menuKeys" @focusout="event => { if (!moreMenu?.contains(event.relatedTarget as Node)) closeMore() }">
        <button v-for="category in extraCategories" :key="category.to" type="button" role="menuitem" @click="navigate(category.to)"><component :is="category.icon" :size="17" /><span>{{ category.label }}</span></button>
        <button type="button" role="menuitem" @click="browse"><Globe2 :size="17" /><span>网页浏览</span></button>
      </div>
    </Transition>
  </Teleport>
</template>
<style scoped>
.sidebar-more-trigger { border: 0; background: transparent; cursor: pointer; }
.sidebar-more-trigger.is-active { color: var(--ui-text); background: var(--ui-selected); }
.sidebar-more-menu { position: fixed; z-index: 10010; width: 208px; padding: 5px; border: 1px solid var(--ui-border); border-radius: 12px; background: var(--ui-surface); box-shadow: 0 6px 20px rgb(0 0 0 / 10%); transform-origin: left top; }
.sidebar-more-menu > button { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 36px; padding: 0 10px; border: 0; border-radius: 8px; color: var(--ui-text); background: transparent; text-align: left; font-size: 12px; cursor: pointer; }
.sidebar-more-menu > button:hover,.sidebar-more-menu > button:focus-visible { background: var(--ui-hover); outline: 0; }
.sidebar-more-menu svg { flex-shrink: 0; color: var(--ui-text-2); }
.sidebar-more-enter-active,.sidebar-more-leave-active { transition: opacity 130ms ease-out, transform 130ms ease-out; }
.sidebar-more-enter-from,.sidebar-more-leave-to { opacity: 0; transform: translateX(-4px) scale(.98); }
@media (prefers-reduced-motion: reduce) { .sidebar-more-enter-active,.sidebar-more-leave-active { transition: none; } }
</style>
