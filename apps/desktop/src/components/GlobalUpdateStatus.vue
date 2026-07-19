<script setup lang="ts">
import { computed, ref } from 'vue'
import { Download, RefreshCw, RotateCw, X } from 'lucide-vue-next'
import {
  availableUpdate,
  cancelUpdateDownload,
  checkForUpdates,
  downloadAvailableUpdate,
  installDownloadedUpdate,
  publishedUpdateVersion,
  updateError,
  updateProgress,
  updateRequiresBackup,
  updateStage
} from '../services/release-center'
import UiConfirmDialog from './ui/UiConfirmDialog.vue'

const visible = computed(() => (availableUpdate.value || publishedUpdateVersion.value) && updateStage.value !== 'idle')
const isError = computed(() => ['manifest-error', 'version-mismatch', 'signature-error', 'download-error', 'install-error', 'relaunch-error'].includes(updateStage.value))
const backupDialogOpen = ref(false)

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

function close() {
  if (updateStage.value === 'downloading' || updateStage.value === 'cancelling') {
    void cancelUpdateDownload()
  }
}
</script>

<template>
  <aside v-if="visible" class="global-update-status" aria-live="polite">
    <header>
      <div><Download :size="17" /><strong>应用更新</strong></div>
      <button v-if="updateStage === 'downloading'" type="button" class="icon-button" title="取消下载" @click="close"><X :size="15" /></button>
    </header>
    <p v-if="updateStage === 'available'">发现新版本 v{{ availableUpdate?.version }}</p>
    <p v-else-if="updateStage === 'downloading'">正在下载 v{{ availableUpdate?.version }} <strong>{{ updateProgress }}%</strong></p>
    <p v-else-if="updateStage === 'cancelling'">正在取消下载...</p>
    <p v-else-if="updateStage === 'downloaded'">v{{ availableUpdate?.version }} 已下载完成</p>
    <p v-else-if="updateStage === 'installing'">正在安装更新...</p>
    <p v-else-if="updateStage === 'published-but-not-ready'">v{{ publishedUpdateVersion }} 已发布，更新组件正在同步</p>
    <p v-else-if="isError" class="update-error">{{ updateError }}</p>
    <div v-if="updateStage === 'downloading' || updateStage === 'cancelling'" class="global-update-progress"><span :style="{ width: `${updateProgress}%` }" /></div>
    <button v-if="updateStage === 'available'" type="button" class="primary-command" @click="requestDownload"><Download :size="15" />下载更新</button>
    <button v-else-if="updateStage === 'downloaded' || updateStage === 'install-error'" type="button" class="primary-command" @click="installDownloadedUpdate"><RotateCw :size="15" />安装并重启</button>
    <button v-else-if="updateStage === 'download-error'" type="button" class="secondary-command" @click="requestDownload"><RefreshCw :size="15" />重试下载</button>
    <button v-else-if="updateStage === 'published-but-not-ready' || updateStage === 'version-mismatch'" type="button" class="secondary-command" @click="checkForUpdates(false)"><RefreshCw :size="15" />重新检查</button>
  </aside>
  <UiConfirmDialog :open="backupDialogOpen" title="确认已完成完整备份？" description="此版本升级前要求导出完整数据备份。确认备份完成后才会开始下载安装包。" confirm-label="已备份，继续下载" @close="backupDialogOpen = false" @confirm="confirmDownload" />
</template>
