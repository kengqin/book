<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { ArrowRight, BookOpen, ChevronDown, Github, Search, ScrollText, Sparkles } from 'lucide-vue-next'
import { withBase } from 'vitepress'

const chapters = [
  ['第一章', '根浅而韧'], ['第二章', '瓶中一滴春'], ['第三章', '山门三百四十里'],
  ['第四章', '一柄旧药锄'], ['第五章', '四气入丹田'], ['第六章', '十九株青背草'],
  ['第七章', '账外之交'], ['第八章', '三次半拍'], ['第九章', '第一寸剑痕'],
  ['第十章', '第一重练成'], ['第十一章', '六十剑'], ['第十二章', '黑风山朱榜'],
  ['第十三章', '月光只剩一线'], ['第十四章', '山门警钟'], ['第十五章', '先赢眼前一剑'],
  ['第十六章', '白线以内'], ['第十七章', '青莲未收'], ['第十八章', '第三名与旧伤'],
  ['第十九章', '看剑，不看根'], ['第二十章', '一壶冷药'], ['第二十一章', '十战九败']
]

const particles = Array.from({ length: 18 }, (_, index) => ({
  left: `${(index * 37 + 11) % 96}%`,
  top: `${(index * 53 + 17) % 82}%`,
  delay: `${(index % 7) * -1.3}s`,
  duration: `${7 + (index % 5) * 1.4}s`
}))

const chapterLink = (chapter: string, title: string) =>
  withBase(`/第一卷-山门有路/${chapter}-${title}`)

const openSearch = () => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
}

onMounted(() => document.body.classList.add('is-eternal-home'))
onBeforeUnmount(() => document.body.classList.remove('is-eternal-home'))
</script>

<template>
  <header class="eternal-nav">
    <a class="eternal-brand" :href="withBase('/')" aria-label="永恒道途首页">
      <span class="eternal-brand__seal">道</span>
      <span><strong>永恒道途</strong><small>THE ETERNAL PATH</small></span>
    </a>

    <nav class="eternal-nav__links" aria-label="主导航">
      <a class="active" :href="withBase('/')">首页</a>
      <a href="#catalogue">卷章目录</a>
      <a :href="chapterLink('第一章', '根浅而韧')">开始阅读</a>
    </nav>

    <div class="eternal-nav__actions">
      <button type="button" aria-label="搜索全书" title="搜索全书" @click="openSearch"><Search :size="18" /></button>
      <a href="https://github.com/kengqin/book" target="_blank" rel="noreferrer" aria-label="GitHub" title="GitHub"><Github :size="18" /></a>
      <a class="eternal-nav__read" :href="chapterLink('第一章', '根浅而韧')">读第一章 <ArrowRight :size="15" /></a>
    </div>
  </header>

  <main class="eternal-home">
    <section class="eternal-hero" :style="{ backgroundImage: `url(${withBase('/images/eternal-path-hero.jpg')})` }">
      <div class="eternal-hero__veil" aria-hidden="true" />
      <div class="eternal-hero__mist eternal-hero__mist--one" aria-hidden="true" />
      <div class="eternal-hero__mist eternal-hero__mist--two" aria-hidden="true" />
      <div class="spirit-field" aria-hidden="true">
        <i v-for="(particle, index) in particles" :key="index" :style="{ '--left': particle.left, '--top': particle.top, '--delay': particle.delay, '--duration': particle.duration }" />
      </div>

      <div class="eternal-hero__content">
        <p class="eternal-kicker"><Sparkles :size="15" /> 凡人流长篇修仙小说</p>
        <h1><span>永恒</span><strong>道途</strong></h1>
        <p class="eternal-lead">一介寒门少年，一只来历莫测的掌天瓶。<br>仙途万险，唯有一步一步，走出自己的大道。</p>
        <blockquote>大道三千，我只取一瓢饮。</blockquote>
        <div class="eternal-actions">
          <a class="eternal-button eternal-button--primary" :href="chapterLink('第一章', '根浅而韧')"><BookOpen :size="18" /> 开始阅读 <ArrowRight :size="17" /></a>
          <a class="eternal-button eternal-button--ghost" href="#catalogue"><ScrollText :size="18" /> 浏览目录</a>
        </div>
      </div>

      <a class="eternal-scroll" href="#catalogue" aria-label="向下浏览目录"><span>卷一 · 山门有路</span><ChevronDown :size="19" /></a>
    </section>

    <section id="catalogue" class="eternal-catalogue">
      <div class="eternal-catalogue__intro">
        <div>
          <p class="section-mark">VOLUME 01</p>
          <h2>山门有路</h2>
          <p>根浅未必无缘大道。寒门少年陈玄携一只来历莫测的小瓶，自青石村出发，一步步走向三百四十里外的青云山门。</p>
        </div>
        <div class="volume-seal" aria-label="第一卷，共二十一章"><span>卷一</span><strong>21</strong><small>章</small></div>
      </div>

      <div class="chapter-list">
        <a v-for="([chapter, title], index) in chapters" :key="chapter" :href="chapterLink(chapter, title)" class="chapter-entry">
          <span class="chapter-entry__index">{{ String(index + 1).padStart(2, '0') }}</span>
          <span><small>{{ chapter }}</small>{{ title }}</span>
          <ArrowRight :size="17" />
        </a>
      </div>
    </section>
  </main>
</template>
