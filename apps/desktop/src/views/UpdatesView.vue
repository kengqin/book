<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import { ArrowUpRight, Download, RefreshCw, ShieldAlert } from 'lucide-vue-next'
import {
  availableUpdate,
  openUpdateWindow,
  initializeUpdateEvents,
  compareVersions,
  getCurrentVersion,
  getCachedReleaseManifest,
  isAutoCheckEnabled,
  isAutoDownloadEnabled,
  isBackgroundCheckEnabled,
  latestReadyVersion,
  loadReleaseManifest,
  publishedUpdateVersion,
  setAutoCheckEnabled,
  setAutoDownloadEnabled,
  setBackgroundCheckEnabled,
  updateError,
  updateMessage,
  type ReleaseEntry,
  type ReleaseManifestSource
} from '../services/release-center'
import PageHeader from '../components/ui/PageHeader.vue'
import UiConfirmDialog from '../components/ui/UiConfirmDialog.vue'
import UiSwitch from '../components/ui/UiSwitch.vue'
import { showGlobalMessage } from '../services/global-message'

const initialManifest = getCachedReleaseManifest()
const props = defineProps<{ embedded?: boolean; historyOnly?: boolean }>()
async function openHistoryWindow() {
  try {
    if (isTauri()) await invoke('open_release_history_window')
    else window.open(`${location.origin}${location.pathname}#/settings/history`, '_blank')
  } catch { showGlobalMessage('更新历史打开失败，请稍后重试', 'error') }
}
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

const visibleReleases = computed(() => {
  const ceiling = latestReadyVersion.value || (currentVersion.value === '0.0.0'
    ? releases.value.find((release) => release.published)?.version || currentVersion.value
    : currentVersion.value)
  return releases.value.filter((release) => release.published && compareVersions(release.version, ceiling) <= 0)
})

function updateAutoCheck() {
  setAutoCheckEnabled(autoCheck.value)
  showGlobalMessage(`自动检查更新已${autoCheck.value ? '开启' : '关闭'}`)
}

function updateBackgroundCheck() {
  setBackgroundCheckEnabled(backgroundCheck.value)
  showGlobalMessage(`后台定时检查已${backgroundCheck.value ? '开启' : '关闭'}`)
}

function updateAutoDownload() {
  setAutoDownloadEnabled(autoDownload.value)
  showGlobalMessage(`后台自动下载已${autoDownload.value ? '开启' : '关闭'}`)
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
  try {
    await openUrl(release.installerUrl)
  } catch {
    showGlobalMessage(`无法打开 v${release.version} 安装包，请稍后重试`, 'error', 6000)
  } finally {
    historicalInstallVersion.value = null
  }
}

function confirmHistoricalInstall() {
  const release = downgradeRelease.value
  downgradeRelease.value = null
  if (release) void openHistoricalInstaller(release)
}

async function openRelease(release: ReleaseEntry) {
  try {
    await openUrl(release.releaseUrl)
  } catch {
    showGlobalMessage(`无法打开 v${release.version} 版本详情页，请稍后重试`, 'error', 6000)
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
    await openUpdateWindow(true)
  } finally {
    checkingFromView.value = false
  }
}

onMounted(async () => {
  currentVersion.value = await getCurrentVersion()
  if (props.historyOnly) await refreshReleaseHistory()
  else await initializeUpdateEvents()
})
</script>

<template>
  <section class="workspace-view updates-view" :class="{ 'updates-view--embedded': embedded && !historyOnly }">
    <template v-if="!historyOnly">
    <PageHeader v-if="!embedded" title="版本与更新" />

    <section class="update-status-panel">
      <div class="version-identity">
        <strong>版本信息</strong>
        <span>v{{ currentVersion }}</span>
      </div>
      <div class="header-actions">
        <button type="button" class="secondary-command" :disabled="checkingFromView" @click="checkForUpdatesFromView">检查更新</button>
      </div>
    </section>
    <p class="update-feedback" role="status"><template v-if="availableUpdate">可更新至 v{{ availableUpdate.version }}</template><template v-else-if="publishedUpdateVersion">新版本 v{{ publishedUpdateVersion }} 已发布</template><template v-else-if="updateError">暂时无法检查更新，请稍后重试</template><template v-else>{{ updateMessage }}</template></p>

    <div class="auto-update-list">
      <div class="auto-update-setting">
        <span class="auto-update-copy"><strong>自动检查更新</strong><small>应用启动后静默检查稳定版本</small></span>
        <UiSwitch v-model="autoCheck" label="自动检查更新" @update:model-value="updateAutoCheck" />
      </div>
      <div class="auto-update-setting">
        <span class="auto-update-copy"><strong>后台定时检查</strong><small>每 1 小时静默检查一次，默认关闭</small></span>
        <UiSwitch v-model="backgroundCheck" label="后台定时检查" @update:model-value="updateBackgroundCheck" />
      </div>
      <div class="auto-update-setting">
        <span class="auto-update-copy"><strong>后台自动下载</strong><small>仅下载通过校验且无需备份的更新，仍由你确认安装和重启</small></span>
        <UiSwitch v-model="autoDownload" label="后台自动下载" @update:model-value="updateAutoDownload" />
      </div>
    </div>

    <footer class="update-footer"><button type="button" class="text-command update-history-link" @click="openHistoryWindow">更新历史</button></footer>
    </template>
    <section v-if="historyOnly" class="release-history">
      <header><small class="manifest-status">{{ historyRefreshing ? '正在同步...' : manifestSource === 'remote' ? '在线记录' : manifestSource === 'cached' ? '本地缓存' : '内置记录' }}</small><button type="button" class="text-command" :disabled="historyRefreshing" @click="refreshReleaseHistory"><RefreshCw :size="13" :class="{ spinning: historyRefreshing }" />刷新</button></header>
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
    <UiConfirmDialog :open="Boolean(downgradeRelease)" danger title="安装历史版本？" :description="`将从 ${currentVersion} 降级到 ${downgradeRelease?.version || ''}。旧版本可能无法读取新版数据库，请先在设置中导出完整备份。`" confirm-label="继续安装" @close="downgradeRelease = null" @confirm="confirmHistoricalInstall" />
  </section>
</template>
<style scoped>
.release-history { margin-top: 0; }
.release-history > header { min-height: 32px; margin-bottom: 4px; }
.release-history > header button { font-size: 12px; }
.release-content { padding-inline: 4px; }
.auto-update-copy small { max-width: 350px; }
.updates-view--embedded { display: flex; flex-direction: column; }
.update-footer { display: flex; justify-content: center; margin-top: auto; padding-top: 28px; }
.update-history-link { margin-top: 0; }
</style>
