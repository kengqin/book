<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ArrowLeft, CheckCircle2, Code2, Download, RefreshCw, RotateCcw, Search, Trash2 } from 'lucide-vue-next'
import { useRouter } from 'vue-router'
import { getIdeIntegrationStatus, installIdePlugin, uninstallIdePlugin, type BundledIdePlugin, type IdeIntegrationStatus, type IdeTarget } from '../services/desktop-library'

const router = useRouter()
const fallbackPlugins: BundledIdePlugin[] = [
  { id: 'vscode', label: '小说书库 · VS Code / Cursor 阅读器', kind: 'vscode', version: '0.4.5', identifier: 'novel-library.novel-library-reader', description: '在 VS Code 和 Cursor 中浏览书架、章节和 5 行正文，并可切换段落或行尾显示模式，同步桌面端进度。', packageType: 'VSIX', supportedIdes: ['Visual Studio Code', 'Cursor'], available: false },
  { id: 'intellij', label: '小说书库 · JetBrains 阅读器', kind: 'jetbrains', version: '0.4.5', identifier: 'com.kengqin.novellibrary.reader', description: '在 IntelliJ IDEA、PyCharm、WebStorm 等 JetBrains IDE 中阅读 5 行小说，可切换段落或行尾模式并同步桌面端进度。', packageType: 'ZIP', supportedIdes: ['IntelliJ IDEA', 'PyCharm', 'WebStorm', 'Android Studio', 'Rider', 'CLion', 'GoLand', 'RubyMine'], available: false },
  { id: 'visual-studio', label: '小说书库 · Visual Studio 阅读器', kind: 'visual-studio', version: '0.4.5', identifier: 'NovelLibrary.VisualStudio', description: '在 Visual Studio 2022 中打开小说阅读面板，可切换段落或行尾模式，并与桌面端书库同步。', packageType: 'VSIX', supportedIdes: ['Visual Studio 2022'], available: false }
]
const status = ref<IdeIntegrationStatus>({ plugins: fallbackPlugins, targets: [] })
const detecting = ref(true)
const busyTarget = ref('')
const busyAction = ref<'install' | 'uninstall' | ''>('')
const error = ref('')
const message = ref('')
const query = ref('')
const detectionTimeoutMs = 8000
const availableCount = computed(() => status.value.plugins.filter(plugin => plugin.available).length)
const visiblePlugins = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase()
  if (!keyword) return status.value.plugins
  return status.value.plugins.filter(plugin => `${plugin.label} ${plugin.identifier}`.toLocaleLowerCase().includes(keyword))
})

function targetsFor(plugin: BundledIdePlugin) {
  return status.value.targets.filter(target => target.kind === plugin.kind)
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('IDE 检测超过 8 秒，已停止等待，请稍后重试')), milliseconds)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function refresh() {
  detecting.value = true
  error.value = ''
  try {
    status.value = await withTimeout(getIdeIntegrationStatus(), detectionTimeoutMs)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    detecting.value = false
  }
}

async function install(target: IdeTarget, plugin: BundledIdePlugin) {
  busyTarget.value = target.id
  busyAction.value = 'install'
  error.value = ''
  message.value = ''
  try {
    const result = await installIdePlugin(target.id, plugin.id)
    if (!result.installed || !result.verified) throw new Error(`${result.plugin} 安装命令已返回，但复检未确认安装完成`)
    const version = result.installedVersion ? ` · v${result.installedVersion}` : ''
    message.value = `${result.plugin} 已安装到 ${result.target}${version}。${result.message}`
    await refresh()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busyTarget.value = ''
    busyAction.value = ''
  }
}

async function uninstall(target: IdeTarget, plugin: BundledIdePlugin) {
  if (!target.canUninstall) return
  busyTarget.value = target.id
  busyAction.value = 'uninstall'
  error.value = ''
  message.value = ''
  try {
    const result = await uninstallIdePlugin(target.id, plugin.id)
    if (result.installed || !result.verified) throw new Error(`${result.plugin} 卸载命令已返回，但复检未确认卸载完成`)
    message.value = `${result.plugin} 已从 ${result.target} 卸载。${result.message}`
    await refresh()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busyTarget.value = ''
    busyAction.value = ''
  }
}

onMounted(refresh)
</script>

<template>
  <section class="workspace-view ide-integration-view">
    <header class="workspace-header">
      <div><p>IDE INTEGRATION</p><h1>IDE 插件</h1></div>
      <button type="button" class="icon-button" title="重新检测本机 IDE" :disabled="detecting" @click="refresh"><RefreshCw :size="18" :class="{ spinning: detecting }" /></button>
    </header>
    <button type="button" class="text-command" @click="router.push('/tools')"><ArrowLeft :size="16" />返回工具库</button>

    <div class="ide-plugin-toolbar">
      <label class="ide-plugin-search"><Search :size="16" /><input v-model="query" type="search" placeholder="搜索支持的 IDE 或插件" /></label>
      <span>{{ detecting ? '正在校验插件包与本机 IDE' : `${availableCount} / ${status.plugins.length} 个插件包可用` }}</span>
    </div>

    <div class="ide-plugin-catalog">
      <article v-for="plugin in visiblePlugins" :key="plugin.id" class="ide-plugin-card">
        <header>
          <span class="ide-target-icon"><Code2 :size="20" /></span>
          <div class="ide-plugin-heading"><strong>{{ plugin.label }}</strong><small>{{ plugin.description }}</small><span>插件版本 v{{ plugin.version }} · {{ plugin.packageType }} · ID {{ plugin.identifier }}</span></div>
          <span class="ide-package-state" :class="{ ready: plugin.available }">{{ plugin.available ? `安装包已内置 · ${plugin.packageType}` : detecting ? '正在校验安装包' : '安装包缺失' }}</span>
        </header>
        <div class="ide-plugin-supported"><span>支持：</span>{{ plugin.supportedIdes.join('、') }}</div>
        <div v-if="targetsFor(plugin).length" class="ide-target-list">
          <div v-for="target in targetsFor(plugin)" :key="target.id" class="ide-target-row">
            <div><strong>{{ target.label }}</strong><small>安装位置：{{ target.path }}</small><span v-if="target.installed">插件已安装{{ target.installedVersion ? ` · v${target.installedVersion}` : '' }}</span><span v-else>插件未安装</span></div>
            <button v-if="busyTarget === target.id" type="button" class="secondary-command" disabled><RotateCcw :size="15" class="spinning" />{{ busyAction === 'uninstall' ? '卸载中' : '安装中' }}</button>
            <button v-else-if="target.installed && target.canUninstall" type="button" class="secondary-command" @click="uninstall(target, plugin)"><Trash2 :size="15" />卸载</button>
            <button v-else-if="target.installed" type="button" class="secondary-command" disabled><CheckCircle2 :size="15" />已安装</button>
            <button v-else type="button" class="primary-command" :disabled="!plugin.available" @click="install(target, plugin)"><Download :size="15" />安装</button>
          </div>
        </div>
        <div v-else class="ide-plugin-empty">{{ detecting ? '正在检测本机实例...' : `未检测到 ${plugin.supportedIdes.join('、')}，请确认 IDE 已安装` }}</div>
      </article>
    </div>
    <p v-if="message" class="settings-message"><CheckCircle2 :size="15" />{{ message }}</p>
    <p v-if="error" class="inline-error">{{ error }}</p>
  </section>
</template>
