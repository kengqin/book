<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowRight, Search, X } from 'lucide-vue-next'
import { searchDesktopLibrary, type DesktopSearchResult } from '../services/desktop-library'
import { formatChapterLabel } from '@novel-library/reader-core'
import PageHeader from '../components/ui/PageHeader.vue'

const router = useRouter()
const query = ref('')
const results = ref<DesktopSearchResult[]>([])
const searching = ref(false)
const searched = ref(false)
const error = ref('')

function resultChapterLabel(result: DesktopSearchResult) {
  return formatChapterLabel({ number: result.chapterNumber, originalLabel: result.originalLabel })
}

async function search() {
  if (!query.value.trim()) return
  searching.value = true
  searched.value = true
  error.value = ''
  try {
    results.value = await searchDesktopLibrary(query.value)
  } catch (cause) {
    results.value = []
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    searching.value = false
  }
}
</script>

<template>
  <section class="workspace-view">
    <PageHeader title="全文搜索" />
    <div class="search-stage">
      <form class="search-control" role="search" @submit.prevent="search"><Search :size="19" /><input v-model="query" aria-label="搜索书库" placeholder="搜索书名、作者、章名或正文" /><button v-if="query" type="button" class="clear-search" title="清空" @click="query = ''; results = []; searched = false; error = ''"><X :size="16" /></button><button type="submit" class="primary-command" :disabled="searching || !query.trim()">{{ searching ? '搜索中' : '搜索' }}</button></form>
      <div v-if="error" class="inline-error" role="alert">{{ error }}</div>
      <div v-if="searched && !results.length && !searching" class="search-empty" role="status">没有找到匹配内容</div>
      <div v-if="results.length" class="search-results"><button v-for="result in results" :key="`${result.bookId}:${result.chapterNumber}`" type="button" @click="router.push(`/read/${result.bookId}/${result.chapterNumber}`)"><div><small>{{ result.bookTitle }} · {{ result.kind === 'chapter' ? resultChapterLabel(result) : result.kind === 'volume' ? '分卷' : result.kind === 'frontmatter' ? '前置内容' : '附加内容' }}</small><strong>{{ result.chapterTitle }}</strong><p>{{ result.snippet }}</p></div><ArrowRight :size="17" /></button></div>
    </div>
  </section>
</template>
