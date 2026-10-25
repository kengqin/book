<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import { X } from 'lucide-vue-next'
const props = defineProps<{ open: boolean; title: string }>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement>(), titleId = useId()
watch(() => props.open, async open => {
  await nextTick()
  if (open && !dialog.value?.open) dialog.value?.showModal()
  if (!open) dialog.value?.close()
}, { immediate: true })
onBeforeUnmount(() => dialog.value?.close())
</script>
<template>
  <Teleport to="body">
    <dialog ref="dialog" class="ui-dialog ui-content-dialog" :aria-labelledby="titleId" @cancel.prevent="emit('close')" @close="open && emit('close')" @click.self="emit('close')">
      <header class="ui-content-dialog-header"><h2 :id="titleId">{{ title }}</h2><button type="button" class="icon-button" aria-label="关闭弹框" @click="emit('close')"><X :size="17" /></button></header>
      <div class="ui-content-dialog-body"><slot v-if="open" /></div>
    </dialog>
  </Teleport>
</template>
<style scoped>
.ui-content-dialog { width: min(620px,calc(100vw - 48px)); max-height: min(680px,calc(100vh - 64px)); padding: 0; overflow: hidden; border-radius: 10px; }
.ui-content-dialog[open] { display: flex; flex-direction: column; }
.ui-content-dialog-header { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 20px; padding: 14px 18px 12px 24px; border-bottom: 1px solid var(--ui-border); }
.ui-content-dialog-header h2 { margin: 0; font-size: 14px; font-weight: 600; }
.ui-content-dialog-body { min-height: 0; overflow: auto; padding: 16px 24px 24px; }
</style>
