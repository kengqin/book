<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { Search, X } from 'lucide-vue-next'
import { formatChapterLabel } from '@novel-library/reader-core'
import type { DesktopChapterSummary } from '../services/desktop-library'

const props = defineProps<{ chapters: DesktopChapterSummary[]; current: number }>()
const emit = defineEmits<{ select: [number: number] }>()
const dialog = ref<HTMLDialogElement>()
const query = ref('')
const reversed = ref(false)
const visibleChapters = computed(() => {
  const term = query.value.trim().toLocaleLowerCase()
  const items = props.chapters.filter(item => `${formatChapterLabel(item)} ${item.title} ${item.volume}`.toLocaleLowerCase().includes(term))
  return reversed.value ? items.reverse() : items
})
function label(item: DesktopChapterSummary) {
  const prefix = formatChapterLabel(item)
  return prefix && prefix !== item.title ? `${prefix} ${item.title}` : item.title
}
async function locate() {
  query.value = ''
  await nextTick()
  dialog.value?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: 'center' })
}
function show() {
  dialog.value?.showModal()
  void locate()
}
function select(number: number) {
  dialog.value?.close()
  emit('select', number)
}
defineExpose({ show })
</script>

<template>
  <dialog ref="dialog" class="reader-catalogue" aria-labelledby="reader-catalogue-title" @click="event => { if (event.target === dialog) dialog?.close() }" @keydown.stop>
    <section class="reader-catalogue-surface">
      <header>
        <h2 id="reader-catalogue-title">目录 <small>共 {{ chapters.length }} 项</small></h2>
        <button class="catalogue-close" type="button" aria-label="关闭目录" @click="dialog?.close()"><X :size="18" /></button>
      </header>
      <div class="catalogue-tools">
        <label><Search :size="15" /><input v-model="query" autofocus placeholder="搜索章节或卷名" aria-label="搜索章节或卷名" /></label>
        <button type="button" @click="locate">当前章节</button>
        <button type="button" :aria-pressed="reversed" @click="reversed = !reversed">{{ reversed ? '恢复正序' : '倒序' }}</button>
      </div>
      <nav class="catalogue-list" aria-label="章节目录">
        <button v-for="item in visibleChapters" :key="item.number" type="button" :aria-current="item.number === current ? 'page' : undefined" :title="label(item)" @click="select(item.number)">
          <span>{{ label(item) }}</span><small v-if="item.number === current">正在阅读</small>
        </button>
        <p v-if="!visibleChapters.length" class="catalogue-empty">没有找到匹配的章节</p>
      </nav>
    </section>
  </dialog>
</template>

<style scoped>
.reader-catalogue { --catalogue-surface: #fff; --catalogue-accent: #a94b42; --catalogue-hover: rgba(80, 68, 52, .035); width: min(800px, calc(100vw - 64px)); max-width: none; max-height: none; padding: 0; border: 1px solid color-mix(in srgb, currentColor 9%, transparent); border-radius: 18px; color: inherit; background: var(--catalogue-surface); box-shadow: 0 24px 80px #0003; }
:global(.desktop-reader--paper .reader-catalogue) { --catalogue-surface: #faf8f1; }
:global(.desktop-reader--ivory .reader-catalogue) { --catalogue-surface: #faf8f2; }
:global(.desktop-reader--night .reader-catalogue) { --catalogue-surface: #202725; --catalogue-accent: #eeaaa0; --catalogue-hover: rgba(230, 235, 230, .045); }
.reader-catalogue::backdrop { background: #17171345; backdrop-filter: blur(2px); }
.reader-catalogue-surface { display: flex; flex-direction: column; height: min(720px, calc(100dvh - 100px)); }
header { display: flex; justify-content: space-between; gap: 20px; padding: 24px 26px 16px; }
h2 { display: flex; align-items: center; gap: 10px; margin: 0; font: inherit; font-size: 20px; font-weight: 650; }
h2 small { font-size: 12px; font-weight: 400; opacity: .55; }
button { color: inherit; cursor: pointer; font: inherit; }
.catalogue-close { align-self: flex-start; display: grid; place-items: center; width: 30px; height: 30px; border: 0; border-radius: 50%; background: color-mix(in srgb, currentColor 6%, transparent); }
.catalogue-tools { display: flex; align-items: center; gap: 8px; padding: 0 26px 18px; border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent); }
.catalogue-tools label { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; padding: 9px 10px; border: 1px solid color-mix(in srgb, currentColor 10%, transparent); border-radius: 8px; background: color-mix(in srgb, currentColor 2%, var(--catalogue-surface)); transition: border-color 150ms ease, box-shadow 150ms ease; }
input { width: 100%; min-width: 0; color: inherit; border: 0; outline: 0; background: transparent; font: inherit; font-size: 12px; }
.catalogue-tools button { flex-shrink: 0; padding: 8px 10px; border: 0; border-radius: 8px; background: transparent; font-size: 12px; }
.catalogue-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-content: start; gap: 0 24px; overflow-y: auto; overscroll-behavior: contain; padding: 8px 26px 24px; scrollbar-width: thin; }
.catalogue-list button { display: flex; align-items: center; gap: 8px; min-height: 49px; min-width: 0; padding: 12px 10px; text-align: left; border: 0; border-bottom: 1px solid color-mix(in srgb, currentColor 9%, transparent); background: transparent; font-size: 14px; }
.catalogue-list button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.catalogue-list button small { margin-left: auto; flex-shrink: 0; font-size: 10px; opacity: .65; }
.catalogue-list button[aria-current] { font-weight: 650; background: var(--ui-hover); border-bottom-color: transparent; border-radius: 8px; }
.catalogue-list button[aria-current] small { opacity: 1; }
button:hover { background: var(--ui-hover); }
button:focus-visible { outline: 2px solid color-mix(in srgb, currentColor 45%, var(--catalogue-surface)); outline-offset: -2px; }
.catalogue-tools label:focus-within { background: var(--ui-hover); border-color: color-mix(in srgb, currentColor 22%, var(--catalogue-surface)); box-shadow: 0 0 0 2px var(--ui-hover); }
.catalogue-empty { grid-column: 1 / -1; text-align: center; padding: 36px; opacity: .6; }
@media (max-width: 600px) { .catalogue-list { grid-template-columns: 1fr; } .catalogue-tools, header { padding-inline: 16px; } }
</style>
