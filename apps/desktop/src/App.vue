<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useRoute, useRouter } from 'vue-router'
import GlobalMessage from './components/GlobalMessage.vue'
import OnlineVerificationStatus from './components/OnlineVerificationStatus.vue'
import CloseBehaviorDialog from './components/CloseBehaviorDialog.vue'
import AppSidebar from './components/ui/AppSidebar.vue'
import WindowTitlebar from './components/ui/WindowTitlebar.vue'
import { useAppearance } from './composables/useAppearance'
import { availableUpdate, checkForUpdates, configureBackgroundUpdateChecks, initializeUpdateEvents, isAutoCheckEnabled, publishedUpdateVersion } from './services/release-center'
import { showGlobalError } from './services/global-message'
import { initializeOnlineLibrary } from './services/online-library'
import { initializeWebBrowser, webBrowser } from './services/web-browser'
import WebBrowserPanel from './components/WebBrowserPanel.vue'
import SettingsWindowView from './views/SettingsWindowView.vue'

const router = useRouter()
const route = useRoute()
const browserShell = isTauri() && getCurrentWebview().label.startsWith('web-browser')
const browserMenuShell = isTauri() && getCurrentWebview().label === 'web-browser-menu'
const settingsShell = isTauri() && getCurrentWindow().label === 'settings'
const historyShell = isTauri() && getCurrentWindow().label === 'release-history'
const updateShell = isTauri() && getCurrentWindow().label === 'app-update'
const overlayShell = isTauri() && ['app-message', 'app-tooltip', 'app-progress'].includes(getCurrentWindow().label)
const auxiliaryShell = browserShell || settingsShell || overlayShell || historyShell || updateShell
const workspaceVersion = ref(0)
const immersive = computed(() => route.meta.layout === 'reader')
watch(immersive, suspended => {
  if (isTauri() && !auxiliaryShell) void invoke('set_web_browser_suspended', { suspended }).catch(cause => showGlobalError(cause, '网页侧栏状态更新失败'))
}, { immediate: true })
useAppearance()
let unlistenImport: UnlistenFn | undefined
let unlistenOpen: UnlistenFn | undefined
let unlistenSettings: UnlistenFn | undefined


onMounted(async () => {
  if (!isTauri()) return
  if (browserShell || overlayShell || historyShell || updateShell) return
  if (settingsShell) { void initializeUpdateEvents().catch(cause => showGlobalError(cause, '更新服务初始化失败')); return }
  void initializeWebBrowser().catch(cause => showGlobalError(cause, '网页浏览器初始化失败'))
  void initializeOnlineLibrary().catch(cause => showGlobalError(cause, '在线书架初始化失败'))
  try {
    unlistenSettings = await listen('settings-data-changed', async () => { await router.push('/library'); workspaceVersion.value++ })
    unlistenImport = await listen<{ path: string; existingId?: string }>('bridge-import-requested', async event => {
      await router.push('/library')
      window.setTimeout(() => window.dispatchEvent(new CustomEvent('novel-library-import', { detail: event.payload })), 0)
    })
    unlistenOpen = await listen<{ bookId: string; chapterNumber?: number }>('bridge-open-requested', event => {
      void router.push(`/read/${event.payload.bookId}/${event.payload.chapterNumber || 1}`)
    })
    void initializeUpdateEvents().then(() => {
      if (isAutoCheckEnabled()) void checkForUpdates(true)
      configureBackgroundUpdateChecks()
    }).catch(cause => showGlobalError(cause, '更新服务初始化失败，请重启应用后重试'))
  } catch (cause) {
    showGlobalError(cause, '应用服务初始化失败，请重启应用后重试')
  }
})

onBeforeUnmount(() => {
  unlistenImport?.()
  unlistenOpen?.()
  unlistenSettings?.()
})
</script>

<template>
  <RouterView v-if="overlayShell || historyShell || updateShell" />
  <SettingsWindowView v-else-if="settingsShell" />
  <RouterView v-else-if="browserShell" />
  <div v-else class="desktop-frame">
    <WindowTitlebar :show-brand="!immersive" />
    <div class="app-shell" :class="{ 'app-shell--reader': immersive, 'app-shell--sidebar-collapsed': !immersive }">
      <AppSidebar
        v-if="!immersive"
        :has-update="Boolean(availableUpdate || publishedUpdateVersion)"
      />

      <div class="desktop-content-area">
        <main class="app-workspace"><RouterView :key="workspaceVersion" /></main>
        <WebBrowserPanel v-if="!immersive && webBrowser.open && webBrowser.mode === 'side'" />
      </div>
    </div>
  </div>
  <template v-if="!overlayShell && !updateShell && !browserMenuShell"><GlobalMessage /></template>
  <OnlineVerificationStatus v-if="!auxiliaryShell" />
  <CloseBehaviorDialog v-if="!auxiliaryShell" />
</template>

<style scoped>
.desktop-content-area { display: grid; grid-template-columns: minmax(0, 1fr) auto; min-width: 0; min-height: 0; overflow: hidden; padding: 0 6px 6px 0; }
.desktop-content-area > .app-workspace { min-width: 0; min-height: 0; border-radius: 10px; }
.app-shell--reader .desktop-content-area { padding: 0; }
.app-shell--reader .app-workspace { border-radius: 0; scrollbar-gutter: auto; }
</style>
