<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import { App as NativeApp } from '@capacitor/app'
import type { PluginListenerHandle } from '@capacitor/core'
import { BookOpen, Search, Settings } from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()
const reader = computed(() => route.meta.reader === true)
let backListener: PluginListenerHandle | undefined

onMounted(async () => {
  backListener = await NativeApp.addListener('backButton', ({ canGoBack }) => {
    // Detail and reader pages are entered from the shelf. Replacing their
    // route prevents the native back button from bouncing between /read and
    // /book after the reader toolbar has been used.
    if (route.path.startsWith('/read/') || route.path.startsWith('/book/')) {
      void router.replace('/library')
      return
    }
    if (canGoBack || window.history.length > 1) router.back()
    else void NativeApp.exitApp()
  })
})

onBeforeUnmount(() => void backListener?.remove())
</script>

<template>
  <div class="mobile-shell" :class="{ 'mobile-shell--reader': reader }">
    <RouterView />
    <nav v-if="!reader" class="tabbar" aria-label="主导航">
      <RouterLink to="/library" :class="{ active: route.path.startsWith('/library') || route.path.startsWith('/book/') }"><BookOpen :size="20" /><span>书架</span></RouterLink>
      <RouterLink to="/search" :class="{ active: route.path.startsWith('/search') }"><Search :size="20" /><span>搜索</span></RouterLink>
      <RouterLink to="/settings" :class="{ active: route.path.startsWith('/settings') }"><Settings :size="20" /><span>设置</span></RouterLink>
    </nav>
  </div>
</template>
