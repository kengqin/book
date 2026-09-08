<script setup lang="ts">
import { LibraryBig, Search, Settings, Wrench } from 'lucide-vue-next'

defineProps<{
  hasUpdate?: boolean
  collapsed?: boolean
  width: number
  minWidth: number
  maxWidth: number
}>()

defineEmits<{
  'resize-start': [event: PointerEvent]
  'resize-keydown': [event: KeyboardEvent]
}>()
</script>

<template>
  <aside class="app-sidebar" :class="{ 'app-sidebar--collapsed': collapsed }">
    <nav id="sidebar-navigation" class="sidebar-primary" aria-label="主导航">
      <RouterLink to="/library" title="书架"><LibraryBig :size="18" /><span>书架</span></RouterLink>
      <RouterLink to="/search" title="搜索"><Search :size="18" /><span>搜索</span></RouterLink>
      <RouterLink to="/tools" title="工具"><Wrench :size="18" /><span>工具</span></RouterLink>
    </nav>

    <nav class="sidebar-secondary" aria-label="应用设置">
      <RouterLink to="/settings" title="设置"><Settings :size="18" /><span>设置</span><i v-if="hasUpdate" class="update-badge" /></RouterLink>
    </nav>
    <div
      v-if="!collapsed"
      class="sidebar-resize-handle"
      role="separator"
      tabindex="0"
      aria-label="调整侧栏宽度"
      aria-controls="sidebar-navigation"
      aria-orientation="vertical"
      :aria-valuemin="minWidth"
      :aria-valuemax="maxWidth"
      :aria-valuenow="width"
      :aria-valuetext="`${width} 像素`"
      title="拖动调整侧栏宽度，也可使用左右方向键"
      @pointerdown="$emit('resize-start', $event)"
      @keydown="$emit('resize-keydown', $event)"
    />
  </aside>
</template>
