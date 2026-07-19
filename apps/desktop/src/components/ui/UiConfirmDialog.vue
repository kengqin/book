<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  open: boolean
  title: string
  description: string
  confirmLabel?: string
  danger?: boolean
  busy?: boolean
}>(), {
  confirmLabel: '确认',
  danger: false,
  busy: false
})

const emit = defineEmits<{
  close: []
  confirm: []
}>()

const dialog = ref<HTMLDialogElement>()

watch(() => props.open, async open => {
  await nextTick()
  if (open && dialog.value && !dialog.value.open) dialog.value.showModal()
  if (!open && dialog.value?.open) dialog.value.close()
}, { immediate: true })

function close() {
  emit('close')
}

function cancel(event: Event) {
  event.preventDefault()
  close()
}
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="ui-dialog" @cancel="cancel" @close="open && close()">
      <h2>{{ title }}</h2>
      <p>{{ description }}</p>
      <div class="ui-dialog-actions">
        <button type="button" class="secondary-command" :disabled="busy" @click="close">取消</button>
        <button type="button" :class="danger ? 'danger-command-filled' : 'primary-command'" :disabled="busy" @click="emit('confirm')">
          {{ busy ? '正在处理' : confirmLabel }}
        </button>
      </div>
    </dialog>
  </Teleport>
</template>
