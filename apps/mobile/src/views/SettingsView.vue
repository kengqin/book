<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Capacitor } from '@capacitor/core'
import { App as NativeApp } from '@capacitor/app'
import { DatabaseBackup, Download, ExternalLink, HardDrive, RefreshCw, Trash2, Upload } from 'lucide-vue-next'
import type { AvailableMobileUpdate, MobileUpdatePlatform } from '@novel-library/reader-protocol'
import { clearLibrary, exportLibrary, getLibraryStats, importLibraryBackup } from '../services/mobile-library'
import { exportAndShareJson, readBackupFile } from '../services/backup-transfer'
import { checkMobileUpdate, openMobileStore } from '../services/mobile-update'

const stats = ref({ books: 0, chapters: 0, usage: 0, quota: 0 })
const currentVersion = ref('0.1.0')
const busy = ref(false)
const message = ref('')
const error = ref('')
const update = ref<AvailableMobileUpdate | null>(null)
const backupInput = ref<HTMLInputElement>()
const platform = computed<MobileUpdatePlatform>(() => Capacitor.getPlatform() === 'android' ? 'android' : 'ios')

function size(value: number) {
  if (!value) return '0 MB'
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

async function refresh() {
  stats.value = await getLibraryStats()
  if (Capacitor.isNativePlatform()) currentVersion.value = (await NativeApp.getInfo()).version
}

async function run(action: () => Promise<void>) {
  busy.value = true
  error.value = ''
  message.value = ''
  try { await action() }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { busy.value = false }
}

async function exportAll() {
  await run(async () => { await exportAndShareJson(await exportLibrary(), `小说书库-完整备份-${new Date().toISOString().slice(0, 10)}`, '导出完整书库备份'); message.value = '完整备份已经生成'; await refresh() })
}

async function importBackup(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  await run(async () => { await importLibraryBackup(await readBackupFile(file)); await refresh(); message.value = '备份恢复完成' })
  input.value = ''
}

async function removeAll() {
  if (!window.confirm('确定清空本机全部书籍和阅读进度吗？此操作无法撤销。')) return
  await run(async () => { await clearLibrary(); await refresh(); message.value = '本地书库已清空' })
}

async function checkUpdate() {
  await run(async () => { update.value = await checkMobileUpdate({ currentVersion: currentVersion.value, platform: platform.value }); message.value = update.value ? `发现新版本 v${update.value.version}` : '当前已经是最新版本' })
}

onMounted(refresh)
</script>

<template>
  <section class="page settings-page">
    <header class="page-header"><div><span class="eyebrow">PREFERENCES</span><h1>设置</h1></div></header>
    <p v-if="message" class="success-card">{{ message }}</p><p v-if="error" class="error-card">{{ error }}</p>
    <section class="settings-section"><h2>本地数据</h2><div class="setting-card"><HardDrive :size="22" /><div><strong>{{ stats.books }} 本书 · {{ stats.chapters }} 项内容</strong><p>已使用 {{ size(stats.usage) }}{{ stats.quota ? ` / ${size(stats.quota)}` : '' }}</p></div></div><button type="button" :disabled="busy" @click="exportAll"><Download :size="20" /><span><strong>完整书库备份</strong><small>导出书籍、章节、封面和阅读进度</small></span></button><button type="button" :disabled="busy" @click="backupInput?.click()"><Upload :size="20" /><span><strong>恢复备份</strong><small>支持完整书库和单本书备份</small></span></button><input ref="backupInput" hidden type="file" accept="application/json,.json" @change="importBackup" /><button class="danger-setting" type="button" :disabled="busy" @click="removeAll"><Trash2 :size="20" /><span><strong>清空本地书库</strong><small>删除本机全部书籍和阅读进度</small></span></button></section>
    <section class="settings-section"><h2>版本与更新</h2><div class="setting-card"><DatabaseBackup :size="22" /><div><strong>小说书库 v{{ currentVersion }}</strong><p>{{ platform === 'android' ? 'Android APK 直装更新' : 'TestFlight / App Store 更新' }}</p></div></div><button type="button" :disabled="busy" @click="checkUpdate"><RefreshCw :size="20" :class="{ spinning: busy }" /><span><strong>检查更新</strong><small>验证官方版本清单和下载地址</small></span></button><button v-if="update" type="button" @click="openMobileStore(update)"><ExternalLink :size="20" /><span><strong>更新到 v{{ update.version }}</strong><small>打开官方安装渠道</small></span></button></section>
  </section>
</template>
