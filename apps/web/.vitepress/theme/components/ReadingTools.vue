<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { AlignJustify, Check, Minus, Moon, Plus, Settings2, Sun, Type, X } from 'lucide-vue-next'
import { useRoute } from 'vitepress'

type Palette = 'light' | 'paper' | 'night'

const route = useRoute()
const open = ref(false)
const progress = ref(0)
const fontSize = ref(18)
const lineHeight = ref(2.05)
const palette = ref<Palette>('paper')
const isHome = computed(() => Boolean(route.data.frontmatter.libraryHome || route.data.frontmatter.bookHome || route.data.frontmatter.localLibrary))

const applySettings = () => {
  const root = document.documentElement
  root.style.setProperty('--reader-font-size', `${fontSize.value}px`)
  root.style.setProperty('--reader-line-height', String(lineHeight.value))
  root.dataset.readerPalette = palette.value
  localStorage.setItem('eternal-reader', JSON.stringify({ fontSize: fontSize.value, lineHeight: lineHeight.value, palette: palette.value }))
}

const updateProgress = () => {
  const scrollable = document.documentElement.scrollHeight - window.innerHeight
  progress.value = scrollable > 0 ? Math.min(100, Math.max(0, window.scrollY / scrollable * 100)) : 0
}

const setFontSize = (value: number) => { fontSize.value = Math.min(22, Math.max(15, value)); applySettings() }
const setLineHeight = (value: number) => { lineHeight.value = value; applySettings() }
const setPalette = (value: Palette) => { palette.value = value; applySettings() }

onMounted(() => {
  try {
    const stored = JSON.parse(localStorage.getItem('eternal-reader') || '{}')
    if (stored.fontSize) fontSize.value = stored.fontSize
    if (stored.lineHeight) lineHeight.value = stored.lineHeight
    if (stored.palette) palette.value = stored.palette
  } catch {
    // Ignore malformed local preferences and fall back to comfortable defaults.
  }
  applySettings()
  updateProgress()
  window.addEventListener('scroll', updateProgress, { passive: true })
})

onBeforeUnmount(() => window.removeEventListener('scroll', updateProgress))
watch(() => route.path, () => { open.value = false; nextTick(updateProgress) })
</script>

<template>
  <div v-if="!isHome" class="reading-progress" :style="{ '--progress': `${progress}%` }" />
  <div v-if="!isHome" class="reader-tools">
    <button class="reader-tools__trigger" type="button" :aria-expanded="open" aria-label="阅读设置" @click="open = !open"><X v-if="open" :size="20" /><Settings2 v-else :size="20" /></button>
    <Transition name="reader-panel">
      <div v-if="open" class="reader-panel">
        <div class="reader-panel__title"><span>阅读设置</span><small>偏好自动保存</small></div>
        <div class="reader-option">
          <label><Type :size="17" /> 字号</label>
          <div class="stepper"><button type="button" aria-label="减小字号" @click="setFontSize(fontSize - 1)"><Minus :size="16" /></button><output>{{ fontSize }}</output><button type="button" aria-label="增大字号" @click="setFontSize(fontSize + 1)"><Plus :size="16" /></button></div>
        </div>
        <div class="reader-option reader-option--stack">
          <label><AlignJustify :size="17" /> 行距</label>
          <div class="segment-control"><button v-for="item in [1.8, 2.05, 2.3]" :key="item" type="button" :class="{ active: lineHeight === item }" @click="setLineHeight(item)">{{ item === 1.8 ? '紧凑' : item === 2.05 ? '舒适' : '宽松' }}</button></div>
        </div>
        <div class="reader-option reader-option--stack">
          <label><Sun :size="17" /> 纸张</label>
          <div class="palette-control"><button v-for="item in ([['light', '素白'], ['paper', '宣纸'], ['night', '夜读']] as const)" :key="item[0]" type="button" :class="[`palette-${item[0]}`, { active: palette === item[0] }]" @click="setPalette(item[0])"><Moon v-if="item[0] === 'night'" :size="15" /><Check v-else-if="palette === item[0]" :size="15" /><span v-else class="palette-dot" />{{ item[1] }}</button></div>
        </div>
      </div>
    </Transition>
  </div>
</template>
