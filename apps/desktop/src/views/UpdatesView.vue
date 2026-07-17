<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { openUrl } from '@tauri-apps/plugin-opener'
import { ArrowUpRight, CheckCircle2, Download, History, RefreshCw, ShieldAlert } from 'lucide-vue-next'
import {
  availableUpdate,
  checkForUpdates,
  cancelUpdateDownload,
  compareVersions,
  downloadAvailableUpdate,
  getCurrentVersion,
  installDownloadedUpdate,
  isAutoCheckEnabled,
  isAutoDownloadEnabled,
  isBackgroundCheckEnabled,
  loadReleaseManifest,
  publishedUpdateVersion,
  setAutoCheckEnabled,
  setAutoDownloadEnabled,
  setBackgroundCheckEnabled,
  updateChecking,
  updateCompatibilityNote,
  updateError,
  updateMessage,
  updateProgress,
  updateStage,
  type ReleaseEntry
} from '../services/release-center'

const currentVersion = ref('0.0.0')
const releases = ref<ReleaseEntry[]>([])
const manifestSource = ref<'remote' | 'local'>('local')
const autoCheck = ref(isAutoCheckEnabled())
const backgroundCheck = ref(isBackgroundCheckEnabled())
const autoDownload = ref(isAutoDownloadEnabled())
const loadingHistory = ref(true)

const currentRelease = computed(() => releases.value.find((release) => release.version === currentVersion.value))

function updateAutoCheck() {
  setAutoCheckEnabled(autoCheck.value)
}

function updateBackgroundCheck() {
  setBackgroundCheckEnabled(backgroundCheck.value)
}

function updateAutoDownload() {
  setAutoDownloadEnabled(autoDownload.value)
}

async function installHistoricalVersion(release: ReleaseEntry) {
  const isDowngrade = compareVersions(release.version, currentVersion.value) < 0
  if (isDowngrade && !window.confirm(`将从 ${currentVersion.value} 降级到 ${release.version}。旧版本可能无法读取新版数据库，请先在设置中导出备份。仍要继续吗？`)) return
  updateError.value = ''
  try {
    await openUrl(release.installerUrl)
  } catch {
    updateError.value = `无法打开 v${release.version} 安装包，请稍后重试`
  }
}

async function openRelease(release: ReleaseEntry) {
  updateError.value = ''
  try {
    await openUrl(release.releaseUrl)
  } catch {
    updateError.value = `无法打开 v${release.version} Release 页面，请稍后重试`
  }
}

onMounted(async () => {
  currentVersion.value = await getCurrentVersion()
  const result = await loadReleaseManifest()
  releases.value = result.manifest.releases
  manifestSource.value = result.remote ? 'remote' : 'local'
  loadingHistory.value = false
})
</script>

<template>
  <section class="workspace-view updates-view">
    <header class="workspace-header"><div><p>RELEASES</p><h1>版本与更新</h1></div></header>

    <section class="update-status-panel">
      <div class="version-identity">
        <span>当前版本</span>
        <strong>v{{ currentVersion }}</strong>
        <small>{{ currentRelease?.title || '小说书库桌面端' }}</small>
      </div>
      <div class="update-status-copy">
        <strong v-if="availableUpdate">可更新至 v{{ availableUpdate.version }}</strong>
        <strong v-else-if="publishedUpdateVersion"><RefreshCw :size="17" />发现新版本 v{{ publishedUpdateVersion }}</strong>
        <strong v-else><CheckCircle2 :size="17" />{{ updateMessage || '版本状态正常' }}</strong>
        <span v-if="updateError" class="update-error">{{ updateError }}</span>
        <span v-else-if="updateCompatibilityNote" class="update-error">{{ updateCompatibilityNote }}</span>
        <span v-else>{{ autoCheck ? '启动时自动检查更新' : '仅手动检查更新' }}</span>
        <div v-if="updateStage === 'downloading' || updateStage === 'cancelling'" class="update-progress"><span :style="{ width: `${updateProgress}%` }" /></div>
      </div>
      <div class="header-actions">
        <button type="button" class="secondary-command" :disabled="updateChecking || ['downloading', 'cancelling', 'downloaded', 'installing', 'install-error'].includes(updateStage)" @click="checkForUpdates(false)"><RefreshCw :size="16" :class="{ spinning: updateChecking }" />检查</button>
        <button v-if="availableUpdate && (updateStage === 'available' || updateStage === 'download-error')" type="button" class="primary-command" @click="downloadAvailableUpdate()"><Download :size="16" />下载更新</button>
        <button v-else-if="updateStage === 'downloading'" type="button" class="secondary-command" @click="cancelUpdateDownload">取消下载</button>
        <button v-else-if="updateStage === 'downloaded' || updateStage === 'install-error'" type="button" class="primary-command" @click="installDownloadedUpdate"><RefreshCw :size="16" />安装并重启</button>
      </div>
    </section>

    <label class="auto-update-setting">
      <input v-model="autoCheck" type="checkbox" @change="updateAutoCheck">
      <span><strong>自动检查更新</strong><small>应用启动后静默检查稳定版本</small></span>
    </label>
    <label class="auto-update-setting">
      <input v-model="backgroundCheck" type="checkbox" @change="updateBackgroundCheck">
      <span><strong>后台定时检查</strong><small>每 6 小时静默检查一次，默认关闭</small></span>
    </label>
    <label class="auto-update-setting">
      <input v-model="autoDownload" type="checkbox" @change="updateAutoDownload">
      <span><strong>后台自动下载</strong><small>仅下载通过校验且无需备份的更新，仍由你确认安装和重启</small></span>
    </label>

    <section class="release-history">
      <header><div><History :size="18" /><strong>历史更新</strong></div><small>{{ manifestSource === 'remote' ? '在线记录' : '离线记录' }}</small></header>
      <div v-if="loadingHistory" class="view-status"><span>正在读取版本记录...</span></div>
      <article v-for="release in releases" v-else :key="release.version" class="release-entry">
        <div class="release-rail"><span /><i /></div>
        <div class="release-content">
          <header>
            <div><strong>v{{ release.version }}</strong><span v-if="release.version === currentVersion">当前</span><span v-else-if="release.channel === 'preview'">预览</span></div>
            <time>{{ release.date }}</time>
          </header>
          <h2>{{ release.title }}</h2>
          <section v-for="section in release.sections" :key="section.title">
            <h3>{{ section.title }}</h3>
            <ul><li v-for="item in section.items" :key="item">{{ item }}</li></ul>
          </section>
          <div v-if="release.published" class="release-actions">
            <button type="button" class="text-command" @click="openRelease(release)"><ArrowUpRight :size="15" />Release</button>
            <button v-if="release.version !== currentVersion" type="button" class="secondary-command" @click="installHistoricalVersion(release)"><Download :size="15" />安装此版本</button>
            <code v-if="release.sha256" :title="release.sha256">SHA256 {{ release.sha256.slice(0, 12) }}...</code>
          </div>
          <div v-else class="release-pending"><ShieldAlert :size="15" />版本记录已同步，安装包尚未准备完成</div>
        </div>
      </article>
    </section>
  </section>
</template>
