<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { X } from 'lucide-vue-next'
import GlobalUpdateStatus from '../components/GlobalUpdateStatus.vue'
import { availableUpdate, checkForUpdates, getCurrentVersion, initializeUpdateEvents } from '../services/release-center'
const route = useRoute()
const currentVersion = ref('')
let unlisten: UnlistenFn | undefined
let unlistenState: UnlistenFn | undefined
function close() { if (isTauri()) void getCurrentWindow().close(); else window.close() }
onMounted(async () => {
  const version = await getCurrentVersion()
  unlistenState = await initializeUpdateEvents()
  if (isTauri()) unlisten = await listen('application-update-check', () => { void checkForUpdates(false) })
  const checking = route.query.check === '1' || !availableUpdate.value ? checkForUpdates(false) : Promise.resolve()
  currentVersion.value = version
  await checking
})
onBeforeUnmount(() => { unlisten?.(); unlistenState?.() })
</script>
<template><section class="software-update-window" role="dialog" aria-label="软件更新"><header data-tauri-drag-region><span data-tauri-drag-region>软件更新</span><button type="button" aria-label="关闭" @click="close"><X :size="16" /></button></header><GlobalUpdateStatus windowed :current-version="currentVersion" @close="close" /></section></template>
<style scoped>.software-update-window { height: 100vh; display: grid; grid-template-rows: 34px minmax(0, 1fr); background: var(--ui-surface); }.software-update-window > header { position: relative; display: grid; place-items: center; color: var(--ui-text-2); font-size: 12px; }.software-update-window > header button { position: absolute; top: 3px; right: 6px; display: grid; place-items: center; width: 30px; height: 28px; padding: 0; color: var(--ui-text-2); border: 0; border-radius: 5px; background: transparent; }.software-update-window > header button:hover { color: var(--ui-text); background: var(--ui-hover); }</style>
