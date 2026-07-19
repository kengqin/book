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
  getCachedReleaseManifest,
  installDownloadedUpdate,
  isAutoCheckEnabled,
  isAutoDownloadEnabled,
  isBackgroundCheckEnabled,
  latestReadyVersion,
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
  updateRequiresBackup,
  updateStage,
  type ReleaseEntry,
  type ReleaseManifestSource
} from '../services/release-center'
import PageHeader from '../components/ui/PageHeader.vue'
import UiConfirmDialog from '../components/ui/UiConfirmDialog.vue'

const initialManifest = getCachedReleaseManifest()
const currentVersion = ref('0.0.0')
const releases = ref<ReleaseEntry[]>(initialManifest.manifest.releases)
const manifestSource = ref<ReleaseManifestSource>(initialManifest.source)
const autoCheck = ref(isAutoCheckEnabled())
const backgroundCheck = ref(isBackgroundCheckEnabled())
const autoDownload = ref(isAutoDownloadEnabled())
const historyRefreshing = ref(false)
const checkingFromView = ref(false)
const historicalInstallVersion = ref<string | null>(null)
const downgradeRelease = ref<ReleaseEntry | null>(null)
const backupDialogOpen = ref(false)

const visibleReleases = computed(() => {
  const ceiling = latestReadyVersion.value || (currentVersion.value === '0.0.0'
    ? releases.value.find((release) => release.published)?.version || currentVersion.value
    : currentVersion.value)
  return releases.value.filter((release) => release.published && compareVersions(release.version, ceiling) <= 0)
})

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
  if (historicalInstallVersion.value) return
  const isDowngrade = compareVersions(release.version, currentVersion.value) < 0
  if (isDowngrade) {
    downgradeRelease.value = release
    return
  }
  await openHistoricalInstaller(release)
}

async function openHistoricalInstaller(release: ReleaseEntry) {
  historicalInstallVersion.value = release.version
  updateError.value = ''
  try {
    await openUrl(release.installerUrl)
  } catch {
    updateError.value = `无法打开 v${release.version} 安装包，请稍后重试`
  } finally {
    historicalInstallVersion.value = null
  }
}

function confirmHistoricalInstall() {
  const release = downgradeRelease.value
  downgradeRelease.value = null
  if (release) void openHistoricalInstaller(release)
}

function requestDownload() {
  if (updateRequiresBackup.value) {
    backupDialogOpen.value = true
    return
  }
  void downloadAvailableUpdate()
}

function confirmDownload() {
  backupDialogOpen.value = false
  void downloadAvailableUpdate(false, true)
}

async function openRelease(release: ReleaseEntry) {
  updateError.value = ''
  try {
    await openUrl(release.releaseUrl)
  } catch {
    updateError.value = `无法打开 v${release.version} Release 页面，请稍后重试`
  }
}

async function refreshReleaseHistory() {
  historyRefreshing.value = true
  try {
    const result = await loadReleaseManifest()
    releases.value = result.manifest.releases
    manifestSource.value = result.source
  } finally {
    historyRefreshing.value = false
  }
}

async function checkForUpdatesFromView() {
  if (checkingFromView.value) return
  checkingFromView.value = true
  try {
    await checkForUpdates(false)
    await refreshReleaseHistory()
  } finally {
    checkingFromView.value = false
  }
}

onMounted(async () => {
  currentVersion.value = await getCurrentVersion()
  const initialHistoryRefresh = refreshReleaseHistory()
  await checkForUpdates(true)
  await initialHistoryRefresh
  // The update check may have refreshed a stale cache with a newly published release.
  await refreshReleaseHistory()
})
</script>

<template>
  <section class="workspace-view updates-view">
    <PageHeader title="版本与更新" />

    <section class="update-status-panel">
      <div class="version-identity">
        <span>当前版本</span>
        <strong>v{{ currentVersion }}</strong>
      </div>
      <div class="update-status-copy">
        <strong v-if="availableUpdate">可更新至 v{{ availableUpdate.version }}</strong>
        <strong v-else-if="publishedUpdateVersion"><RefreshCw :size="17" />发现新版本 v{{ publishedUpdateVersion }}</strong>
        <strong v-else-if="updateError"><ShieldAlert :size="17" />更新状态暂不可用</strong>
        <strong v-else><CheckCircle2 :size="17" />{{ updateMessage || '版本状态正常' }}</strong>
        <span v-if="updateError" class="update-error">{{ updateError }}</span>
        <span v-else-if="updateCompatibilityNote" class="update-error">{{ updateCompatibilityNote }}</span>
        <div v-if="updateStage === 'downloading' || updateStage === 'cancelling'" class="update-progress"><span :style="{ width: `${updateProgress}%` }" /></div>
      </div>
      <div class="header-actions">
        <button type="button" class="secondary-command" :disabled="checkingFromView || updateChecking || ['downloading', 'cancelling', 'downloaded', 'installing', 'install-error'].includes(updateStage)" @click="checkForUpdatesFromView"><RefreshCw :size="16" :class="{ spinning: updateChecking || checkingFromView }" />检查</button>
        <button v-if="availableUpdate && (updateStage === 'available' || updateStage === 'download-error')" type="button" class="primary-command" @click="requestDownload"><Download :size="16" />下载更新</button>
        <button v-else-if="updateStage === 'downloading'" type="button" class="secondary-command" @click="cancelUpdateDownload">取消下载</button>
        <button v-else-if="updateStage === 'downloaded' || updateStage === 'install-error'" type="button" class="primary-command" @click="installDownloadedUpdate"><RefreshCw :size="16" />安装并重启</button>
      </div>
    </section>

    <div class="auto-update-list">
      <label class="auto-update-setting">
        <input v-model="autoCheck" type="checkbox" @change="updateAutoCheck">
        <span><strong>自动检查更新</strong><small>应用启动后静默检查稳定版本</small></span>
      </label>
      <label class="auto-update-setting">
        <input v-model="backgroundCheck" type="checkbox" @change="updateBackgroundCheck">
        <span><strong>后台定时检查</strong><small>每 1 小时静默检查一次，默认关闭</small></span>
      </label>
      <label class="auto-update-setting">
        <input v-model="autoDownload" type="checkbox" @change="updateAutoDownload">
        <span><strong>后台自动下载</strong><small>仅下载通过校验且无需备份的更新，仍由你确认安装和重启</small></span>
      </label>
    </div>

    <section class="release-history">
      <header><div><History :size="18" /><strong>历史更新</strong></div><small class="manifest-status"><RefreshCw v-if="historyRefreshing" :size="11" class="spinning" />{{ historyRefreshing ? '正在同步...' : manifestSource === 'remote' ? '在线记录' : manifestSource === 'cached' ? '本地缓存' : '内置记录' }}</small></header>
      <article v-for="release in visibleReleases" :key="release.version" class="release-entry">
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
            <button v-if="release.version !== currentVersion" type="button" class="secondary-command" :disabled="historicalInstallVersion !== null" @click="installHistoricalVersion(release)"><Download :size="15" />{{ historicalInstallVersion === release.version ? '打开中' : '安装此版本' }}</button>
            <code v-if="release.sha256" :title="release.sha256">SHA256 {{ release.sha256.slice(0, 12) }}...</code>
          </div>
          <div v-else-if="release.version !== currentVersion" class="release-pending"><ShieldAlert :size="15" />版本记录已同步，安装包尚未准备完成</div>
        </div>
      </article>
    </section>
    <UiConfirmDialog :open="backupDialogOpen" title="确认已完成完整备份？" description="此版本升级前要求导出完整数据备份。确认备份完成后才会开始下载安装包。" confirm-label="已备份，继续下载" @close="backupDialogOpen = false" @confirm="confirmDownload" />
    <UiConfirmDialog :open="Boolean(downgradeRelease)" danger title="安装历史版本？" :description="`将从 ${currentVersion} 降级到 ${downgradeRelease?.version || ''}。旧版本可能无法读取新版数据库，请先在设置中导出完整备份。`" confirm-label="继续安装" @close="downgradeRelease = null" @confirm="confirmHistoricalInstall" />
  </section>
</template>
