<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { PanelLeftOpen } from 'lucide-vue-next'
import { isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useRoute, useRouter } from 'vue-router'
import GlobalUpdateStatus from './components/GlobalUpdateStatus.vue'
import GlobalMessage from './components/GlobalMessage.vue'
import CloseBehaviorDialog from './components/CloseBehaviorDialog.vue'
import AppSidebar from './components/ui/AppSidebar.vue'
import { useAppearance } from './composables/useAppearance'
import { availableUpdate, checkForUpdates, configureBackgroundUpdateChecks, initializeUpdateEvents, isAutoCheckEnabled, publishedUpdateVersion } from './services/release-center'

const router = useRouter()
const route = useRoute()
const immersive = computed(() => route.meta.layout === 'reader')
const sidebarCollapsed = ref(localStorage.getItem('novel-library-sidebar-collapsed') === 'true')
useAppearance()
let unlistenImport: UnlistenFn | undefined
let unlistenOpen: UnlistenFn | undefined

function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value
  localStorage.setItem('novel-library-sidebar-collapsed', String(sidebarCollapsed.value))
}

onMounted(async () => {
  if (!isTauri()) return
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
  })
})

onBeforeUnmount(() => {
  unlistenImport?.()
  unlistenOpen?.()
})
</script>

<template>
  <div class="app-shell" :class="{ 'app-shell--reader': immersive, 'app-shell--sidebar-collapsed': sidebarCollapsed && !immersive }">
    <AppSidebar v-if="!immersive" :has-update="Boolean(availableUpdate || publishedUpdateVersion)" :collapsed="sidebarCollapsed" @toggle="toggleSidebar" />

    <main class="app-workspace">
      <button v-if="sidebarCollapsed && !immersive" type="button" class="workspace-sidebar-toggle" title="展开侧栏" aria-label="展开侧栏" @click="toggleSidebar"><PanelLeftOpen :size="19" /></button>
      <RouterView />
    </main>
  </div>
  <GlobalUpdateStatus />
  <GlobalMessage />
  <CloseBehaviorDialog />
</template>
