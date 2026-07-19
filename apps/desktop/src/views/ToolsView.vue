<script setup lang="ts">
import { ArrowRight, Code2, NotebookPen } from 'lucide-vue-next'
import { useRouter } from 'vue-router'
import PageHeader from '../components/ui/PageHeader.vue'

const router = useRouter()
</script>

<template>
  <section class="workspace-view tools-library-view">
    <PageHeader title="工具库" />

    <div class="tools-library-grid">
      <button type="button" class="tool-library-item" @click="router.push('/tools/notes')">
        <span class="tool-library-icon"><NotebookPen :size="25" /></span>
        <span class="tool-library-copy"><strong>本地笔记</strong></span>
        <ArrowRight :size="18" />
      </button>
      <button type="button" class="tool-library-item" @click="router.push('/tools/ide-integration')">
        <span class="tool-library-icon"><Code2 :size="25" /></span>
        <span class="tool-library-copy"><strong>IDE 插件</strong></span>
        <ArrowRight :size="18" />
      </button>
    </div>

  </section>
</template>
