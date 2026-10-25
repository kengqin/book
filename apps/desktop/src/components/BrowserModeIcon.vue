<script setup lang="ts">
defineProps<{ docked?: boolean }>()
</script>

<template>
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <template v-if="docked">
      <path d="M14 6V4H4v16h10v-2M9 4v16" />
      <path d="M12 12h9m-3.5-3.5L21 12l-3.5 3.5" />
    </template>
    <template v-else>
      <rect x="3.5" y="4" width="17" height="16" rx="1" />
      <path d="M14 4v16M6.5 12h5m-2.5-2.5L6.5 12l2.5 2.5" />
    </template>
  </svg>
</template>
