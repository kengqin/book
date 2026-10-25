<script setup lang="ts">
import { Trash2, X } from 'lucide-vue-next'
defineProps<{ recent: string[] }>()
defineEmits<{ search: [query: string]; remove: [query: string]; clear: [] }>()
</script>

<template>
  <div class="online-search-empty">
    <svg width="204" height="146" viewBox="0 0 204 146" fill="none" aria-hidden="true">
      <circle cx="104" cy="74" r="56" fill="var(--ui-accent)" opacity=".035" />
      <circle cx="104" cy="74" r="66" stroke="var(--ui-text-3)" stroke-dasharray="2 7" opacity=".12" />
      <path d="M40 108C58 100 80 102 102 113C124 102 146 100 164 108" stroke="var(--ui-accent)" stroke-width="2" opacity=".15" />
      <path d="M45 43C65 38 83 43 102 54V109C83 97 65 94 45 98V43Z" fill="var(--ui-surface)" stroke="var(--ui-text-3)" stroke-width="1.5" opacity=".55" />
      <path d="M159 43C139 38 121 43 102 54V109C121 97 139 94 159 98V43Z" fill="var(--ui-surface)" stroke="var(--ui-text-3)" stroke-width="1.5" opacity=".55" />
      <path d="M58 56C68 55 79 58 90 64M58 67C69 67 79 70 90 75M58 78C68 78 78 81 87 85" stroke="var(--ui-text-3)" stroke-linecap="round" opacity=".22" />
      <path d="M115 65C127 59 137 56 147 56M115 76C127 70 137 67 147 67M118 85C129 80 139 78 147 78" stroke="var(--ui-accent)" stroke-linecap="round" opacity=".26" />
      <path d="M135 39V63L141 59L147 63V39" fill="var(--ui-accent)" opacity=".15" />
      <circle cx="44" cy="28" r="3" fill="var(--ui-accent)" opacity=".18" />
      <circle cx="174" cy="83" r="2" fill="var(--ui-text-3)" opacity=".25" />
      <path d="M163 22V30M159 26H167" stroke="var(--ui-accent)" stroke-linecap="round" opacity=".3" />
    </svg>
    <span>发现下一本好书</span>
    <div v-if="recent.length" class="online-recent" aria-label="最近搜索">
      <div v-for="query in recent.slice(0, 4)" :key="query" class="online-recent-chip">
        <button type="button" class="online-recent-query" :title="query" @click="$emit('search', query)">{{ query }}</button>
        <button type="button" class="online-recent-remove" :aria-label="`删除搜索记录：${query}`" title="删除记录" @click="$emit('remove', query)"><X :size="11" /></button>
      </div>
      <button type="button" class="online-recent-clear" aria-label="清空搜索记录" title="清空搜索记录" @click="$emit('clear')"><Trash2 :size="13" /></button>
    </div>
  </div>
</template>

<style scoped>
.online-search-empty { min-height: 380px; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 10px; }
.online-search-empty > span { color: var(--ui-text-3); font-size: 13px; letter-spacing: .08em; }
.online-recent { position: relative; max-width: min(600px, calc(100% - 60px)); display: flex; justify-content: center; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
.online-recent-chip { display: flex; align-items: center; max-width: 230px; border-radius: 15px; background: var(--ui-hover); }
.online-recent button { display: flex; align-items: center; justify-content: center; border: 0; color: var(--ui-text-3); background: transparent; font-size: 11px; cursor: pointer; }
.online-recent .online-recent-query { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 6px 11px; border-radius: 15px; transition: padding-right .18s ease; }
.online-recent .online-recent-remove { width: 0; height: 25px; padding: 0; overflow: hidden; flex-shrink: 0; border-radius: 50%; opacity: 0; transform: translateX(-4px) scale(.8); transition: width .18s ease, opacity .18s ease, transform .18s ease; }
.online-recent-remove > svg { flex-shrink: 0; }
.online-recent-chip:hover .online-recent-query,.online-recent-chip:focus-within .online-recent-query { padding-right: 3px; }
.online-recent-chip:hover .online-recent-remove,.online-recent-chip:focus-within .online-recent-remove { width: 24px; opacity: 1; transform: translateX(0) scale(1); }
.online-recent-clear { position: absolute; right: -34px; top: 0; width: 27px; height: 27px; border-radius: 50%; opacity: 0; transform: translateX(-5px); transition: opacity .18s ease, transform .18s ease; }
.online-recent:hover .online-recent-clear,.online-recent:focus-within .online-recent-clear { opacity: 1; transform: translateX(0); }
.online-recent-remove:hover,.online-recent-clear:hover { background: var(--ui-hover); }
.online-recent button:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 2px; }
.online-recent button:hover { color: var(--ui-text); }
@media (prefers-reduced-motion: reduce) { .online-recent button { transition: none; } }
</style>
