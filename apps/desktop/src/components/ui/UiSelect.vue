<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Check, ChevronDown } from 'lucide-vue-next'

export interface UiSelectOption {
  value: string
  label: string
}

const props = withDefaults(defineProps<{
  modelValue: string
  options: UiSelectOption[]
  label?: string
  disabled?: boolean
}>(), { disabled: false })

const emit = defineEmits<{
  'update:modelValue': [value: string]
  change: [value: string]
}>()

const open = ref(false)
const root = ref<HTMLElement>()
const selected = computed(() => props.options.find(option => option.value === props.modelValue) || props.options[0])

function closeOnOutside(event: PointerEvent) {
  if (root.value && !root.value.contains(event.target as Node)) open.value = false
}

function choose(value: string) {
  if (value !== props.modelValue) {
    emit('update:modelValue', value)
    emit('change', value)
  }
  open.value = false
}

function onKeydown(event: KeyboardEvent) {
  if (props.disabled) return
  if (event.key === 'Escape') {
    open.value = false
    return
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    open.value = !open.value
  }
}

onMounted(() => document.addEventListener('pointerdown', closeOnOutside))
onBeforeUnmount(() => document.removeEventListener('pointerdown', closeOnOutside))
</script>

<template>
  <div ref="root" class="ui-select" :class="{ 'is-open': open, 'is-disabled': disabled }">
    <button
      type="button"
      class="ui-select-trigger"
      :disabled="disabled"
      :aria-label="label"
      :aria-expanded="open"
      aria-haspopup="listbox"
      @click="open = !open"
      @keydown="onKeydown"
    >
      <span>{{ selected?.label || '请选择' }}</span>
      <ChevronDown :size="15" aria-hidden="true" />
    </button>
    <div v-if="open" class="ui-select-menu" role="listbox" :aria-label="label">
      <button
        v-for="option in options"
        :key="option.value"
        type="button"
        class="ui-select-option"
        :class="{ selected: option.value === modelValue }"
        role="option"
        :aria-selected="option.value === modelValue"
        @click="choose(option.value)"
      >
        <span>{{ option.label }}</span>
        <Check v-if="option.value === modelValue" :size="15" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>
