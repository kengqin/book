<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { Minimize2, Power, X } from 'lucide-vue-next'
import { cancelCloseBehaviorPrompt, resolveCloseBehavior, type CloseBehavior } from '../services/desktop-library'

const visible = ref(false)
const remember = ref(false)
const busy = ref(false)
const error = ref('')
const dialog = ref<HTMLElement>()
let unlisten: UnlistenFn | undefined

async function choose(behavior: Exclude<CloseBehavior, 'ask'>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await resolveCloseBehavior(behavior, remember.value)
    visible.value = false
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}

async function cancel() {
  if (busy.value) return
  await cancelCloseBehaviorPrompt()
  visible.value = false
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') void cancel()
}

onMounted(async () => {
  unlisten = await listen('close-behavior-requested', async () => {
    remember.value = false
    error.value = ''
    visible.value = true
    await nextTick()
    dialog.value?.focus()
  })
  window.addEventListener('keydown', handleKeydown)
})

onBeforeUnmount(() => {
  unlisten?.()
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="close-dialog-backdrop" role="presentation">
      <section ref="dialog" class="close-dialog" role="dialog" aria-modal="true" aria-labelledby="close-dialog-title" tabindex="-1">
        <header>
          <div><span>关闭小说书库</span><h2 id="close-dialog-title">关闭窗口后要做什么？</h2></div>
          <button type="button" class="icon-button" title="取消关闭" :disabled="busy" @click="cancel"><X :size="17" /></button>
        </header>
        <p>缩小到托盘后，IDE 插件仍可同步书库和阅读进度；直接退出会停止桌面 Bridge。</p>
        <label class="remember-close-choice"><input v-model="remember" type="checkbox" /><span>记住我的选择，下次不再询问</span></label>
        <p v-if="error" class="inline-error">{{ error }}</p>
        <footer>
          <button type="button" class="secondary-command danger-command" :disabled="busy" @click="choose('quit')"><Power :size="16" />直接退出</button>
          <button type="button" class="primary-command" :disabled="busy" @click="choose('minimizeToTray')"><Minimize2 :size="16" />缩小到托盘</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
