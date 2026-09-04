<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowRight, BookOpen, Search, X } from 'lucide-vue-next'
import { searchDesktopLibrary, type DesktopBookSearchResult, type DesktopSearchResult } from '../services/desktop-library'
import { formatChapterLabel } from '@novel-library/reader-core'
import PageHeader from '../components/ui/PageHeader.vue'
import { showGlobalError } from '../services/global-message'

const router = useRouter()
const query = ref('')
const bookResults = ref<DesktopBookSearchResult[]>([])
const results = ref<DesktopSearchResult[]>([])
const searching = ref(false)
const searched = ref(false)

function resultChapterLabel(result: DesktopSearchResult) {
  return formatChapterLabel({ number: result.chapterNumber, originalLabel: result.originalLabel })
}

function clearSearch() {
  query.value = ''
  bookResults.value = []
  results.value = []
  searched.value = false
}

async function search() {
  if (!query.value.trim()) return
  searching.value = true
  searched.value = true
  try {
    const response = await searchDesktopLibrary(query.value)
    bookResults.value = response.books
    results.value = response.chapters
  } catch (cause) {
    bookResults.value = []
    results.value = []
    searched.value = false
    showGlobalError(cause, '搜索失败，请稍后重试')
  } finally {
    searching.value = false
  }
}
</script>

<template>
  <section class="workspace-view search-view">
    <PageHeader title="全文搜索" />
    <div class="search-stage">
      <form class="search-control" role="search" @submit.prevent="search"><Search :size="19" /><input v-model="query" aria-label="搜索书库" placeholder="搜索书名、作者、章名或正文" /><button v-if="query" type="button" class="clear-search" title="清空" @click="clearSearch"><X :size="16" /></button><button type="submit" class="primary-command" :disabled="searching || !query.trim()">{{ searching ? '搜索中' : '搜索' }}</button></form>
      <div v-if="searched && !bookResults.length && !results.length && !searching" class="search-empty" role="status">没有找到匹配内容</div>
      <div v-if="bookResults.length || results.length" class="search-output" aria-live="polite">
        <section v-if="bookResults.length" class="search-result-section">
          <header class="search-result-heading"><strong>命中的小说</strong><span>{{ bookResults.length }} 本</span></header>
          <div class="search-book-results">
            <button v-for="book in bookResults" :key="book.bookId" type="button" @click="router.push(`/book/${book.bookId}`)">
              <span class="search-book-cover"><img v-if="book.coverDataUrl" :src="book.coverDataUrl" :alt="`${book.title}封面`" /><BookOpen v-else :size="20" /></span>
              <div><strong>{{ book.title }}</strong><small>{{ book.author || '未知作者' }} · {{ book.chapterCount }} 章</small><p v-if="book.description">{{ book.description }}</p></div>
              <ArrowRight :size="17" />
            </button>
          </div>
        </section>
        <section v-if="results.length" class="search-result-section">
          <header class="search-result-heading"><strong>章节与正文</strong><span>{{ results.length }} 条</span></header>
          <div class="search-results"><button v-for="result in results" :key="`${result.bookId}:${result.chapterNumber}`" type="button" @click="router.push(`/read/${result.bookId}/${result.chapterNumber}`)"><div><small>{{ result.bookTitle }} · {{ result.kind === 'chapter' ? resultChapterLabel(result) : result.kind === 'volume' ? '分卷' : result.kind === 'frontmatter' ? '前置内容' : '附加内容' }}</small><strong>{{ result.chapterTitle }}</strong><p>{{ result.snippet }}</p></div><ArrowRight :size="17" /></button></div>
        </section>
      </div>
    </div>
  </section>
</template>
