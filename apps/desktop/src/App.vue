<script setup lang="ts">
import { onMounted } from 'vue'
import { BookOpen, Download, LibraryBig, Search, Settings } from 'lucide-vue-next'
import { availableUpdate, checkForUpdates, isAutoCheckEnabled } from './services/release-center'

onMounted(() => {
  if (isAutoCheckEnabled()) void checkForUpdates(true)
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

      <nav aria-label="主导航">
        <RouterLink to="/library"><LibraryBig :size="18" /><span>书架</span></RouterLink>
        <RouterLink to="/search"><Search :size="18" /><span>搜索</span></RouterLink>
        <RouterLink to="/updates"><Download :size="18" /><span>版本</span><i v-if="availableUpdate" class="update-badge" /></RouterLink>
        <RouterLink to="/settings"><Settings :size="18" /><span>设置</span></RouterLink>
      </nav>

      <footer>本地模式</footer>
    </aside>

    <main class="app-workspace">
      <RouterView />
    </main>
  </div>
</template>
