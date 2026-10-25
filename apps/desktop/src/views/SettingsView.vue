<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { isTauri } from '@tauri-apps/api/core'
import { emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useRoute } from 'vue-router'
import { open, save } from '@tauri-apps/plugin-dialog'
import { ArrowRight, Database, Download, Settings } from 'lucide-vue-next'
import UpdatesView from './UpdatesView.vue'
import { changeDesktopDatabaseFile, changeDesktopDataDirectory, exportDesktopBackup, getCloseBehavior, getDesktopStorageStatus, importDesktopBackup, resetDesktopDataDirectory, setCloseBehavior, type CloseBehavior, type DesktopStorageStatus } from '../services/desktop-library'
import { availableUpdate, getCurrentVersion, publishedUpdateVersion } from '../services/release-center'
import PageHeader from '../components/ui/PageHeader.vue'
import UiConfirmDialog from '../components/ui/UiConfirmDialog.vue'
import UiSelect, { type UiSelectOption } from '../components/ui/UiSelect.vue'
import { useAppearance } from '../composables/useAppearance'
import { showGlobalError, showGlobalMessage } from '../services/global-message'

interface PendingSettingAction {
  title: string
  description: string
  confirmLabel: string
  run: () => Promise<void>
}

const status = ref<DesktopStorageStatus>()
const busy = ref(false)
const currentVersion = ref('')
const closeBehavior = ref<CloseBehavior>('ask')
const pendingSettingAction = ref<PendingSettingAction | null>(null)
const { appearance, setAppearance } = useAppearance()
const props = defineProps<{ windowed?: boolean }>()
const route = useRoute()
const selectedSection = (value: unknown): 'general' | 'storage' | 'updates' => value === 'storage' || value === 'updates' ? value : 'general'
const activeSection = ref(selectedSection(route.query.section))
watch(() => route.query.section, value => { if (props.windowed) activeSection.value = selectedSection(value) })
watch(() => route.path, path => { if (props.windowed && path.endsWith('/updates')) activeSection.value = 'updates' })
let unlistenSection: UnlistenFn | undefined
const notifyDataChange = () => props.windowed && isTauri() ? emitTo('main', 'settings-data-changed') : Promise.resolve()

const appearanceOptions: UiSelectOption[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' }
]

const closeBehaviorOptions: UiSelectOption[] = [
  { value: 'ask', label: '每次询问' },
  { value: 'minimizeToTray', label: '缩小到托盘' },
  { value: 'quit', label: '直接退出' }
]

function queueSettingAction(action: PendingSettingAction) {
  pendingSettingAction.value = action
}

function showError(cause: unknown, fallback = '设置修改失败，请稍后重试') {
  showGlobalError(cause, fallback)
}

function updateAppearance(value: 'system' | 'light' | 'dark') {
  setAppearance(value)
  const label = appearanceOptions.find(option => option.value === value)?.label || '所选外观'
  showGlobalMessage(`外观已切换为“${label}”`)
}

async function confirmSettingAction() {
  const action = pendingSettingAction.value
  if (!action || busy.value) return
  busy.value = true
  try {
    await action.run()
    await notifyDataChange()
    pendingSettingAction.value = null
  } catch (cause) {
    showError(cause)
  } finally {
    busy.value = false
  }
}

async function refreshStatus() {
  try {
    status.value = await getDesktopStorageStatus()
  } catch (cause) {
    showError(cause, '无法读取本地数据库状态')
  }
}

async function exportBackup() {
  const target = await save({
    defaultPath: `NovelLibrary-backup-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: '小说书库备份', extensions: ['json'] }]
  })
  if (!target) return
  busy.value = true
  try {
    const result = await exportDesktopBackup(target)
    showGlobalMessage(`备份已导出：${result.books} 本书、${result.chapters} 章、${result.notes} 篇笔记`)
  } catch (cause) {
    showError(cause, '备份导出失败，请稍后重试')
  } finally {
    busy.value = false
  }
}

async function importBackup() {
  const source = await open({
    multiple: false,
    filters: [{ name: '小说书库备份', extensions: ['json'] }]
  })
  if (!source || Array.isArray(source)) return
  busy.value = true
  try {
    const result = await importDesktopBackup(source)
    await notifyDataChange()
    showGlobalMessage(`备份已恢复：${result.books} 本书、${result.chapters} 章、${result.notes} 篇笔记`)
  } catch (cause) {
    showError(cause, '备份恢复失败，请检查文件后重试')
  } finally {
    busy.value = false
  }
}

async function chooseDataDirectory() {
  const directory = await open({ directory: true, multiple: false, title: '选择小说书库数据目录', defaultPath: status.value?.dataDirectory })
  if (!directory || Array.isArray(directory)) return
  queueSettingAction({
    title: '切换数据目录？',
    description: '当前书库会复制到新目录，原数据库会保留。复制完成前请不要关闭应用。',
    confirmLabel: '切换目录',
    run: async () => {
      status.value = await changeDesktopDataDirectory(directory)
      showGlobalMessage('数据目录已切换')
    }
  })
}

async function resetDataDirectory() {
  queueSettingAction({
    title: '恢复默认数据目录？',
    description: '当前书库会复制回应用默认数据目录，现有数据库文件不会立即删除。',
    confirmLabel: '恢复默认目录',
    run: async () => {
      status.value = await resetDesktopDataDirectory()
      showGlobalMessage('已恢复默认数据目录')
    }
  })
}

async function chooseDatabaseFile() {
  const databasePath = await save({
    title: '选择或新建小说书库数据库文件',
    defaultPath: status.value?.databasePath || 'library.db',
    filters: [{ name: 'SQLite 数据库', extensions: ['db', 'sqlite', 'sqlite3'] }]
  })
  if (!databasePath) return
  queueSettingAction({
    title: '切换数据库文件？',
    description: '当前书库会复制到新文件；如果目标是已有数据库，应用会先校验再切换。',
    confirmLabel: '切换数据库',
    run: async () => {
      status.value = await changeDesktopDatabaseFile(databasePath)
      showGlobalMessage('数据库文件已切换')
    }
  })
}

async function saveCloseBehavior() {
  busy.value = true
  try {
    closeBehavior.value = await setCloseBehavior(closeBehavior.value)
    showGlobalMessage('关闭窗口方式已保存')
  } catch (cause) {
    showError(cause, '关闭窗口方式保存失败，请稍后重试')
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  if (props.windowed && isTauri()) unlistenSection = await listen<string>('settings-section', event => { activeSection.value = selectedSection(event.payload) })
  await Promise.all([
    refreshStatus(),
    getCurrentVersion().then(version => { currentVersion.value = version }).catch(cause => showError(cause, '无法读取当前版本')),
    getCloseBehavior().then(behavior => { closeBehavior.value = behavior }).catch(cause => showError(cause, '无法读取关闭窗口方式'))
  ])
})
onBeforeUnmount(() => unlistenSection?.())
</script>

<template>
  <section class="workspace-view settings-view" :class="{ 'settings-view--windowed': windowed }">
    <PageHeader v-if="!windowed" title="设置" />
    <nav class="settings-tabs" aria-label="设置分类">
      <button type="button" :class="{ active: activeSection === 'general' }" @click="activeSection = 'general'"><Settings v-if="windowed" :size="17" />常规</button>
      <button type="button" :class="{ active: activeSection === 'storage' }" @click="activeSection = 'storage'"><Database v-if="windowed" :size="17" />{{ windowed ? '数据存储' : '数据' }}</button>
      <button type="button" :class="{ active: activeSection === 'updates' }" @click="activeSection = 'updates'"><Download v-if="windowed" :size="17" />{{ windowed ? '版本与更新' : '更新' }}</button>
    </nav>

    <div v-if="activeSection === 'general'" class="settings-section">
      <p class="settings-group-label">应用</p>
      <div class="settings-panel">
        <section class="setting-row">
          <div class="setting-copy"><strong>应用外观</strong><span>选择浅色、深色或跟随系统外观</span></div>
          <UiSelect :model-value="appearance" :options="appearanceOptions" label="应用外观" @update:model-value="updateAppearance($event as 'system' | 'light' | 'dark')" />
        </section>
        <section class="setting-row">
          <div class="setting-copy"><strong>关闭窗口时</strong><span>设置关闭主窗口时应用采取的操作</span></div>
          <UiSelect v-model="closeBehavior" :options="closeBehaviorOptions" label="关闭窗口行为" :disabled="busy" @change="saveCloseBehavior" />
        </section>
        <section class="setting-row setting-row-status">
          <div class="setting-copy"><strong>本地数据库</strong><span>{{ status?.databaseReady ? '已准备就绪' : '等待初始化' }}</span></div>
          <span class="setting-state" :class="{ ready: status?.databaseReady }">{{ status?.databaseReady ? '正常' : '准备中' }}</span>
        </section>
      </div>
    </div>

    <div v-else-if="activeSection === 'storage'" class="settings-section">
      <p class="settings-group-label">本地数据</p>
      <div class="settings-panel">
        <section class="setting-row setting-row-wide data-directory-setting">
          <div class="setting-copy"><strong>数据目录</strong><span :title="status?.dataDirectory">{{ status?.dataDirectory || '尚未创建' }}</span></div>
          <div class="header-actions"><button type="button" class="secondary-command" :disabled="busy" @click="resetDataDirectory">默认</button><button type="button" class="primary-command" :disabled="busy" @click="chooseDataDirectory">更改</button></div>
        </section>
        <section class="setting-row setting-row-wide database-file-setting">
          <div class="setting-copy"><strong>数据库文件</strong><span :title="status?.databasePath">{{ status?.databasePath || '尚未创建' }}</span></div>
          <button type="button" class="primary-command" :disabled="busy" @click="chooseDatabaseFile">更改</button>
        </section>
        <section class="setting-row setting-row-wide backup-setting">
          <div class="setting-copy"><strong>完整数据备份</strong><span>书籍、章节、阅读进度和笔记</span></div>
          <div class="header-actions"><button type="button" class="secondary-command" :disabled="busy" @click="importBackup">恢复</button><button type="button" class="primary-command" :disabled="busy" @click="exportBackup">导出</button></div>
        </section>
      </div>
    </div>

    <UpdatesView v-else-if="windowed" embedded class="settings-window-updates" />
    <div v-else class="settings-section">
      <p class="settings-group-label">版本</p>
      <div class="settings-panel settings-update-panel">
        <section class="setting-row setting-row-wide">
          <div class="setting-copy"><strong>版本与更新</strong><span v-if="availableUpdate">可更新至 v{{ availableUpdate.version }}</span><span v-else-if="publishedUpdateVersion">v{{ publishedUpdateVersion }} 已发布</span><span v-else>当前 v{{ currentVersion || '...' }}</span></div>
          <RouterLink to="/settings/updates" class="primary-command">打开更新<ArrowRight :size="15" /></RouterLink>
        </section>
      </div>
    </div>
    <UiConfirmDialog :open="Boolean(pendingSettingAction)" :busy="busy" :title="pendingSettingAction?.title || '确认更改设置？'" :description="pendingSettingAction?.description || ''" :confirm-label="pendingSettingAction?.confirmLabel || '确认'" @close="pendingSettingAction = null" @confirm="confirmSettingAction" />
  </section>
</template>

<style scoped>
.settings-view--windowed { display: grid; grid-template-columns: 160px minmax(0,1fr); gap: 0; width: 100%; max-width: none; height: 100%; min-height: 0; padding: 0; margin: 0; }
.settings-view--windowed .settings-tabs { grid-column: 1; grid-row: 1; display: flex; flex-direction: column; align-items: stretch; justify-content: flex-start; width: 100%; gap: 3px; padding: 24px 9px; margin: 0; border: 0; border-right: 1px solid var(--ui-border); border-radius: 0; background: var(--ui-surface-2); }
.settings-view--windowed .settings-tabs > button { display: flex; align-items: center; gap: 11px; min-height: 40px; padding: 0 15px; border: 0; border-radius: 6px; text-align: left; font-size: 13px; color: var(--ui-text-2); background: transparent; }
.settings-view--windowed .settings-tabs > button.active { color: var(--ui-accent); background: var(--ui-selected); font-weight: 600; }
.settings-view--windowed .settings-tabs > button:hover { background: var(--ui-hover); }
.settings-view--windowed > .settings-section,.settings-view--windowed > .settings-window-updates { grid-column: 2; grid-row: 1; overflow: auto; min-height: 0; padding: 27px 32px; margin: 0; }
.settings-view--windowed .settings-panel { border: 0; background: transparent; box-shadow: none; }
.settings-view--windowed .setting-row { grid-template-columns: minmax(0, 1fr) auto; gap: 20px; padding: 20px 0; border-bottom: 1px solid var(--ui-border); border-radius: 0; }
.settings-view--windowed .setting-row > .ui-select,.settings-view--windowed .setting-row > .setting-state,.settings-view--windowed .setting-row > .primary-command,.settings-view--windowed .setting-row > .header-actions { grid-column: 2; justify-self: end; width: auto; }
.settings-view--windowed .setting-row > .ui-select { width: 158px; }
.settings-view--windowed .settings-group-label { margin-top: 2px; margin-bottom: 9px; font-size: 15px; color: var(--ui-text); }
.settings-view--windowed .setting-copy strong { font-weight: 500; }
.settings-view--windowed .setting-copy span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.settings-view--windowed .setting-row > .ui-select { min-width: 0; width: max-content; }
.settings-view--windowed :deep(.ui-select-trigger) { min-width: 128px; height: 26px; border-radius: 5px; }
.settings-view--windowed :deep(.ui-select-menu) { min-width: 158px; }
.settings-view--windowed .setting-copy > span { font-size: 11px; }
.settings-view--windowed :deep(.workspace-header h1) { font-size: 21px; }
</style>
