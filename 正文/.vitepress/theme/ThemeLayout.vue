<script setup lang="ts">
import DefaultTheme from 'vitepress/theme'
import ReadingTools from './components/ReadingTools.vue'

const { Layout } = DefaultTheme
</script>

<template>
  <Layout>
    <template #layout-bottom>
      <ReadingTools />
    </template>
  </Layout>
</template>
