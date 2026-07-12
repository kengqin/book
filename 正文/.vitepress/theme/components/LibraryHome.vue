<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ArrowRight, BookOpen, HardDrive, LibraryBig, Shuffle } from 'lucide-vue-next'
import { withBase } from 'vitepress'
import library from '../../library.generated.json'
const coverModules = import.meta.glob('../../../../书库/*/站点/*.{avif,gif,jpeg,jpg,png,webp}', { eager: true, import: 'default' }) as Record<string, string>
const activeFilter = ref('all')
const filters = computed(() => [{ id: 'all', label: '全部' }, ...[...new Set(library.books.map(book => book.status))].map(status => ({ id: status, label: status }))])
const filteredBooks = computed(() => activeFilter.value === 'all' ? library.books : library.books.filter(book => book.status === activeFilter.value))

function imageFor(book: typeof library.books[number]) {
  if (!book.cover) return ''
  const suffix = `/书库/${book.slug}/站点/${book.cover}`
  return Object.entries(coverModules).find(([file]) => file.endsWith(suffix))?.[1] ?? ''
}

function moveCard(event: PointerEvent) {
  const card = event.currentTarget as HTMLElement
  const rect = card.getBoundingClientRect()
  const x = (event.clientX - rect.left) / rect.width
  const y = (event.clientY - rect.top) / rect.height
  card.style.setProperty('--card-rx', `${(0.5 - y) * 4}deg`)
  card.style.setProperty('--card-ry', `${(x - 0.5) * 5}deg`)
  card.style.setProperty('--pointer-x', `${x * 100}%`)
  card.style.setProperty('--pointer-y', `${y * 100}%`)
}

function resetCard(event: PointerEvent) {
  const card = event.currentTarget as HTMLElement
  card.style.setProperty('--card-rx', '0deg')
  card.style.setProperty('--card-ry', '0deg')
  card.style.setProperty('--pointer-x', '50%')
  card.style.setProperty('--pointer-y', '50%')
}

function openRandomBook() {
  const pool = filteredBooks.value.length ? filteredBooks.value : library.books
  if (!pool.length) return
  const book = pool[Math.floor(Math.random() * pool.length)]
  window.location.href = withBase(book.topicLink)
}

onMounted(() => document.body.classList.add('is-eternal-home'))
onBeforeUnmount(() => document.body.classList.remove('is-eternal-home'))
</script>

<template>
  <header class="library-nav">
    <a class="library-brand" :href="withBase('/')"><LibraryBig :size="22" /><strong>小说书库</strong></a>
    <div class="library-nav__actions">
      <span>{{ library.books.length }} BOOKS</span>
      <a :href="withBase('/本地书架/')"><HardDrive :size="15" /> 本地书架</a>
    </div>
  </header>

  <main class="library-home">
    <div class="library-heading">
      <p>STORIES · WORLDS · JOURNEYS</p>
      <h1><span>小说</span><strong>书库</strong></h1>
      <span>择一卷，入江湖。为每一个故事，留一扇通往远方的门。</span>
      <button class="library-hero-cta" type="button" :disabled="!library.books.length" @click="openRandomBook"><Shuffle :size="17" /> 随机进入一本书 <ArrowRight :size="17" /></button>
    </div>

    <div class="library-toolbar">
      <span class="library-toolbar__label">SELECT A STORY</span>
      <div class="library-toolbar__controls">
        <div class="library-filters" role="group" aria-label="按状态筛选小说">
          <button v-for="filter in filters" :key="filter.id" type="button" :class="{ active: activeFilter === filter.id }" @click="activeFilter = filter.id">{{ filter.label }}</button>
        </div>
        <span>{{ filteredBooks.length }} / {{ library.books.length }}</span>
      </div>
    </div>

    <TransitionGroup tag="section" name="book-grid" class="book-gallery" aria-label="小说列表">
      <a v-for="(book, index) in filteredBooks" :key="book.id" class="book-tile" :href="withBase(book.topicLink)" :style="{ '--tile-index': index }" @pointermove="moveCard" @pointerleave="resetCard">
        <div class="book-tile__media" :style="{ backgroundImage: imageFor(book) ? `url(${imageFor(book)})` : undefined }">
          <div class="book-tile__shade" />
          <div class="book-tile__glow" />
          <span class="book-tile__index">{{ String(index + 1).padStart(2, '0') }}</span>
          <div class="book-tile__meta"><span>{{ book.status }}</span><small>{{ book.chapterCount }} 章</small></div>
        </div>
        <div class="book-tile__content">
          <div class="book-tile__heading"><div><h2>{{ book.title }}</h2><p>{{ book.author }}</p></div><ArrowRight :size="19" /></div>
          <blockquote>{{ book.description }}</blockquote>
          <span class="book-tile__enter"><BookOpen :size="17" /> 进入专题 <ArrowRight :size="17" /></span>
        </div>
      </a>
    </TransitionGroup>
  </main>
</template>
