<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowRight, Search } from 'lucide-vue-next'
import type { LibrarySearchResult } from '@novel-library/reader-core'
import { searchLibrary } from '../services/mobile-library'

const router = useRouter()
const query = ref('')
const results = ref<LibrarySearchResult[]>([])
const searching = ref(false)
const searched = ref(false)
const error = ref('')

async function search() {
  if (!query.value.trim()) return
  searching.value = true
  error.value = ''
  try { results.value = await searchLibrary(query.value); searched.value = true }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { searching.value = false }
}
</script>

<template>
  <section class="page search-page">
    <header class="page-header"><div><span class="eyebrow">LOCAL SEARCH</span><h1>全文搜索</h1></div></header>
    <form class="search-box" @submit.prevent="search"><Search :size="20" /><input v-model="query" type="search" placeholder="书名、作者、章名或正文" /><button type="submit" :disabled="searching || !query.trim()">{{ searching ? '搜索中' : '搜索' }}</button></form>
    <p v-if="error" class="error-card">{{ error }}</p>
    <div v-if="searched && !results.length" class="status-card">没有找到匹配内容</div>
    <div class="search-results"><button v-for="result in results" :key="`${result.bookId}:${result.chapterNumber}`" type="button" @click="router.push(`/read/${result.bookId}/${result.chapterNumber}`)"><span><small>{{ result.bookTitle }}</small><strong>{{ result.chapterTitle }}</strong><p>{{ result.snippet }}</p></span><ArrowRight :size="18" /></button></div>
  </section>
</template>
