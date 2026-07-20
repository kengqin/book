<script setup lang="ts">
import { computed, ref } from 'vue'
import { ArrowLeft, ArrowRight, Search, X } from 'lucide-vue-next'
import { withBase } from 'vitepress'
import library from '../../library.generated.json'

const props = defineProps<{ bookId: string }>()
const query = ref('')
const book = computed(() => library.books.find(item => item.id === props.bookId) ?? library.books[0])
const normalizedQuery = computed(() => query.value.trim().toLowerCase())
const filteredChapters = computed(() => {
  if (!normalizedQuery.value) return book.value.chapters
  return book.value.chapters.filter(chapter =>
    chapter.label.toLowerCase().includes(normalizedQuery.value) || chapter.title.toLowerCase().includes(normalizedQuery.value)
  )
})
const groups = computed(() => {
  const grouped = new Map<string, typeof book.value.chapters>()
  for (const chapter of filteredChapters.value) {
    const items = grouped.get(chapter.group) ?? []
    items.push(chapter)
    grouped.set(chapter.group, items)
  }
  return [...grouped.entries()].map(([group, chapters]) => ({ group, chapters }))
})
</script>

<template>
  <main class="book-catalogue-page">
    <header class="catalogue-header">
      <a :href="withBase(book.topicLink)"><ArrowLeft :size="16" /> 返回专题</a>
      <p>TABLE OF CONTENTS</p>
      <h1>{{ book.title }} · 完整目录</h1>
      <span>{{ book.range }}，共 {{ book.chapterCount }} 章</span>
    </header>

    <div class="catalogue-search">
      <Search :size="18" />
      <input v-model="query" type="search" :placeholder="`搜索${book.title}的章号或章名`" aria-label="搜索章节" />
      <button v-if="query" type="button" aria-label="清空搜索" @click="query = ''"><X :size="17" /></button>
      <output>{{ filteredChapters.length }} 章</output>
    </div>

    <div v-if="groups.length" class="catalogue-groups">
      <section v-for="group in groups" :key="group.group" class="catalogue-group">
        <h2>{{ group.chapters[0].label }}—{{ group.chapters.at(-1)!.label }}</h2>
        <div class="catalogue-links">
          <a v-for="chapter in group.chapters" :key="chapter.link" :href="withBase(chapter.link)">
            <span>{{ chapter.label }}</span>
            <strong>{{ chapter.title }}</strong>
            <ArrowRight :size="15" />
          </a>
        </div>
      </section>
    </div>
    <p v-else class="catalogue-empty">没有找到匹配章节</p>
  </main>
</template>
