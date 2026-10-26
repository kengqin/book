<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Download, RefreshCw, RotateCw, X } from 'lucide-vue-next'
import {
  availableUpdate,
  cancelUpdateDownload,
  checkForUpdates,
  downloadAvailableUpdate,
  dismissUpdate,
  ignoreUpdate,
  ignoredUpdateVersion,
  updatePromptDismissed,
  installDownloadedUpdate,
  restartAfterUpdate,
  publishedUpdateVersion,
  updateError,
  updateCompatibilityNote,
  updateProgress,
  updateRequiresBackup,
  updateStage,
  updateChecking
} from '../services/release-center'
import appIcon from '../../src-tauri/icons/128x128.png'
import UiConfirmDialog from './ui/UiConfirmDialog.vue'
import { showGlobalMessage } from '../services/global-message'

const props = defineProps<{ windowed?: boolean; currentVersion?: string }>()
const emit = defineEmits<{ close: [] }>()
const visible = computed(() => props.windowed || (availableUpdate.value || publishedUpdateVersion.value) && updateStage.value !== 'idle' && !updatePromptDismissed.value && ignoredUpdateVersion.value !== availableUpdate.value?.version)
const isError = computed(() => ['manifest-error', 'version-mismatch', 'signature-error', 'download-error', 'install-error', 'relaunch-error'].includes(updateStage.value))
const backupDialogOpen = ref(false)
const checking = computed(() => updateChecking.value || props.windowed && !props.currentVersion && updateStage.value === 'idle')

watch(updateError, value => {
  if (value && !props.windowed) showGlobalMessage(value, 'error', 6000)
})

watch(updateCompatibilityNote, value => {
  if (value && !props.windowed) showGlobalMessage(value, 'warning', 6000)
})

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
  if (props.windowed) emit('close')
  else void dismissUpdate()
}
async function ignore() { await ignoreUpdate(); if (props.windowed) emit('close') }
</script>

<template>
  <aside v-if="visible" class="global-update-status" :class="{ 'global-update-status--window': windowed }" aria-live="polite">
    <header v-if="!windowed">
      <div><Download :size="17" /><strong>应用更新</strong></div>
      <button type="button" class="icon-button global-update-close" title="稍后更新" aria-label="关闭更新提示" @click="close"><X :size="16" /></button>
    </header>
    <div class="update-identity"><img v-if="windowed" :src="appIcon" alt="" /><div class="update-status-copy">
    <p v-if="checking">正在检查更新...</p>
    <p v-else-if="windowed && updateStage === 'idle'">{{ currentVersion ? `小说书库 v${currentVersion} 已是最新版` : '正在读取更新状态...' }}</p>
    <p v-else-if="updateStage === 'available'">发现新版本 v{{ availableUpdate?.version }}</p>
    <p v-else-if="updateStage === 'downloading'">正在下载 v{{ availableUpdate?.version }} <strong>{{ updateProgress }}%</strong></p>
    <p v-else-if="updateStage === 'cancelling'">正在取消下载...</p>
    <p v-else-if="updateStage === 'downloaded'">v{{ availableUpdate?.version }} 已下载完成</p>
    <p v-else-if="updateStage === 'installing'">正在安装更新...</p>
    <p v-else-if="updateStage === 'installed'">更新已安装，等待重启</p>
    <p v-else-if="updateStage === 'published-but-not-ready'">v{{ publishedUpdateVersion }} 已发布，更新组件正在同步</p>
    <p v-else-if="isError">更新操作未完成</p>
    <p v-if="windowed && updateError" class="update-window-error">{{ updateError }}</p>
    <p v-else-if="windowed && updateCompatibilityNote" class="update-window-note">{{ updateCompatibilityNote }}</p>
    </div></div>
    <div v-if="checking || updateStage === 'downloading' || updateStage === 'cancelling'" class="global-update-progress" :class="{ 'update-check-progress': checking }"><span :style="{ width: checking ? '28%' : `${updateProgress}%` }" /></div>
    <footer class="global-update-actions">
      <template v-if="!checking && availableUpdate && !['installing', 'installed', 'relaunch-error'].includes(updateStage)"><button type="button" class="text-command" @click="close">稍后更新</button><button type="button" class="text-command" @click="ignore">忽略本次更新</button></template>
      <button v-if="checking" type="button" class="secondary-command" @click="close">取消</button>
      <button v-else-if="windowed && updateStage === 'idle'" type="button" class="primary-command" @click="close">我知道了</button>
      <button v-else-if="updateStage === 'available'" type="button" class="primary-command" @click="requestDownload"><Download :size="15" />下载更新</button>
      <button v-else-if="updateStage === 'downloaded' || updateStage === 'install-error'" type="button" class="primary-command" @click="installDownloadedUpdate"><RotateCw :size="15" />更新并重启</button>
      <button v-else-if="updateStage === 'installed' || updateStage === 'relaunch-error'" type="button" class="primary-command" @click="restartAfterUpdate"><RotateCw :size="15" />重启应用</button>
      <button v-else-if="updateStage === 'download-error'" type="button" class="secondary-command" @click="requestDownload"><RefreshCw :size="15" />重试下载</button>
      <button v-else-if="updateStage === 'downloading'" type="button" class="secondary-command" @click="cancelUpdateDownload">取消下载</button>
      <button v-else-if="['published-but-not-ready', 'version-mismatch', 'manifest-error', 'signature-error'].includes(updateStage)" type="button" class="secondary-command" @click="checkForUpdates(false)"><RefreshCw :size="15" />重新检查</button>
    </footer>
  </aside>
  <UiConfirmDialog :open="backupDialogOpen" title="确认已完成完整备份？" description="此版本升级前要求导出完整数据备份。确认备份完成后才会开始下载安装包。" confirm-label="已备份，继续下载" @close="backupDialogOpen = false" @confirm="confirmDownload" />
</template>
<style scoped>.global-update-actions { display: flex; align-items: center; gap: 12px; white-space: nowrap; }.global-update-actions .text-command { color: var(--ui-text-2); font-size: 12px; }.global-update-actions .primary-command,.global-update-actions .secondary-command { margin-left: auto; font-size: 12px; }.global-update-status--window { position: static; width: 100%; min-height: 0; display: flex; flex-direction: column; gap: 10px; padding: 12px 24px 14px; overflow-y: auto; border: 0; border-radius: 0; box-shadow: none; background: transparent; }.global-update-status--window .global-update-actions { flex-shrink: 0; margin-top: auto; }.global-update-status--window .update-identity,.global-update-status--window .global-update-progress { flex-shrink: 0; }.update-identity { display: flex; align-items: center; gap: 16px; min-width: 0; }.update-identity img { width: 48px; height: 48px; flex: 0 0 48px; }.update-status-copy { min-width: 0; overflow-wrap: anywhere; }.update-status-copy p { margin: 0; }.global-update-status--window .update-status-copy > p:first-child { font-size: 13px; font-weight: 600; }.update-status-copy .update-window-error,.update-status-copy .update-window-note { margin-top: 7px; font-size: 12px; line-height: 1.5; color: var(--ui-text-2); }.update-status-copy .update-window-error { color: var(--ui-danger); }.global-update-status--window .global-update-progress { overflow: hidden; border-radius: 999px; }.update-check-progress span { animation: update-check 1.2s ease-in-out infinite; }@keyframes update-check { from { transform: translateX(-110%); } to { transform: translateX(450%); } }</style>
