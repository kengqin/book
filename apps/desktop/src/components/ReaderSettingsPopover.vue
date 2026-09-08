<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { Eye, Minus, Plus, Settings2, X } from 'lucide-vue-next'

const emit = defineEmits<{ privacy: [] }>()

const fontSize = defineModel<number>('fontSize', { required: true })
const lineHeight = defineModel<number>('lineHeight', { required: true })
const palette = defineModel<'light' | 'paper' | 'night'>('palette', { required: true })
const open = ref(false)
const dock = ref<HTMLElement>()
const panel = ref<HTMLElement>()
const trigger = ref<HTMLButtonElement>()

function close(restoreFocus = false) {
  open.value = false
  if (restoreFocus) trigger.value?.focus()
}

function enterPrivacy() {
  close()
  emit('privacy')
}

async function toggle() {
  if (open.value) return close()
  open.value = true
  await nextTick()
  panel.value?.focus()
}

function dismissOutside(event: PointerEvent) {
  if (event.target instanceof Node && !dock.value?.contains(event.target)) close()
}

function handleKeydown(event: KeyboardEvent) {
  if (!open.value) return
  event.stopPropagation()
  if (event.key === 'Escape') {
    event.preventDefault()
    close(true)
  }
}

function handleFocusout(event: FocusEvent) {
  if (event.relatedTarget instanceof Node && !dock.value?.contains(event.relatedTarget)) close()
}

onMounted(() => document.addEventListener('pointerdown', dismissOutside))
onBeforeUnmount(() => document.removeEventListener('pointerdown', dismissOutside))
</script>

<template>
  <div ref="dock" class="reader-settings-dock" @keydown="handleKeydown" @focusout="handleFocusout">
    <section v-if="open" id="reader-settings-panel" ref="panel" class="reader-settings-panel" role="dialog" aria-label="阅读设置" tabindex="-1">
      <header><strong>阅读设置</strong><button type="button" class="reader-settings-close" aria-label="关闭阅读设置" @click="close(true)"><X :size="15" /></button></header>
      <div class="reader-setting-row">
        <span id="reader-font-label">字号</span>
        <div class="reader-setting-stepper" role="group" aria-labelledby="reader-font-label">
          <button type="button" aria-label="减小字号" :disabled="fontSize <= 15" @click="fontSize = Math.max(15, fontSize - 1)"><Minus :size="14" /></button>
          <output aria-live="polite">{{ fontSize }}</output>
          <button type="button" aria-label="增大字号" :disabled="fontSize >= 26" @click="fontSize = Math.min(26, fontSize + 1)"><Plus :size="14" /></button>
        </div>
      </div>
      <div class="reader-setting-row">
        <span id="reader-spacing-label">行距</span>
        <div class="reader-setting-segments" role="group" aria-labelledby="reader-spacing-label">
          <button v-for="item in ([['紧', 1.8], ['中', 2.05], ['松', 2.3]] as const)" :key="item[0]" type="button" :aria-pressed="lineHeight === item[1]" @click="lineHeight = item[1]">{{ item[0] }}</button>
        </div>
      </div>
      <div class="reader-setting-row">
        <span id="reader-palette-label">纸张</span>
        <div class="reader-setting-segments" role="group" aria-labelledby="reader-palette-label">
          <button v-for="item in ([['light', '白色'], ['paper', '纸色'], ['night', '夜间']] as const)" :key="item[0]" type="button" :aria-pressed="palette === item[0]" @click="palette = item[0]">{{ item[1] }}</button>
        </div>
      </div>
    </section>
    <button type="button" class="reader-settings-trigger reader-privacy-trigger" title="进入隐私模式" aria-label="进入隐私模式" @click="enterPrivacy"><Eye :size="19" /></button>
    <button ref="trigger" type="button" class="reader-settings-trigger" title="阅读设置" aria-label="阅读设置" aria-haspopup="dialog" aria-controls="reader-settings-panel" :aria-expanded="open" @click="toggle"><Settings2 :size="19" /></button>
  </div>
</template>

<style scoped>
.reader-settings-dock { --settings-surface: #fff; position: fixed; z-index: 10; right: 24px; bottom: 20px; display: grid; gap: 8px; color: inherit; }
:global(.desktop-reader--paper .reader-settings-dock) { --settings-surface: #f6f2e8; }
:global(.desktop-reader--night .reader-settings-dock) { --settings-surface: #202725; }
.reader-settings-trigger { width: 38px; height: 38px; display: grid; place-items: center; border: 1px solid color-mix(in srgb, currentColor 12%, transparent); border-radius: 12px; box-shadow: 0 4px 16px #0000000c; }
.reader-settings-panel { position: absolute; right: 0; bottom: 96px; width: 280px; max-width: calc(100vw - 48px); max-height: calc(100dvh - 176px); display: grid; gap: 15px; overflow-y: auto; padding: 16px; border: 1px solid color-mix(in srgb, currentColor 12%, transparent); border-radius: 14px; background: var(--settings-surface); box-shadow: 0 12px 38px #00000020; outline: none; }
.reader-settings-panel header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px; }
.reader-settings-panel strong { font-size: 13px; font-weight: 650; }
.reader-setting-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.reader-setting-row > span { flex-shrink: 0; font-size: 12px; opacity: .7; }
.reader-settings-dock button { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; color: inherit; background: var(--settings-surface); cursor: pointer; }
.reader-settings-dock button:hover:not(:disabled), .reader-settings-trigger[aria-expanded="true"] { background: color-mix(in srgb, currentColor 8%, var(--settings-surface)); }
.reader-settings-dock button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.reader-settings-close { width: 25px; height: 25px; padding: 0; border: 0; border-radius: 6px; }
.reader-setting-segments, .reader-setting-stepper { display: flex; align-items: center; gap: 3px; padding: 3px; border-radius: 9px; background: color-mix(in srgb, currentColor 5%, transparent); }
.reader-setting-segments button, .reader-setting-stepper button { min-width: 32px; height: 28px; padding: 0 9px; border: 0; border-radius: 6px; background: transparent; font-size: 11px; }
.reader-setting-segments button[aria-pressed="true"] { background: var(--settings-surface); box-shadow: 0 1px 4px #00000014; font-weight: 650; }
.reader-setting-stepper output { min-width: 27px; text-align: center; font-size: 12px; font-variant-numeric: tabular-nums; }
.reader-setting-stepper button { padding-inline: 6px; }
.reader-setting-stepper button:disabled { opacity: .3; cursor: default; }
</style>
