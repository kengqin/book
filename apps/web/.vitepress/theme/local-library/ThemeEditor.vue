<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Check, ImagePlus, X } from 'lucide-vue-next'
import type { LocalBook, ThemeSettings } from './types'
import { getThemePreset, themePresets } from './themes'

const props = defineProps<{ open: boolean; book?: LocalBook; coverUrl?: string }>()
const emit = defineEmits<{ close: []; save: [theme: ThemeSettings, cover?: Blob] }>()
const draft = ref<ThemeSettings>({ ...getThemePreset('ink').settings })
const cover = ref<Blob>()
const customUrl = ref('')

watch(() => props.open, open => {
  if (!open || !props.book) return
  draft.value = { ...props.book.theme }
  cover.value = undefined
  if (customUrl.value) URL.revokeObjectURL(customUrl.value)
  customUrl.value = ''
})

const previewImage = computed(() => customUrl.value || (draft.value.coverAssetId ? props.coverUrl : '') || getThemePreset(draft.value.preset).image || '')

function selectPreset(id: string) {
  const preset = getThemePreset(id)
  draft.value = { ...preset.settings }
  cover.value = undefined
  if (customUrl.value) URL.revokeObjectURL(customUrl.value)
  customUrl.value = ''
}

function selectCover(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  if (customUrl.value) URL.revokeObjectURL(customUrl.value)
  cover.value = file
  customUrl.value = URL.createObjectURL(file)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open && book" class="local-modal-backdrop" @mousedown.self="emit('close')">
      <section class="local-modal theme-editor" role="dialog" aria-modal="true" aria-label="主题配置">
        <header><div><small>BOOK THEME</small><h2>配置《{{ book.title }}》主题</h2></div><button type="button" aria-label="关闭" @click="emit('close')"><X :size="20" /></button></header>
        <div class="theme-editor__preview" :style="{ '--theme-accent': draft.accent, '--theme-bg': draft.background, '--theme-text': draft.text, '--theme-overlay': `${draft.overlay / 100}`, backgroundImage: previewImage ? `linear-gradient(rgba(0,0,0,var(--theme-overlay)), rgba(0,0,0,var(--theme-overlay))), url(${previewImage})` : undefined, backgroundPosition: `${draft.positionX}% ${draft.positionY}%` }">
          <span>{{ book.author }}</span><strong>{{ book.title }}</strong><small>{{ book.chapterCount }} 章</small>
        </div>
        <div class="theme-preset-grid">
          <button v-for="preset in themePresets" :key="preset.id" type="button" :class="{ active: draft.preset === preset.id && !customUrl }" @click="selectPreset(preset.id)"><span :style="{ background: preset.image ? `url(${preset.image}) center/cover` : preset.settings.background }" /><b>{{ preset.name }}</b><Check v-if="draft.preset === preset.id && !customUrl" :size="15" /></button>
        </div>
        <div class="theme-controls">
          <label><span>强调色</span><input v-model="draft.accent" type="color" /></label>
          <label><span>背景色</span><input v-model="draft.background" type="color" /></label>
          <label><span>文字色</span><input v-model="draft.text" type="color" /></label>
          <label class="theme-control-wide"><span>图片遮罩 {{ draft.overlay }}%</span><input v-model.number="draft.overlay" type="range" min="0" max="85" /></label>
          <label class="theme-control-wide"><span>水平焦点 {{ draft.positionX }}%</span><input v-model.number="draft.positionX" type="range" min="0" max="100" /></label>
          <label class="theme-control-wide"><span>垂直焦点 {{ draft.positionY }}%</span><input v-model.number="draft.positionY" type="range" min="0" max="100" /></label>
        </div>
        <label class="local-upload-button"><ImagePlus :size="17" /> 上传自定义主题图片<input type="file" accept="image/*" @change="selectCover" /></label>
        <footer><button type="button" class="local-button-secondary" @click="emit('close')">取消</button><button type="button" class="local-button-primary" @click="emit('save', draft, cover)">保存主题</button></footer>
      </section>
    </div>
  </Teleport>
</template>
