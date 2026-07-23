<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ArrowLeft, CheckCircle2, Code2, Download, RefreshCw, RotateCcw, Search, Trash2 } from 'lucide-vue-next'
import { useRouter } from 'vue-router'
import { getIdeIntegrationStatus, installIdePlugin, uninstallIdePlugin, type BundledIdePlugin, type IdeIntegrationStatus, type IdeTarget } from '../services/desktop-library'
import { idePluginUpdateAvailable } from '../services/ide-plugin-update'
import PageHeader from '../components/ui/PageHeader.vue'
import UiConfirmDialog from '../components/ui/UiConfirmDialog.vue'

const router = useRouter()
const fallbackPlugins: BundledIdePlugin[] = [
  { id: 'vscode', label: '小说书库 · VS Code / Cursor 阅读器', kind: 'vscode', version: '0.4.7', identifier: 'novel-library.novel-library-reader', description: '在 VS Code 和 Cursor 中浏览书架、章节和 5 行正文，并可切换段落或行尾显示模式，同步桌面端进度。', packageType: 'VSIX', supportedIdes: ['Visual Studio Code', 'Cursor'], available: false },
  { id: 'intellij', label: '小说书库 · JetBrains 阅读器', kind: 'jetbrains', version: '0.4.7', identifier: 'com.kengqin.novellibrary.reader', description: '在 IntelliJ IDEA、PyCharm、WebStorm 等 JetBrains IDE 中阅读 5 行小说，可切换段落或行尾模式并同步桌面端进度。', packageType: 'ZIP', supportedIdes: ['IntelliJ IDEA', 'PyCharm', 'WebStorm', 'Android Studio', 'Rider', 'CLion', 'GoLand', 'RubyMine'], available: false },
  { id: 'visual-studio', label: '小说书库 · Visual Studio 阅读器', kind: 'visual-studio', version: '0.4.7', identifier: 'NovelLibrary.VisualStudio', description: '在 Visual Studio 2022 中打开小说阅读面板，可切换段落或行尾模式，并与桌面端书库同步。', packageType: 'VSIX', supportedIdes: ['Visual Studio 2022'], available: false }
]
const status = ref<IdeIntegrationStatus>({ plugins: fallbackPlugins, targets: [] })
const detecting = ref(true)
const busyTarget = ref('')
const busyAction = ref<'install' | 'update' | 'uninstall' | ''>('')
const error = ref('')
const message = ref('')
const query = ref('')
const runningIdeUpdate = ref<{ target: IdeTarget, plugin: BundledIdePlugin }>()
let refreshGeneration = 0
const visiblePlugins = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase()
  if (!keyword) return status.value.plugins
  return status.value.plugins.filter(plugin => `${plugin.label} ${plugin.identifier}`.toLocaleLowerCase().includes(keyword))
})

function targetsFor(plugin: BundledIdePlugin) {
  return status.value.targets.filter(target => target.kind === plugin.kind)
}

async function refresh() {
  const generation = ++refreshGeneration
  detecting.value = true
  error.value = ''
  try {
    const nextStatus = await getIdeIntegrationStatus()
    if (generation === refreshGeneration) status.value = nextStatus
  } catch (cause) {
    if (generation === refreshGeneration) error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (generation === refreshGeneration) detecting.value = false
  }
}

async function install(target: IdeTarget, plugin: BundledIdePlugin, closeRunningIde = false) {
  const updating = idePluginUpdateAvailable(target, plugin)
  busyTarget.value = target.id
  busyAction.value = updating ? 'update' : 'install'
  error.value = ''
  message.value = ''
  try {
    const result = await installIdePlugin(target.id, plugin.id, closeRunningIde)
    if (!result.installed || !result.verified) throw new Error(`${result.plugin} 安装命令已返回，但复检未确认安装完成`)
    const version = result.installedVersion ? ` · v${result.installedVersion}` : ''
    message.value = `${result.plugin} 已${updating ? '更新' : '安装'}到 ${result.target}${version}。${result.message}`
    await refresh()
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    if (!closeRunningIde && detail.startsWith('IDE_RUNNING:')) {
      runningIdeUpdate.value = { target, plugin }
    } else {
      error.value = detail.replace(/^IDE_(?:RUNNING|CLOSE_PENDING):\s*/, '')
    }
  } finally {
    busyTarget.value = ''
    busyAction.value = ''
  }
}

function chooseManualIdeClose() {
  const pending = runningIdeUpdate.value
  runningIdeUpdate.value = undefined
  if (pending) message.value = `请保存工作并完全关闭 ${pending.target.label}，然后再次点击“更新”。`
}

async function closeIdeAndInstall() {
  const pending = runningIdeUpdate.value
  if (!pending) return
  runningIdeUpdate.value = undefined
  await install(pending.target, pending.plugin, true)
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
    <PageHeader title="IDE 插件">
      <template #actions><button type="button" class="icon-button" title="重新检测本机 IDE" :disabled="detecting" @click="refresh"><RefreshCw :size="18" :class="{ spinning: detecting }" /></button></template>
    </PageHeader>
    <button type="button" class="text-command" @click="router.push('/tools')"><ArrowLeft :size="16" />返回工具库</button>

    <div class="ide-plugin-toolbar">
      <label class="ide-plugin-search"><Search :size="16" /><input v-model="query" type="search" placeholder="搜索支持的 IDE 或插件" /></label>
      <span>{{ detecting ? '正在校验插件包与本机 IDE' : error ? '检测失败' : `${visiblePlugins.length} 个插件包` }}</span>
    </div>

    <div class="ide-plugin-catalog" aria-label="插件包目录">
      <article v-for="plugin in visiblePlugins" :key="plugin.id" class="ide-plugin-card">
        <header>
          <span class="ide-target-icon"><Code2 :size="20" /></span>
          <div class="ide-plugin-heading"><strong>{{ plugin.label }}</strong><small>{{ plugin.description }}</small></div>
          <span class="ide-package-state" :class="{ ready: plugin.available }">{{ plugin.available ? `安装包已内置 · ${plugin.packageType}` : detecting ? '正在校验安装包' : '安装包缺失' }}</span>
        </header>
        <div class="ide-plugin-supported"><span>支持：</span>{{ plugin.supportedIdes.join('、') }}</div>
        <div v-if="targetsFor(plugin).length" class="ide-target-list">
          <div v-for="target in targetsFor(plugin)" :key="target.id" class="ide-target-row">
            <div><strong>{{ target.label }}</strong><small>安装位置：{{ target.path }}</small><span v-if="idePluginUpdateAvailable(target, plugin)">插件已安装 · v{{ target.installedVersion }}，可更新至 v{{ plugin.version }}</span><span v-else-if="target.installed">插件已安装{{ target.installedVersion ? ` · v${target.installedVersion}` : '' }}</span><span v-else>插件未安装</span></div>
            <button v-if="busyTarget === target.id" type="button" class="secondary-command" disabled><RotateCcw :size="15" class="spinning" />{{ busyAction === 'uninstall' ? '卸载中' : busyAction === 'update' ? '更新中' : '安装中' }}</button>
            <button v-else-if="idePluginUpdateAvailable(target, plugin)" type="button" class="primary-command" :disabled="!plugin.available" @click="install(target, plugin)"><RefreshCw :size="15" />更新</button>
            <button v-else-if="target.installed && target.canUninstall" type="button" class="secondary-command" @click="uninstall(target, plugin)"><Trash2 :size="15" />卸载</button>
            <button v-else-if="target.installed" type="button" class="secondary-command" disabled><CheckCircle2 :size="15" />已安装</button>
            <button v-else type="button" class="primary-command" :disabled="!plugin.available" @click="install(target, plugin)"><Download :size="15" />安装</button>
          </div>
        </div>
        <div v-else class="ide-plugin-empty">{{ detecting ? '正在检测本机实例...' : `未检测到 ${plugin.supportedIdes.join('、')}` }}</div>
      </article>
    </div>
    <p v-if="message" class="settings-message" role="status"><CheckCircle2 :size="15" />{{ message }}</p>
    <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
    <UiConfirmDialog
      :open="Boolean(runningIdeUpdate)"
      title="需要关闭 JetBrains IDE 才能更新"
      :description="`${runningIdeUpdate?.target.label || 'JetBrains IDE'} 正在使用旧版插件文件。可以由桌面端发送正常关闭请求（IDE 仍会询问是否保存未保存内容），也可以自行关闭后再次更新；不会强制结束进程。`"
      confirm-label="自动关闭并更新"
      cancel-label="我手动关闭"
      @close="chooseManualIdeClose"
      @confirm="closeIdeAndInstall"
    />
  </section>
</template>
