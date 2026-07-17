<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useRouter } from 'vue-router'
import { BookOpen, LibraryBig, Search, Settings, Wrench } from 'lucide-vue-next'
import GlobalUpdateStatus from './components/GlobalUpdateStatus.vue'
import CloseBehaviorDialog from './components/CloseBehaviorDialog.vue'
import { availableUpdate, checkForUpdates, initializeUpdateEvents, isAutoCheckEnabled, publishedUpdateVersion } from './services/release-center'

const router = useRouter()
let unlistenImport: UnlistenFn | undefined
let unlistenOpen: UnlistenFn | undefined

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
  })
})

onBeforeUnmount(() => {
  unlistenImport?.()
  unlistenOpen?.()
})
</script>

<template>
  <div class="app-shell">
    <aside class="app-sidebar">
      <header>
        <span class="app-mark"><BookOpen :size="19" /></span>
        <div>
          <strong>小说书库</strong>
          <small>DESKTOP</small>
        </div>
      </header>

      <nav class="sidebar-primary" aria-label="主导航">
        <RouterLink to="/library"><LibraryBig :size="18" /><span>书架</span></RouterLink>
        <RouterLink to="/search"><Search :size="18" /><span>搜索</span></RouterLink>
        <RouterLink to="/tools"><Wrench :size="18" /><span>工具</span></RouterLink>
      </nav>

      <nav class="sidebar-secondary" aria-label="应用设置">
        <RouterLink to="/settings"><Settings :size="18" /><span>设置</span><i v-if="availableUpdate || publishedUpdateVersion" class="update-badge" /></RouterLink>
      </nav>
    </aside>

    <main class="app-workspace">
      <RouterView />
    </main>
  </div>
  <GlobalUpdateStatus />
  <CloseBehaviorDialog />
</template>
