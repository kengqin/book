<script setup lang="ts">
import WindowTitlebar from '../components/ui/WindowTitlebar.vue'
import SettingsView from './SettingsView.vue'
</script>
<template><div class="settings-window"><WindowTitlebar /><span class="settings-window-caption">设置</span><SettingsView windowed /></div></template>
<style scoped>.settings-window { --window-titlebar-height: 36px; position: relative; display: grid; grid-template-rows: 36px minmax(0,1fr); height: 100vh; overflow: hidden; background: var(--ui-surface); }.settings-window-caption { position: absolute; z-index: 10001; top: 0; left: 17px; line-height: 36px; font-size: 12px; color: var(--ui-text-2); pointer-events: none; }</style>
