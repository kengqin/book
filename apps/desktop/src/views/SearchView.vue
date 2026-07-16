<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowRight, Search, X } from 'lucide-vue-next'
import { searchDesktopLibrary, type DesktopSearchResult } from '../services/desktop-library'
import { formatChapterLabel } from '@novel-library/reader-core'

const router = useRouter()
const query = ref('')
const results = ref<DesktopSearchResult[]>([])
const searching = ref(false)
const searched = ref(false)

function resultChapterLabel(result: DesktopSearchResult) {
  return formatChapterLabel({ number: result.chapterNumber, originalLabel: result.originalLabel })
}

async function search() {
  if (!query.value.trim()) return
  searching.value = true
  searched.value = true
  try {
    results.value = await searchDesktopLibrary(query.value)
  } finally {
    searching.value = false
  }
}
</script>

<template>
  <section class="workspace-view">
    <header class="workspace-header"><div><p>FULL TEXT</p><h1>全文搜索</h1></div></header>
    <form class="search-control" @submit.prevent="search"><Search :size="19" /><input v-model="query" placeholder="搜索书名、作者、章名或正文" /><button v-if="query" type="button" class="clear-search" title="清空" @click="query = ''; results = []; searched = false"><X :size="16" /></button><button type="submit" class="primary-command" :disabled="searching || !query.trim()">{{ searching ? '搜索中' : '搜索' }}</button></form>
    <div v-if="searched && !results.length && !searching" class="view-status">没有找到匹配内容</div>
    <div v-else class="search-results"><button v-for="result in results" :key="`${result.bookId}:${result.chapterNumber}`" type="button" @click="router.push(`/read/${result.bookId}/${result.chapterNumber}`)"><div><small>{{ result.bookTitle }} · {{ result.kind === 'chapter' ? resultChapterLabel(result) : result.kind === 'volume' ? '分卷' : result.kind === 'frontmatter' ? '前置内容' : '附加内容' }}</small><strong>{{ result.chapterTitle }}</strong><p>{{ result.snippet }}</p></div><ArrowRight :size="17" /></button></div>
  </section>
</template>
