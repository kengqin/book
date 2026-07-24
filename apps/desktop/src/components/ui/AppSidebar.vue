<script setup lang="ts">
import { BookOpen, LibraryBig, PanelLeftClose, Search, Settings, Wrench } from 'lucide-vue-next'

defineProps<{
  hasUpdate?: boolean
  collapsed?: boolean
}>()

defineEmits<{
  toggle: []
}>()
</script>

<template>
  <aside class="app-sidebar" :class="{ 'app-sidebar--collapsed': collapsed }">
    <header class="sidebar-brand">
      <span class="app-mark"><BookOpen :size="18" /></span>
      <div class="sidebar-brand-copy">
        <strong>小说书库</strong>
      </div>
      <button type="button" class="sidebar-toggle" title="收起侧栏" aria-label="收起侧栏" @click="$emit('toggle')"><PanelLeftClose :size="18" /></button>
    </header>

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
