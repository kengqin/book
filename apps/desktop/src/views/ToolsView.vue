<script setup lang="ts">
import { ArrowRight, NotebookPen, Wrench } from 'lucide-vue-next'
import { useRouter } from 'vue-router'

const router = useRouter()
</script>

<template>
  <section class="workspace-view tools-library-view">
    <header class="workspace-header">
      <div><p>LOCAL TOOLBOX</p><h1>工具库</h1></div>
    </header>

    <div class="tools-library-grid">
      <button type="button" class="tool-library-item" @click="router.push('/tools/notes')">
        <span class="tool-library-icon"><NotebookPen :size="25" /></span>
        <span class="tool-library-copy"><strong>本地笔记</strong><small>富文本记录与本地存储</small></span>
        <ArrowRight :size="18" />
      </button>
    </div>

    <div class="tool-library-footer"><Wrench :size="15" /><span>1 个可用工具</span></div>
  </section>
</template>
