<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { AlertTriangle, ArrowLeft, ArrowRight, Check, FileText, ImagePlus, Settings2, Upload, X } from 'lucide-vue-next'
import { saveImportedBook } from './db'
import { defaultParseOptions, defaultTheme, type LocalBook, type ParseOptions, type ParseResult, type ParserResponse, type ThemeSettings } from './types'
import { getThemePreset, themePresets } from './themes'

const props = defineProps<{ open: boolean; existingBook?: LocalBook }>()
const emit = defineEmits<{ close: []; imported: [book: LocalBook] }>()
const step = ref(1)
const file = ref<File>()
const options = ref<ParseOptions>({ ...defaultParseOptions })
const result = ref<ParseResult>()
const progress = ref(0)
const progressMessage = ref('')
const error = ref('')
const previewIndex = ref(0)
const importing = ref(false)
const theme = ref<ThemeSettings>({ ...defaultTheme })
const cover = ref<Blob>()
const coverUrl = ref('')

watch(() => props.open, open => {
  if (!open) return
  step.value = 1
  file.value = undefined
  result.value = undefined
  progress.value = 0
  error.value = ''
  previewIndex.value = 0
  options.value = { ...(props.existingBook?.parseOptions ?? defaultParseOptions) }
  theme.value = { ...(props.existingBook?.theme ?? defaultTheme) }
  cover.value = undefined
  if (coverUrl.value) URL.revokeObjectURL(coverUrl.value)
  coverUrl.value = ''
})

const selectedChapter = computed(() => result.value?.chapters[previewIndex.value])
const selectedPresetImage = computed(() => coverUrl.value || getThemePreset(theme.value.preset).image || '')
const steps = computed(() => props.existingBook ? ['选择原文', '解析校对', '主题确认', '更新完成'] : ['选择文件', '解析校对', '选择主题', '导入完成'])

function chooseFile(selected?: File) {
  if (!selected) return
  if (!/\.txt$/i.test(selected.name) && !selected.type.startsWith('text/')) {
    error.value = '请选择 TXT 文本文件'
    return
  }
  file.value = selected
  error.value = ''
}

function onDrop(event: DragEvent) { chooseFile(event.dataTransfer?.files?.[0]) }

async function parseFile() {
  if (!file.value) return
  step.value = 2
  progress.value = 2
  progressMessage.value = '正在读取文件'
  error.value = ''
  const buffer = await file.value.arrayBuffer()
  const worker = new Worker(new URL('./parser.worker.ts', import.meta.url), { type: 'module' })
  try {
    result.value = await new Promise<ParseResult>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<ParserResponse>) => {
        if (event.data.type === 'progress') {
          progress.value = event.data.progress
          progressMessage.value = event.data.message
        } else if (event.data.type === 'complete') resolve(event.data.result)
        else reject(new Error(event.data.message))
      }
      worker.onerror = () => reject(new Error('解析线程运行失败'))
      worker.postMessage({ buffer, filename: file.value!.name, options: { ...options.value } }, [buffer])
    })
    progress.value = 100
    progressMessage.value = `已识别 ${result.value.chapters.length} 章`
    previewIndex.value = 0
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '解析失败'
  } finally {
    worker.terminate()
  }
}

function selectPreset(id: string) {
  const preset = getThemePreset(id)
  theme.value = { ...preset.settings }
  cover.value = undefined
  if (coverUrl.value) URL.revokeObjectURL(coverUrl.value)
  coverUrl.value = ''
}

function selectCover(event: Event) {
  const selected = (event.target as HTMLInputElement).files?.[0]
  if (!selected) return
  if (coverUrl.value) URL.revokeObjectURL(coverUrl.value)
  cover.value = selected
  coverUrl.value = URL.createObjectURL(selected)
}

async function finishImport() {
  if (!result.value || !file.value) return
  importing.value = true
  error.value = ''
  try {
    const book = await saveImportedBook({ result: result.value, cover: cover.value, theme: theme.value, options: options.value, existingId: props.existingBook?.id })
    step.value = 4
    emit('imported', book)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存失败'
  } finally {
    importing.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="local-modal-backdrop" @mousedown.self="emit('close')">
      <section class="local-modal import-modal" role="dialog" aria-modal="true" aria-label="导入 TXT 小说">
        <header><div><small>LOCAL IMPORT</small><h2>{{ existingBook ? `重新解析《${existingBook.title}》` : '导入 TXT 小说' }}</h2></div><button type="button" aria-label="关闭" @click="emit('close')"><X :size="20" /></button></header>
        <ol class="import-steps"><li v-for="(label, index) in steps" :key="label" :class="{ active: step === index + 1, done: step > index + 1 }"><span>{{ step > index + 1 ? '✓' : index + 1 }}</span>{{ label }}</li></ol>

        <div v-if="step === 1" class="import-step-body">
          <label class="import-dropzone" @dragover.prevent @drop.prevent="onDrop"><Upload :size="34" /><strong>{{ file?.name || '拖入 TXT，或点击选择文件' }}</strong><span>{{ file ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : '支持 UTF-8、GBK/GB18030、UTF-16' }}</span><input type="file" accept=".txt,text/plain" @change="chooseFile(($event.target as HTMLInputElement).files?.[0])" /></label>
          <p class="local-privacy-note"><FileText :size="16" /> 文件只在浏览器中解析，不上传，也不保存原始 TXT。</p>
          <details class="import-advanced"><summary><Settings2 :size="16" /> 高级解析规则</summary><div class="import-rule-grid">
            <label>文本编码<select v-model="options.encoding"><option value="auto">自动识别</option><option value="utf-8">UTF-8</option><option value="gb18030">GBK / GB18030</option><option value="utf-16le">UTF-16 LE</option><option value="utf-16be">UTF-16 BE</option></select></label>
            <label class="rule-wide">自定义章节正则<input v-model="options.chapterPattern" placeholder="留空使用内置规则；捕获组1为章号，组2为标题" /></label>
            <label class="rule-wide">广告清理规则（每行一个正则）<textarea v-model="options.adPatterns" rows="4" /></label>
            <label class="rule-check"><input v-model="options.mergeWrapped" type="checkbox" /> 合并错误断行</label><label class="rule-check"><input v-model="options.removeAds" type="checkbox" /> 清理广告尾注</label>
          </div></details>
        </div>

        <div v-else-if="step === 2" class="import-step-body">
          <div v-if="!result" class="import-progress"><span :style="{ width: `${progress}%` }" /><strong>{{ progressMessage }}</strong><small>{{ progress }}%</small></div>
          <template v-else>
            <div class="import-metadata"><label>书名<input v-model="result.metadata.title" /></label><label>作者<input v-model="result.metadata.author" placeholder="佚名" /></label><label class="metadata-wide">简介<textarea v-model="result.metadata.description" rows="3" /></label></div>
            <div class="parse-summary"><span><b>{{ result.chapters.length }}</b> 章</span><span><b>{{ [...new Set(result.chapters.map(item => item.volume).filter(Boolean))].length || 1 }}</b> 卷/分组</span><span><b>{{ result.metadata.encoding }}</b> 编码</span><span><b>{{ result.chapters.reduce((sum, item) => sum + item.wordCount, 0).toLocaleString() }}</b> 字</span></div>
            <div v-if="result.warnings.length" class="parse-warnings"><p v-for="warning in result.warnings" :key="warning"><AlertTriangle :size="15" /> {{ warning }}</p></div>
            <div class="chapter-preview"><aside><button v-for="(chapter, index) in result.chapters.slice(0, 80)" :key="chapter.number" type="button" :class="{ active: previewIndex === index }" @click="previewIndex = index"><small>{{ chapter.volume || '正文' }}</small><span>{{ chapter.number }}. {{ chapter.title }}</span></button><p v-if="result.chapters.length > 80">其余 {{ result.chapters.length - 80 }} 章将在导入后显示</p></aside><article v-if="selectedChapter"><small>格式预览 · {{ selectedChapter.wordCount }} 字</small><h3>{{ selectedChapter.title }}</h3><p v-for="paragraph in selectedChapter.content.split(/\n{2,}/).slice(0, 12)" :key="paragraph">{{ paragraph }}</p></article></div>
            <details class="import-advanced"><summary><Settings2 :size="16" /> 调整规则并重新解析</summary><div class="import-rule-grid"><label>文本编码<select v-model="options.encoding"><option value="auto">自动识别</option><option value="utf-8">UTF-8</option><option value="gb18030">GBK / GB18030</option><option value="utf-16le">UTF-16 LE</option><option value="utf-16be">UTF-16 BE</option></select></label><label class="rule-wide">自定义章节正则<input v-model="options.chapterPattern" /></label><label class="rule-wide">广告清理规则<textarea v-model="options.adPatterns" rows="3" /></label><label class="rule-check"><input v-model="options.mergeWrapped" type="checkbox" /> 合并错误断行</label><label class="rule-check"><input v-model="options.removeAds" type="checkbox" /> 清理广告尾注</label><button type="button" class="local-button-secondary" @click="result = undefined; parseFile()">重新解析</button></div></details>
          </template>
        </div>

        <div v-else-if="step === 3 && result" class="import-step-body">
          <div class="import-theme-preview" :style="{ '--theme-accent': theme.accent, '--theme-text': theme.text, '--theme-overlay': `${theme.overlay / 100}`, background: selectedPresetImage ? `linear-gradient(rgba(0,0,0,var(--theme-overlay)), rgba(0,0,0,var(--theme-overlay))), url(${selectedPresetImage}) ${theme.positionX}% ${theme.positionY}%/cover` : theme.background }"><span>{{ result.metadata.author || '佚名' }}</span><strong>{{ result.metadata.title }}</strong><small>{{ result.chapters.length }} 章</small></div>
          <div class="theme-preset-grid"><button v-for="preset in themePresets" :key="preset.id" type="button" :class="{ active: theme.preset === preset.id && !coverUrl }" @click="selectPreset(preset.id)"><span :style="{ background: preset.image ? `url(${preset.image}) center/cover` : preset.settings.background }" /><b>{{ preset.name }}</b><Check v-if="theme.preset === preset.id && !coverUrl" :size="15" /></button></div>
          <div class="theme-controls"><label><span>强调色</span><input v-model="theme.accent" type="color" /></label><label><span>背景色</span><input v-model="theme.background" type="color" /></label><label><span>文字色</span><input v-model="theme.text" type="color" /></label><label class="theme-control-wide"><span>遮罩 {{ theme.overlay }}%</span><input v-model.number="theme.overlay" type="range" min="0" max="85" /></label><label class="theme-control-wide"><span>水平焦点 {{ theme.positionX }}%</span><input v-model.number="theme.positionX" type="range" min="0" max="100" /></label><label class="theme-control-wide"><span>垂直焦点 {{ theme.positionY }}%</span><input v-model.number="theme.positionY" type="range" min="0" max="100" /></label></div>
          <label class="local-upload-button"><ImagePlus :size="17" /> 上传自定义主题图片<input type="file" accept="image/*" @change="selectCover" /></label>
        </div>

        <div v-else class="import-complete"><Check :size="34" /><h3>{{ existingBook ? '重新解析完成' : '已加入本地书架' }}</h3><p>书籍和章节已保存到当前浏览器。</p></div>
        <p v-if="error" class="local-error">{{ error }}</p>
        <footer><button v-if="step > 1 && step < 4" type="button" class="local-button-secondary" @click="step--"><ArrowLeft :size="16" /> 上一步</button><span /><button v-if="step === 1" type="button" class="local-button-primary" :disabled="!file" @click="parseFile">开始解析 <ArrowRight :size="16" /></button><button v-else-if="step === 2 && result" type="button" class="local-button-primary" @click="step = 3">选择主题 <ArrowRight :size="16" /></button><button v-else-if="step === 3" type="button" class="local-button-primary" :disabled="importing" @click="finishImport">{{ importing ? '正在保存…' : existingBook ? '更新书籍' : '加入本地书架' }}</button><button v-else-if="step === 4" type="button" class="local-button-primary" @click="emit('close')">完成</button></footer>
      </section>
    </div>
  </Teleport>
</template>
