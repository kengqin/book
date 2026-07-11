<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { ArrowLeft, ArrowRight, BookOpen, ChevronDown, LibraryBig, ScrollText } from 'lucide-vue-next'
import { withBase } from 'vitepress'
import library from '../../library.generated.json'
import jianlaiHero from '../../../../书库/剑来/站点/jianlai-hero.jpg'
import eternalHero from '../../../../书库/永恒道途/站点/eternal-path-hero.jpg'

const props = defineProps<{ bookId: string }>()
const book = computed(() => library.books.find(item => item.id === props.bookId) ?? library.books[0])
const image = computed(() => book.value.id === 'jianlai' ? jianlaiHero : eternalHero)
const seal = computed(() => book.value.id === 'jianlai' ? '剑' : '道')
const groups = computed(() => {
  const grouped = new Map<string, typeof book.value.chapters>()
  for (const chapter of book.value.chapters) {
    const items = grouped.get(chapter.group) ?? []
    items.push(chapter)
    grouped.set(chapter.group, items)
  }
  return [...grouped.entries()].map(([group, chapters]) => ({ group, first: chapters[0], last: chapters.at(-1)!, count: chapters.length }))
})

onMounted(() => document.body.classList.add('is-eternal-home'))
onBeforeUnmount(() => document.body.classList.remove('is-eternal-home'))
</script>

<template>
  <header class="eternal-nav">
    <a class="eternal-brand" :href="withBase(book.topicLink)">
      <span class="eternal-brand__seal">{{ seal }}</span>
      <span><strong>{{ book.title }}</strong><small>{{ book.author }}</small></span>
    </a>
    <nav class="eternal-nav__links" aria-label="小说导航">
      <a :href="withBase('/')">书库</a>
      <a class="active" :href="withBase(book.topicLink)">专题</a>
      <a :href="withBase(book.catalogueLink)">完整目录</a>
    </nav>
    <div class="eternal-nav__actions">
      <a class="book-back" :href="withBase('/')" aria-label="返回书库" title="返回书库"><LibraryBig :size="18" /></a>
      <a class="eternal-nav__read" :href="withBase(book.firstLink)">开始阅读 <ArrowRight :size="15" /></a>
    </div>
  </header>

  <main class="eternal-home book-home">
    <section class="eternal-hero" :style="{ backgroundImage: `url(${image})` }">
      <div class="eternal-hero__veil" aria-hidden="true" />
      <div class="eternal-hero__mist eternal-hero__mist--one" aria-hidden="true" />
      <div class="eternal-hero__content">
        <a class="book-breadcrumb" :href="withBase('/')"><ArrowLeft :size="14" /> 小说书库</a>
        <p class="eternal-kicker">{{ book.status }} · {{ book.author }}</p>
        <h1><strong>{{ book.title.slice(0, 1) }}</strong><span>{{ book.title.slice(1) }}</span></h1>
        <p class="eternal-lead">{{ book.description }}</p>
        <blockquote>{{ book.range }} · 共 {{ book.chapterCount }} 章</blockquote>
        <div class="eternal-actions">
          <a class="eternal-button eternal-button--primary" :href="withBase(book.firstLink)"><BookOpen :size="18" /> 开始阅读 <ArrowRight :size="17" /></a>
          <a class="eternal-button eternal-button--ghost" href="#catalogue"><ScrollText :size="18" /> 查看目录</a>
        </div>
      </div>
      <a class="eternal-scroll" href="#catalogue"><span>章节目录</span><ChevronDown :size="19" /></a>
    </section>

    <section id="catalogue" class="eternal-catalogue">
      <div class="eternal-catalogue__intro">
        <div><p class="section-mark">TABLE OF CONTENTS</p><h2>{{ book.title }} · 目录</h2><p>章节按篇幅分段收纳，点击任一分段即可开始连续阅读。</p></div>
        <div class="volume-seal"><span>{{ book.status }}</span><strong>{{ book.chapterCount }}</strong><small>章</small></div>
      </div>
      <div class="chapter-list range-list">
        <a v-for="group in groups" :key="group.group" :href="withBase(group.first.link)" class="chapter-entry">
          <span class="chapter-entry__index">{{ String(group.first.number).padStart(4, '0') }}</span>
          <span><small>{{ group.count }} CHAPTERS</small>第 {{ group.first.number }}—{{ group.last.number }} 章</span>
          <ArrowRight :size="17" />
        </a>
      </div>
      <a class="catalogue-all" :href="withBase(book.catalogueLink)"><ScrollText :size="18" /> 查看完整章节目录 <ArrowRight :size="17" /></a>
    </section>
  </main>
</template>
