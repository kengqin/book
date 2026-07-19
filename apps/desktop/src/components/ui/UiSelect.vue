<script setup lang="ts">
defineProps<{
  modelValue: string
  label?: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  change: [event: Event]
}>()

function onChange(event: Event) {
  const target = event.target as HTMLSelectElement
  emit('update:modelValue', target.value)
  emit('change', event)
}
</script>

<template>
  <select class="ui-select" :value="modelValue" :disabled="disabled" :aria-label="label" @change="onChange">
    <slot />
  </select>
</template>
