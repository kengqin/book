<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { open, save } from '@tauri-apps/plugin-dialog'
import { ArrowRight, Database, Download, FolderOpen, RefreshCw, RotateCcw, Upload } from 'lucide-vue-next'
import { changeDesktopDatabaseFile, changeDesktopDataDirectory, exportDesktopBackup, getDesktopStorageStatus, importDesktopBackup, resetDesktopDataDirectory, type DesktopStorageStatus } from '../services/desktop-library'
import { availableUpdate, getCurrentVersion, publishedUpdateVersion, updateMessage } from '../services/release-center'

const status = ref<DesktopStorageStatus>()
const busy = ref(false)
const message = ref('')
const error = ref('')
const currentVersion = ref('')

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
  if (!window.confirm('切换后会把当前书库复制到新目录；原数据库会保留。确认继续吗？')) return
  busy.value = true
  message.value = ''
  error.value = ''
  try {
    status.value = await changeDesktopDataDirectory(directory)
    message.value = `数据目录已切换到：${status.value.dataDirectory}`
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}

async function resetDataDirectory() {
  if (!window.confirm('确认恢复默认数据目录吗？当前书库会复制回默认目录。')) return
  busy.value = true
  message.value = ''
  error.value = ''
  try {
    status.value = await resetDesktopDataDirectory()
    message.value = `已恢复默认目录：${status.value.dataDirectory}`
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}

async function chooseDatabaseFile() {
  const databasePath = await save({
    title: '选择或新建小说书库数据库文件',
    defaultPath: status.value?.databasePath || 'library.db',
    filters: [{ name: 'SQLite 数据库', extensions: ['db', 'sqlite', 'sqlite3'] }]
  })
  if (!databasePath) return
  if (!window.confirm('切换数据库文件后，当前书库会复制到新文件；已有数据库文件则直接校验并使用。确认继续吗？')) return
  busy.value = true
  message.value = ''
  error.value = ''
  try {
    status.value = await changeDesktopDatabaseFile(databasePath)
    message.value = `数据库文件已切换到：${status.value.databasePath}`
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  await Promise.all([
    refreshStatus(),
    getCurrentVersion().then(version => { currentVersion.value = version })
  ])
})
</script>

<template>
  <section class="workspace-view">
    <header class="workspace-header"><div><p>APPLICATION</p><h1>设置</h1></div></header>
    <div class="settings-list">
      <section><Database :size="20" /><div><strong>本地数据库</strong><span>{{ status?.databaseReady ? '可用' : '等待初始化' }}</span></div></section>
      <section class="data-directory-setting"><FolderOpen :size="20" /><div><strong>数据目录</strong><span>{{ status?.dataDirectory || '尚未创建' }}</span></div><div class="header-actions"><button type="button" class="secondary-command" :disabled="busy" title="恢复默认目录" @click="resetDataDirectory"><RotateCcw :size="16" />默认</button><button type="button" class="primary-command" :disabled="busy" @click="chooseDataDirectory"><FolderOpen :size="16" />更改</button></div></section>
      <section class="database-file-setting"><Database :size="20" /><div><strong>数据库文件</strong><span>{{ status?.databasePath || '尚未创建' }}</span></div><button type="button" class="primary-command" :disabled="busy" @click="chooseDatabaseFile"><Database :size="16" />更改</button></section>
      <section class="backup-setting"><Download :size="20" /><div><strong>完整数据备份</strong><span>导出或恢复书籍、章节、阅读进度和本地笔记</span></div><div class="header-actions"><button type="button" class="secondary-command" :disabled="busy" @click="importBackup"><Upload :size="16" />恢复</button><button type="button" class="primary-command" :disabled="busy" @click="exportBackup"><Download :size="16" />导出</button></div></section>
      <section class="updates-setting"><RefreshCw :size="20" /><div><strong>版本与更新</strong><span v-if="availableUpdate">当前 v{{ currentVersion }} · 可更新至 v{{ availableUpdate.version }}</span><span v-else-if="publishedUpdateVersion">当前 v{{ currentVersion }} · v{{ publishedUpdateVersion }} 已发布</span><span v-else>当前 v{{ currentVersion || '...' }} · {{ updateMessage || '管理更新与历史版本' }}</span></div><RouterLink to="/settings/updates" class="secondary-command">查看<ArrowRight :size="16" /></RouterLink></section>
    </div>
    <p v-if="message" class="settings-message">{{ message }}</p>
    <p v-if="error" class="inline-error">{{ error }}</p>
  </section>
</template>
