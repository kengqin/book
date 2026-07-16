<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ArrowLeft, CheckCircle2, Code2, Download, RefreshCw, RotateCcw, Search, Trash2 } from 'lucide-vue-next'
import { useRouter } from 'vue-router'
import { getIdeIntegrationStatus, installIdePlugin, uninstallIdePlugin, type BundledIdePlugin, type IdeIntegrationStatus, type IdeTarget } from '../services/desktop-library'

const router = useRouter()
const fallbackPlugins: BundledIdePlugin[] = [
  { id: 'vscode', label: 'VS Code / Cursor', kind: 'vscode', version: '0.4.0', identifier: 'novel-library.novel-library-reader', available: false },
  { id: 'intellij', label: 'JetBrains IDE', kind: 'jetbrains', version: '0.4.0', identifier: 'com.kengqin.novellibrary.reader', available: false },
  { id: 'visual-studio', label: 'Visual Studio 2022', kind: 'visual-studio', version: '0.4.0', identifier: 'NovelLibrary.VisualStudio', available: false }
]
const status = ref<IdeIntegrationStatus>({ plugins: fallbackPlugins, targets: [] })
const detecting = ref(true)
const busyTarget = ref('')
const error = ref('')
const message = ref('')
const query = ref('')
const availableCount = computed(() => status.value.plugins.filter(plugin => plugin.available).length)
const visiblePlugins = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase()
  if (!keyword) return status.value.plugins
  return status.value.plugins.filter(plugin => `${plugin.label} ${plugin.identifier}`.toLocaleLowerCase().includes(keyword))
})

function targetsFor(plugin: BundledIdePlugin) {
  return status.value.targets.filter(target => target.kind === plugin.kind)
}

async function refresh() {
  detecting.value = true
  error.value = ''
  try {
    status.value = await getIdeIntegrationStatus()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    detecting.value = false
  }
}

async function install(target: IdeTarget, plugin: BundledIdePlugin) {
  busyTarget.value = target.id
  error.value = ''
  message.value = ''
  try {
    const result = await installIdePlugin(target.id, plugin.id)
    message.value = `${result.plugin} 已安装到 ${result.target}。${result.message}`
    await refresh()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busyTarget.value = ''
  }
}

async function uninstall(target: IdeTarget, plugin: BundledIdePlugin) {
  if (!target.canUninstall) return
  busyTarget.value = target.id
  error.value = ''
  message.value = ''
  try {
    const result = await uninstallIdePlugin(target.id, plugin.id)
    message.value = `${result.plugin} 已从 ${result.target} 卸载。${result.message}`
    await refresh()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busyTarget.value = ''
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
      <span>{{ availableCount }} / {{ status.plugins.length }} 个插件包可用</span>
    </div>

    <div class="ide-plugin-catalog">
      <article v-for="plugin in visiblePlugins" :key="plugin.id" class="ide-plugin-card">
        <header>
          <span class="ide-target-icon"><Code2 :size="20" /></span>
          <div><strong>{{ plugin.label }}</strong><small>{{ plugin.identifier }} · v{{ plugin.version }}</small></div>
          <span class="ide-package-state" :class="{ ready: plugin.available }">{{ plugin.available ? '随包可用' : '缺少产物' }}</span>
        </header>
        <div v-if="targetsFor(plugin).length" class="ide-target-list">
          <div v-for="target in targetsFor(plugin)" :key="target.id" class="ide-target-row">
            <div><strong>{{ target.label }}</strong><small>{{ target.path }}</small><span v-if="target.installed">已安装{{ target.installedVersion ? ` · v${target.installedVersion}` : '' }}</span><span v-else>未安装</span></div>
            <button v-if="target.installed && target.canUninstall" type="button" class="secondary-command" :disabled="busyTarget === target.id" @click="uninstall(target, plugin)"><Trash2 :size="15" />{{ busyTarget === target.id ? '处理中' : '卸载' }}</button>
            <button v-else-if="target.installed" type="button" class="secondary-command" disabled><CheckCircle2 :size="15" />已安装</button>
            <button v-else type="button" class="primary-command" :disabled="busyTarget === target.id || !plugin.available" @click="install(target, plugin)"><RotateCcw v-if="busyTarget === target.id" :size="15" class="spinning" /><Download v-else :size="15" />{{ busyTarget === target.id ? '安装中' : '安装' }}</button>
          </div>
        </div>
        <div v-else class="ide-plugin-empty">{{ detecting ? '正在检测本机实例...' : '未检测到本机实例，可直接下载插件包后在 IDE 内安装' }}</div>
      </article>
    </div>
    <p v-if="message" class="settings-message"><CheckCircle2 :size="15" />{{ message }}</p>
    <p v-if="error" class="inline-error">{{ error }}</p>
  </section>
</template>
