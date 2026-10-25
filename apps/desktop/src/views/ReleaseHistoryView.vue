<script setup lang="ts">
import WindowTitlebar from '../components/ui/WindowTitlebar.vue'
import UpdatesView from './UpdatesView.vue'
</script>
<template><div class="release-history-window"><WindowTitlebar /><span class="release-history-caption">更新历史</span><main><UpdatesView history-only embedded /></main></div></template>
<style scoped>
.release-history-window { --window-titlebar-height: 36px; position: relative; display: grid; grid-template-rows: 36px minmax(0,1fr); height: 100vh; background: var(--ui-surface); }
.release-history-caption { position: absolute; z-index: 10001; top: 0; left: 17px; line-height: 36px; color: var(--ui-text-2); font-size: 12px; pointer-events: none; }
.release-history-window > main { min-height: 0; overflow: auto; }
.release-history-window :deep(.updates-view) { width: 100%; padding: 12px 28px 32px; }
</style>
