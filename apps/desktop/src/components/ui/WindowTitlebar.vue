<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Copy, Minus, PanelLeftClose, PanelLeftOpen, Square, X } from 'lucide-vue-next'
import { isTauri } from '@tauri-apps/api/core'
import { type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'

type WindowResizeDirection = 'East' | 'North' | 'NorthEast' | 'NorthWest' | 'South' | 'SouthEast' | 'SouthWest' | 'West'

defineProps<{
  showSidebarToggle?: boolean
  sidebarCollapsed?: boolean
}>()

defineEmits<{
  toggleSidebar: []
}>()

const maximized = ref(false)
let unlistenResize: UnlistenFn | undefined

async function updateMaximized() {
  if (!isTauri()) return
  try {
    maximized.value = await getCurrentWindow().isMaximized()
  } catch (error) {
    console.warn('window-maximized-state-failed', error)
  }
}

function startWindowDragging(event: MouseEvent) {
  if (!isTauri() || event.button !== 0) return
  if (event.target instanceof Element && event.target.closest('button, .window-resize-handle')) return
  void getCurrentWindow().startDragging().catch(error => console.warn('window-drag-failed', error))
}

function startWindowResize(direction: WindowResizeDirection) {
  if (!isTauri()) return
  void getCurrentWindow().startResizeDragging(direction).catch(error => console.warn('window-resize-failed', error))
}

function minimizeWindow() {
  if (!isTauri()) return
  void getCurrentWindow().minimize().catch(error => console.warn('window-minimize-failed', error))
}

async function toggleMaximizeWindow() {
  if (!isTauri()) return
  try {
    await getCurrentWindow().toggleMaximize()
    await updateMaximized()
  } catch (error) {
    console.warn('window-maximize-failed', error)
  }
}

function closeWindow() {
  if (!isTauri()) return
  void getCurrentWindow().close().catch(error => console.warn('window-close-failed', error))
}

onMounted(async () => {
  if (!isTauri()) return
  await updateMaximized()
  unlistenResize = await getCurrentWindow().onResized(() => void updateMaximized())
})

onBeforeUnmount(() => unlistenResize?.())
</script>

<template>
  <header class="window-titlebar" @mousedown.left="startWindowDragging" @dblclick="toggleMaximizeWindow">
    <div class="window-titlebar-main">
      <div v-if="showSidebarToggle" class="window-titlebar-brand">
        <button
          type="button"
          class="window-sidebar-toggle"
          :title="sidebarCollapsed ? '展开侧栏' : '收起侧栏'"
          :aria-label="sidebarCollapsed ? '展开侧栏' : '收起侧栏'"
          @dblclick.stop
          @click.stop="$emit('toggleSidebar')"
        >
          <PanelLeftOpen v-if="sidebarCollapsed" :size="16" />
          <PanelLeftClose v-else :size="16" />
        </button>
        <strong>小说书库</strong>
      </div>
      <div class="window-controls">
        <button type="button" title="最小化" aria-label="最小化" @dblclick.stop @click.stop="minimizeWindow"><Minus :size="16" /></button>
        <button type="button" :title="maximized ? '还原' : '最大化'" :aria-label="maximized ? '还原' : '最大化'" @dblclick.stop @click.stop="toggleMaximizeWindow">
          <Copy v-if="maximized" :size="13" />
          <Square v-else :size="12" />
        </button>
        <button type="button" class="window-control-close" title="关闭" aria-label="关闭" @dblclick.stop @click.stop="closeWindow"><X :size="17" /></button>
      </div>
    </div>

    <template v-if="!maximized">
      <span class="window-resize-handle window-resize-handle--north" aria-hidden="true" @mousedown.left.stop.prevent="startWindowResize('North')" />
      <span class="window-resize-handle window-resize-handle--south" aria-hidden="true" @mousedown.left.stop.prevent="startWindowResize('South')" />
      <span class="window-resize-handle window-resize-handle--east" aria-hidden="true" @mousedown.left.stop.prevent="startWindowResize('East')" />
      <span class="window-resize-handle window-resize-handle--west" aria-hidden="true" @mousedown.left.stop.prevent="startWindowResize('West')" />
      <span class="window-resize-handle window-resize-handle--north-east" aria-hidden="true" @mousedown.left.stop.prevent="startWindowResize('NorthEast')" />
      <span class="window-resize-handle window-resize-handle--north-west" aria-hidden="true" @mousedown.left.stop.prevent="startWindowResize('NorthWest')" />
      <span class="window-resize-handle window-resize-handle--south-east" aria-hidden="true" @mousedown.left.stop.prevent="startWindowResize('SouthEast')" />
      <span class="window-resize-handle window-resize-handle--south-west" aria-hidden="true" @mousedown.left.stop.prevent="startWindowResize('SouthWest')" />
    </template>
  </header>
</template>
