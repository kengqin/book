<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { ArrowRight, BookOpen, LibraryBig } from 'lucide-vue-next'
import { withBase } from 'vitepress'
import library from '../../library.generated.json'
import jianlaiHero from '../../../../书库/剑来/站点/jianlai-hero.jpg'
import eternalHero from '../../../../书库/永恒道途/站点/eternal-path-hero.jpg'

const images: Record<string, string> = {
  jianlai: jianlaiHero,
  'eternal-path': eternalHero
}

onMounted(() => document.body.classList.add('is-eternal-home'))
onBeforeUnmount(() => document.body.classList.remove('is-eternal-home'))
</script>

<template>
  <header class="library-nav">
    <a class="library-brand" :href="withBase('/')"><LibraryBig :size="22" /><strong>小说书库</strong></a>
    <span>一书一世界</span>
  </header>

  <main class="library-home">
    <div class="library-heading">
      <p>PERSONAL LIBRARY</p>
      <h1>小说书库</h1>
      <span>选一本书，进入它的世界。</span>
    </div>

    <section class="book-gallery" aria-label="小说列表">
      <a v-for="book in library.books" :key="book.id" class="book-tile" :href="withBase(book.topicLink)" :style="{ backgroundImage: `url(${images[book.id]})` }">
        <div class="book-tile__shade" />
        <div class="book-tile__content">
          <div class="book-tile__meta"><span>{{ book.status }}</span><small>{{ book.chapterCount }} 章</small></div>
          <h2>{{ book.title }}</h2>
          <p>{{ book.author }}</p>
          <blockquote>{{ book.description }}</blockquote>
          <span class="book-tile__enter"><BookOpen :size="17" /> 进入专题 <ArrowRight :size="17" /></span>
        </div>
      </a>
    </section>
  </main>
</template>
