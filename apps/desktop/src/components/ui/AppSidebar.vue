<script setup lang="ts">
import { LibraryBig, Search, Settings, Wrench } from 'lucide-vue-next'

defineProps<{
  hasUpdate?: boolean
  collapsed?: boolean
}>()

</script>

<template>
  <aside class="app-sidebar" :class="{ 'app-sidebar--collapsed': collapsed }">
    <nav class="sidebar-primary" aria-label="主导航">
      <RouterLink to="/library" title="书架"><LibraryBig :size="18" /><span>书架</span></RouterLink>
      <RouterLink to="/search" title="搜索"><Search :size="18" /><span>搜索</span></RouterLink>
      <RouterLink to="/tools" title="工具"><Wrench :size="18" /><span>工具</span></RouterLink>
    </nav>

    <nav class="sidebar-secondary" aria-label="应用设置">
      <RouterLink to="/settings" title="设置"><Settings :size="18" /><span>设置</span><i v-if="hasUpdate" class="update-badge" /></RouterLink>
    </nav>
  </aside>
</template>
