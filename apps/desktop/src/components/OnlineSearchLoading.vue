<script setup lang="ts">
import { LoaderCircle } from 'lucide-vue-next'
defineProps<{ label: string; cancellable?: boolean }>()
defineEmits<{ cancel: [] }>()
</script>

<template>
  <div class="online-search-loading" aria-busy="true">
    <div class="online-skeleton-heading" role="status"><LoaderCircle :size="16" class="spinning" /><span>{{ label }}</span><button v-if="cancellable" type="button" class="text-command" @click="$emit('cancel')">取消</button></div>
    <div aria-hidden="true"><div v-for="row in 10" :key="row" class="online-skeleton-row"><i class="online-skeleton-site" /><i class="online-skeleton-title" :style="{ width: `${48 + row % 3 * 10}%` }" /><i class="online-skeleton-description" /></div></div>
  </div>
</template>

<style scoped>
.online-skeleton-heading { display: flex; align-items: center; gap: 9px; height: 36px; margin-bottom: 4px; color: var(--ui-text-2); font-size: 12px; }
.online-skeleton-heading > svg { color: var(--ui-accent); }
.online-skeleton-heading > button { flex: 0 0 auto; margin-left: 4px; padding-inline: 8px; font-size: 12px; }
.online-skeleton-row { display: grid; gap: 13px; padding: 23px 0; border-bottom: 1px solid var(--ui-border); }
.online-skeleton-row > i { position: relative; display: block; height: 10px; overflow: hidden; border-radius: 4px; background: color-mix(in srgb, var(--ui-text-3) 10%, var(--ui-surface)); }
.online-skeleton-row > i::after { content: ''; position: absolute; inset: 0; transform: translateX(-100%); background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--ui-surface) 75%, transparent), transparent); animation: online-skeleton-shimmer 1.5s ease-in-out infinite; }
.online-skeleton-site { width: 90px; }
.online-skeleton-row > .online-skeleton-title { height: 14px; }
.online-skeleton-description { width: 88%; }
@keyframes online-skeleton-shimmer { to { transform: translateX(100%); } }
@media (prefers-reduced-motion: reduce) { .online-skeleton-row > i::after { animation: none; } }
</style>
