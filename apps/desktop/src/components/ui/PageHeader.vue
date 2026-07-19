<script setup lang="ts">
defineProps<{
  title: string
}>()
</script>

<template>
  <header class="workspace-header page-header">
    <h1>{{ title }}</h1>
    <div v-if="$slots.actions" class="header-actions"><slot name="actions" /></div>
  </header>
</template>
