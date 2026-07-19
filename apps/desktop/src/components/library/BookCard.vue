<script setup lang="ts">
import { BookOpen } from 'lucide-vue-next'
import type { DesktopBookSummary } from '../../services/desktop-library'

defineProps<{
  book: DesktopBookSummary
}>()

defineEmits<{
  open: []
  read: []
}>()
</script>

<template>
  <article class="book-card">
    <button type="button" class="book-card-cover" :class="{ 'book-card-cover--image': book.coverDataUrl }" @click="$emit('open')">
      <img v-if="book.coverDataUrl" :src="book.coverDataUrl" alt="" />
      <span v-else>{{ book.title.slice(0, 1) }}</span>
      <i class="format-badge">{{ book.sourceFormat.toUpperCase() }}</i>
    </button>
    <div class="book-card-copy">
      <button type="button" @click="$emit('open')"><strong>{{ book.title }}</strong><span>{{ book.author || '佚名' }}</span></button>
      <button type="button" class="book-card-read" :title="book.progress ? '继续阅读' : '开始阅读'" @click="$emit('read')"><BookOpen :size="16" /></button>
    </div>
    <div class="book-card-meta"><span>{{ book.chapterCount }} 章</span><span>{{ book.totalWords.toLocaleString() }} 字</span><strong>{{ book.progress.toFixed(0) }}%</strong></div>
    <div class="book-card-progress" :aria-label="`阅读进度 ${book.progress.toFixed(1)}%`"><span :style="{ width: `${book.progress}%` }" /></div>
  </article>
</template>
