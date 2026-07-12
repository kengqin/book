<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ArrowRight, BookOpen, HardDrive, LibraryBig, Shuffle } from 'lucide-vue-next'
import { withBase } from 'vitepress'
import library from '../../library.generated.json'
import jianlaiHero from '../../../../书库/剑来/站点/jianlai-hero.jpg'
import xuezhongHero from '../../../../书库/雪中悍刀行/站点/xuezhong-hero.png'
import eternalHero from '../../../../书库/永恒道途/站点/eternal-path-hero.jpg'

const images: Record<string, string> = {
  jianlai: jianlaiHero,
  xuezhong: xuezhongHero,
  'eternal-path': eternalHero
}

const filters = [
  { id: 'all', label: '全部' },
  { id: 'reading', label: '阅读中' },
  { id: 'complete', label: '已完结' },
  { id: 'original', label: '原创计划' }
]
const activeFilter = ref('all')
const filteredBooks = computed(() => library.books.filter(book => {
  if (activeFilter.value === 'reading') return book.status === '阅读中'
  if (activeFilter.value === 'complete') return book.status === '全本'
  if (activeFilter.value === 'original') return book.id === 'eternal-path'
  return true
}))

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
      <button class="library-hero-cta" type="button" @click="openRandomBook"><Shuffle :size="17" /> 随机进入一本书 <ArrowRight :size="17" /></button>
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
        <div class="book-tile__media" :style="{ backgroundImage: `url(${images[book.id]})` }">
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
