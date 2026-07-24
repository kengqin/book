<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ArrowLeft, CheckCircle2, Code2, Download, MousePointer2, RefreshCw, RotateCcw, Search, Trash2 } from 'lucide-vue-next'
import { useRouter } from 'vue-router'
import { getIdeIntegrationStatus, installIdePlugin, setCodeOssWheelInjection, uninstallIdePlugin, type BundledIdePlugin, type IdeIntegrationStatus, type IdeTarget } from '../services/desktop-library'
import { idePluginUpdateAvailable } from '../services/ide-plugin-update'
import { showGlobalMessage } from '../services/global-message'
import PageHeader from '../components/ui/PageHeader.vue'
import UiConfirmDialog from '../components/ui/UiConfirmDialog.vue'

const router = useRouter()
const fallbackPlugins: BundledIdePlugin[] = [
  { id: 'vscode', label: '小说书库 · VS Code 阅读器', kind: 'vscode', version: '0.4.15', identifier: 'novel-library.novel-library-reader', description: '面向 VS Code、Cursor、Trae、Qoder、Windsurf、Kiro 等 Code OSS 编辑器的配套扩展，支持书架与章节浏览、五行只读正文、自动跨章、固定进度栏及桌面端进度同步。', packageType: 'VSIX', supportedIdes: ['Visual Studio Code', 'VS Code Insiders', 'Cursor', 'Trae', 'Qoder', 'Windsurf', 'Kiro', 'VSCodium', 'Void', 'Code - OSS', 'Positron', 'PearAI'], available: false },
  { id: 'intellij', label: '小说书库 · JetBrains 阅读器', kind: 'jetbrains', version: '0.4.15', identifier: 'com.kengqin.novellibrary.reader', description: '面向 IntelliJ IDEA、PyCharm、WebStorm、Android Studio 等 JetBrains IDE 的配套插件，支持五行只读正文、自动跨章、固定进度栏、悬停滚轮及桌面端进度同步。', packageType: 'ZIP', supportedIdes: ['IntelliJ IDEA', 'PyCharm', 'WebStorm', 'Android Studio', 'Rider', 'CLion', 'GoLand', 'RubyMine'], available: false },
  { id: 'visual-studio', label: '小说书库 · Visual Studio 阅读器', kind: 'visual-studio', version: '0.4.15', identifier: 'NovelLibrary.VisualStudio', description: '面向 Visual Studio 2022 的配套扩展，支持书架与章节浏览、五行只读正文、自动跨章、固定进度栏、段落/行尾模式、悬停滚轮及桌面端进度同步。', packageType: 'VSIX', supportedIdes: ['Visual Studio 2022'], available: false }
]
const status = ref<IdeIntegrationStatus>({ plugins: fallbackPlugins, targets: [] })
const detecting = ref(true)
const busyTarget = ref('')
const busyAction = ref<'install' | 'update' | 'uninstall' | 'wheel' | ''>('')
const error = ref('')
const query = ref('')
type RunningIdeAction = 'install' | 'update' | 'uninstall'
const runningIdeOperation = ref<{ target: IdeTarget, plugin: BundledIdePlugin, action: RunningIdeAction }>()
const ideActionLabel = (action: RunningIdeAction) => ({ install: '安装', update: '更新', uninstall: '卸载' })[action]
const runningIdeActionLabel = computed(() => ideActionLabel(runningIdeOperation.value?.action || 'update'))
const pendingWheelTarget = ref<IdeTarget>()
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
    if (generation === refreshGeneration) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      showGlobalMessage(`IDE 检测失败：${error.value}`, 'error', 6000)
    }
  } finally {
    if (generation === refreshGeneration) detecting.value = false
  }
}

async function install(target: IdeTarget, plugin: BundledIdePlugin, closeRunningIde = false) {
  const updating = idePluginUpdateAvailable(target, plugin)
  busyTarget.value = target.id
  busyAction.value = updating ? 'update' : 'install'
  error.value = ''
  try {
    const result = await installIdePlugin(target.id, plugin.id, closeRunningIde)
    if (!result.installed || !result.verified) throw new Error(`${result.plugin} 安装命令已返回，但复检未确认安装完成`)
    const version = result.installedVersion ? ` · v${result.installedVersion}` : ''
    showGlobalMessage(`${result.plugin} 已${updating ? '更新' : '安装'}到 ${result.target}${version}。${result.message}`)
    await refresh()
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    if (!closeRunningIde && detail.startsWith('IDE_RUNNING:')) {
      runningIdeOperation.value = { target, plugin, action: updating ? 'update' : 'install' }
    } else {
      error.value = detail.replace(/^IDE_(?:RUNNING|CLOSE_PENDING):\s*/, '')
      showGlobalMessage(error.value, 'error', 6000)
    }
  } finally {
    busyTarget.value = ''
    busyAction.value = ''
  }
}

function chooseManualIdeClose() {
  const pending = runningIdeOperation.value
  runningIdeOperation.value = undefined
  if (pending) showGlobalMessage(`请保存工作并完全关闭 ${pending.target.label}，然后再次点击“${ideActionLabel(pending.action)}”。`, 'info', 6000)
}

async function closeIdeAndContinue() {
  const pending = runningIdeOperation.value
  if (!pending) return
  runningIdeOperation.value = undefined
  if (pending.action === 'uninstall') {
    await uninstall(pending.target, pending.plugin, true)
  } else {
    await install(pending.target, pending.plugin, true)
  }
}

async function uninstall(target: IdeTarget, plugin: BundledIdePlugin, closeRunningIde = false) {
  if (!target.canUninstall) return
  busyTarget.value = target.id
  busyAction.value = 'uninstall'
  error.value = ''
  try {
    const result = await uninstallIdePlugin(target.id, plugin.id, closeRunningIde)
    if (result.installed || !result.verified) throw new Error(`${result.plugin} 卸载命令已返回，但复检未确认卸载完成`)
    showGlobalMessage(`${result.plugin} 已从 ${result.target} 卸载。${result.message}`)
    await refresh()
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    if (!closeRunningIde && detail.startsWith('IDE_RUNNING:')) {
      runningIdeOperation.value = { target, plugin, action: 'uninstall' }
    } else {
      error.value = detail.replace(/^IDE_(?:RUNNING|CLOSE_PENDING):\s*/, '')
      showGlobalMessage(error.value, 'error', 6000)
    }
  } finally {
    busyTarget.value = ''
    busyAction.value = ''
  }
}

async function changeWheelInjection(target: IdeTarget, enabled: boolean) {
  busyTarget.value = target.id
  busyAction.value = 'wheel'
  error.value = ''
  try {
    const result = await setCodeOssWheelInjection(target.id, enabled)
    showGlobalMessage(`${result.target}：${result.message}`)
    await refresh()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
    showGlobalMessage(error.value, 'error', 6000)
  } finally {
    busyTarget.value = ''
    busyAction.value = ''
  }
}

function requestWheelToggle(target: IdeTarget) {
  if (target.wheelInjectionEnabled || target.wheelInjectionNeedsRepair) {
    void changeWheelInjection(target, false)
  } else {
    pendingWheelTarget.value = target
  }
}

async function confirmWheelInjection() {
  const target = pendingWheelTarget.value
  pendingWheelTarget.value = undefined
  if (target) await changeWheelInjection(target, true)
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
          <div class="ide-plugin-heading"><div class="ide-plugin-title"><strong>{{ plugin.label }}</strong><span>v{{ plugin.version }}</span></div><small>{{ plugin.description }}</small></div>
          <span class="ide-package-state" :class="{ ready: plugin.available }">{{ plugin.available ? `安装包已内置 · ${plugin.packageType}` : detecting ? '正在校验安装包' : '安装包缺失' }}</span>
        </header>
        <div class="ide-plugin-supported"><span>支持：</span>{{ plugin.supportedIdes.join('、') }}</div>
        <div v-if="targetsFor(plugin).length" class="ide-target-list">
          <div v-for="target in targetsFor(plugin)" :key="target.id" class="ide-target-row">
            <div><strong>{{ target.label }}</strong><small>安装位置：{{ target.path }}</small><span v-if="idePluginUpdateAvailable(target, plugin)">插件已安装 · v{{ target.installedVersion }}，可更新至 v{{ plugin.version }}</span><span v-else-if="target.installed">插件已安装{{ target.installedVersion ? ` · v${target.installedVersion}` : '' }}</span><span v-else>插件未安装</span><span v-if="target.wheelInjectionNeedsRepair">增强滚轮状态不完整，可关闭并恢复</span><span v-else-if="target.wheelInjectionEnabled">实验性增强滚轮已启用 · 重启编辑器后生效</span></div>
            <div class="ide-target-actions">
              <button v-if="busyTarget === target.id && busyAction !== 'wheel'" type="button" class="secondary-command" disabled><RotateCcw :size="15" class="spinning" />{{ busyAction === 'uninstall' ? '卸载中' : busyAction === 'update' ? '更新中' : '安装中' }}</button>
              <button v-else-if="idePluginUpdateAvailable(target, plugin)" type="button" class="primary-command" :disabled="!plugin.available" @click="install(target, plugin)"><RefreshCw :size="15" />更新</button>
              <button v-else-if="target.installed && target.canUninstall" type="button" class="secondary-command" @click="uninstall(target, plugin)"><Trash2 :size="15" />卸载</button>
              <button v-else-if="target.installed" type="button" class="secondary-command" disabled><CheckCircle2 :size="15" />已安装</button>
              <button v-else type="button" class="primary-command" :disabled="!plugin.available" @click="install(target, plugin)"><Download :size="15" />安装</button>
              <button v-if="target.kind === 'vscode' && target.wheelInjectionAvailable" type="button" role="switch" class="secondary-command ide-wheel-switch" :class="{ active: target.wheelInjectionEnabled, warning: target.wheelInjectionNeedsRepair }" :aria-checked="target.wheelInjectionEnabled" :disabled="busyTarget === target.id || (!target.installed && !target.wheelInjectionEnabled && !target.wheelInjectionNeedsRepair)" @click="requestWheelToggle(target)"><RotateCcw v-if="busyTarget === target.id && busyAction === 'wheel'" :size="14" class="spinning" /><MousePointer2 v-else :size="14" />增强滚轮：{{ target.wheelInjectionNeedsRepair ? '恢复' : target.wheelInjectionEnabled ? '开' : '关' }}</button>
            </div>
          </div>
        </div>
        <div v-else class="ide-plugin-empty">{{ detecting ? '正在检测本机实例...' : `未检测到 ${plugin.supportedIdes.join('、')}` }}</div>
      </article>
    </div>
    <UiConfirmDialog
      :open="Boolean(runningIdeOperation)"
      :title="`需要关闭 JetBrains IDE 才能${runningIdeActionLabel}`"
      :description="`${runningIdeOperation?.target.label || 'JetBrains IDE'} 正在使用插件文件。可以由桌面端发送正常关闭请求（IDE 仍会询问是否保存未保存内容），也可以自行关闭后再次${runningIdeActionLabel}；不会强制结束进程。`"
      :confirm-label="`帮我关闭并${runningIdeActionLabel}`"
      cancel-label="我自己关闭"
      @close="chooseManualIdeClose"
      @confirm="closeIdeAndContinue"
    />
    <UiConfirmDialog
      :open="Boolean(pendingWheelTarget)"
      title="启用实验性增强滚轮？"
      :description="`这会修改 ${pendingWheelTarget?.label || 'Code OSS 编辑器'} 的 Monaco 工作台文件，并同步更新完整性校验。桌面端会保留备份并支持关闭恢复，但编辑器升级后可能需要重新启用。功能默认关闭，启用后请完全退出并重新打开编辑器。`"
      confirm-label="启用并安装注入"
      cancel-label="保持关闭"
      @close="pendingWheelTarget = undefined"
      @confirm="confirmWheelInjection"
    />
  </section>
</template>
