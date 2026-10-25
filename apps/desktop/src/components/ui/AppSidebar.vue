<script setup lang="ts">
import { Globe, LibraryBig, Search, Settings, Wrench } from 'lucide-vue-next'
import { openSettingsWindow } from '../../services/settings-window'
import { showGlobalError } from '../../services/global-message'

defineProps<{
  hasUpdate?: boolean
}>()
</script>

<template>
  <aside class="app-sidebar app-sidebar--collapsed">
    <nav id="sidebar-navigation" class="sidebar-primary" aria-label="主导航">
      <RouterLink to="/library" title="书架" aria-label="书架"><LibraryBig :size="18" :stroke-width="1.65" /><span>书架</span></RouterLink>
      <RouterLink to="/search" title="搜索" aria-label="搜索"><Search :size="18" :stroke-width="1.65" /><span>搜索</span></RouterLink>
      <RouterLink to="/online" title="在线找书" aria-label="在线找书"><Globe :size="18" :stroke-width="1.65" /><span>在线找书</span></RouterLink>
      <RouterLink to="/tools" title="工具" aria-label="工具"><Wrench :size="18" :stroke-width="1.65" /><span>工具</span></RouterLink>
    </nav>

    <nav class="sidebar-secondary" aria-label="应用设置">
      <button type="button" title="设置" aria-label="设置" @click="openSettingsWindow().catch(cause => showGlobalError(cause, '设置打开失败'))"><Settings :size="18" :stroke-width="1.65" /><span>设置</span><i v-if="hasUpdate" class="update-badge" /></button>
    </nav>
  </aside>
</template>
