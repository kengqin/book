<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { open, save } from '@tauri-apps/plugin-dialog'
import { ArrowRight, Database, Download, FolderOpen, Minimize2, Palette, RefreshCw, RotateCcw, Upload } from 'lucide-vue-next'
import { changeDesktopDatabaseFile, changeDesktopDataDirectory, exportDesktopBackup, getCloseBehavior, getDesktopStorageStatus, importDesktopBackup, resetDesktopDataDirectory, setCloseBehavior, type CloseBehavior, type DesktopStorageStatus } from '../services/desktop-library'
import { availableUpdate, getCurrentVersion, publishedUpdateVersion } from '../services/release-center'
import PageHeader from '../components/ui/PageHeader.vue'
import UiConfirmDialog from '../components/ui/UiConfirmDialog.vue'
import UiSelect, { type UiSelectOption } from '../components/ui/UiSelect.vue'
import { useAppearance } from '../composables/useAppearance'

interface PendingSettingAction {
  title: string
  description: string
  confirmLabel: string
  run: () => Promise<void>
}

const status = ref<DesktopStorageStatus>()
const busy = ref(false)
const message = ref('')
const error = ref('')
const currentVersion = ref('')
const closeBehavior = ref<CloseBehavior>('ask')
const pendingSettingAction = ref<PendingSettingAction | null>(null)
const { appearance, setAppearance } = useAppearance()
const activeSection = ref<'general' | 'storage' | 'updates'>('general')

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

async function confirmSettingAction() {
  const action = pendingSettingAction.value
  if (!action || busy.value) return
  busy.value = true
  message.value = ''
  error.value = ''
  try {
    await action.run()
    pendingSettingAction.value = null
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}

async function refreshStatus() {
  try {
    status.value = await getDesktopStorageStatus()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

async function exportBackup() {
  const target = await save({
    defaultPath: `NovelLibrary-backup-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: '小说书库备份', extensions: ['json'] }]
  })
  if (!target) return
  busy.value = true
  message.value = ''
  error.value = ''
  try {
    const result = await exportDesktopBackup(target)
    message.value = `已备份 ${result.books} 本书、${result.chapters} 章、${result.notes} 篇笔记：${result.path}`
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
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
  message.value = ''
  error.value = ''
  try {
    const result = await importDesktopBackup(source)
    message.value = `已恢复 ${result.books} 本书、${result.chapters} 章、${result.notes} 篇笔记`
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
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
      message.value = `数据目录已切换到：${status.value.dataDirectory}`
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
      message.value = `已恢复默认目录：${status.value.dataDirectory}`
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
      message.value = `数据库文件已切换到：${status.value.databasePath}`
    }
  })
}

async function saveCloseBehavior() {
  busy.value = true
  message.value = ''
  error.value = ''
  try {
    closeBehavior.value = await setCloseBehavior(closeBehavior.value)
    message.value = '关闭窗口行为已保存'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  await Promise.all([
    refreshStatus(),
    getCurrentVersion().then(version => { currentVersion.value = version }),
    getCloseBehavior().then(behavior => { closeBehavior.value = behavior })
  ])
})
</script>

<template>
  <section class="workspace-view">
    <PageHeader title="设置" />
    <nav class="settings-tabs" aria-label="设置分类">
      <button type="button" :class="{ active: activeSection === 'general' }" @click="activeSection = 'general'">常规</button>
      <button type="button" :class="{ active: activeSection === 'storage' }" @click="activeSection = 'storage'">数据</button>
      <button type="button" :class="{ active: activeSection === 'updates' }" @click="activeSection = 'updates'">更新</button>
    </nav>

    <div v-if="activeSection === 'general'" class="settings-panel">
      <section class="setting-row">
        <div class="setting-icon"><Palette :size="18" /></div>
        <div class="setting-copy"><strong>应用外观</strong></div>
        <UiSelect :model-value="appearance" :options="appearanceOptions" label="应用外观" @update:model-value="setAppearance($event as 'system' | 'light' | 'dark')" />
      </section>
      <section class="setting-row">
        <div class="setting-icon"><Minimize2 :size="18" /></div>
        <div class="setting-copy"><strong>关闭窗口时</strong></div>
        <UiSelect v-model="closeBehavior" :options="closeBehaviorOptions" label="关闭窗口行为" :disabled="busy" @change="saveCloseBehavior" />
      </section>
      <section class="setting-row setting-row-status">
        <div class="setting-icon"><Database :size="18" /></div>
        <div class="setting-copy"><strong>本地数据库</strong><span>{{ status?.databaseReady ? '已准备就绪' : '等待初始化' }}</span></div>
        <span class="setting-state" :class="{ ready: status?.databaseReady }">{{ status?.databaseReady ? '正常' : '准备中' }}</span>
      </section>
    </div>

    <div v-else-if="activeSection === 'storage'" class="settings-panel">
      <section class="setting-row setting-row-wide data-directory-setting">
        <div class="setting-icon"><FolderOpen :size="18" /></div>
        <div class="setting-copy"><strong>数据目录</strong><span>{{ status?.dataDirectory || '尚未创建' }}</span></div>
        <div class="header-actions"><button type="button" class="secondary-command" :disabled="busy" @click="resetDataDirectory"><RotateCcw :size="15" />默认</button><button type="button" class="primary-command" :disabled="busy" @click="chooseDataDirectory"><FolderOpen :size="15" />更改</button></div>
      </section>
      <section class="setting-row setting-row-wide database-file-setting">
        <div class="setting-icon"><Database :size="18" /></div>
        <div class="setting-copy"><strong>数据库文件</strong><span>{{ status?.databasePath || '尚未创建' }}</span></div>
        <button type="button" class="primary-command" :disabled="busy" @click="chooseDatabaseFile"><Database :size="15" />更改</button>
      </section>
      <section class="setting-row setting-row-wide backup-setting">
        <div class="setting-icon"><Download :size="18" /></div>
        <div class="setting-copy"><strong>完整数据备份</strong><span>书籍、章节、阅读进度和笔记</span></div>
        <div class="header-actions"><button type="button" class="secondary-command" :disabled="busy" @click="importBackup"><Upload :size="15" />恢复</button><button type="button" class="primary-command" :disabled="busy" @click="exportBackup"><Download :size="15" />导出</button></div>
      </section>
    </div>

    <div v-else class="settings-panel settings-update-panel">
      <section class="setting-row setting-row-wide">
        <div class="setting-icon"><RefreshCw :size="18" /></div>
        <div class="setting-copy"><strong>版本与更新</strong><span v-if="availableUpdate">可更新至 v{{ availableUpdate.version }}</span><span v-else-if="publishedUpdateVersion">v{{ publishedUpdateVersion }} 已发布</span><span v-else>当前 v{{ currentVersion || '...' }}</span></div>
        <RouterLink to="/settings/updates" class="primary-command">打开更新<ArrowRight :size="15" /></RouterLink>
      </section>
    </div>
    <p v-if="message" class="settings-message" role="status">{{ message }}</p>
    <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
    <UiConfirmDialog :open="Boolean(pendingSettingAction)" :busy="busy" :title="pendingSettingAction?.title || '确认更改设置？'" :description="pendingSettingAction?.description || ''" :confirm-label="pendingSettingAction?.confirmLabel || '确认'" @close="pendingSettingAction = null" @confirm="confirmSettingAction" />
  </section>
</template>
