<script setup lang="ts">
import { AlertTriangle, CheckCircle2, CircleAlert, Info, X } from 'lucide-vue-next'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { dismissGlobalMessage, globalMessage } from '../services/global-message'
const props = defineProps<{ embedded?: boolean }>()
const native = ref(false)
let unlisten: UnlistenFn | undefined
let nativeQueue = Promise.resolve()
const enqueue = (work: () => Promise<unknown>) => { nativeQueue = nativeQueue.then(work).then(() => {}, () => {}) }
watch(globalMessage, (value, previous) => {
  if (props.embedded || !isTauri()) return
  if (!value) { native.value = false; if (previous) enqueue(() => invoke('hide_floating_layer', { kind: 'message', id: previous.id })); return }
  native.value = true
  enqueue(async () => {
    if (globalMessage.value?.id !== value.id) return
    try { await invoke('show_floating_layer', { kind: 'message', input: { id: value.id, text: value.text, tone: value.type } }) }
    catch { if (globalMessage.value?.id === value.id) native.value = false }
  })
}, { flush: 'sync', immediate: true })
function close() { const id = globalMessage.value?.id; if (props.embedded && isTauri()) void invoke('hide_floating_layer', { kind: 'message', id }); else dismissGlobalMessage(id) }
onMounted(async () => { if (!props.embedded && isTauri()) unlisten = await listen<number>('floating-message-dismissed', event => dismissGlobalMessage(event.payload)) })
onBeforeUnmount(() => unlisten?.())
</script>

<template>
  <Teleport to="body" :disabled="embedded">
    <Transition name="global-message" :css="!embedded">
      <div
        v-if="globalMessage && !native"
        :key="globalMessage.id"
        class="global-message"
        :class="[`global-message--${globalMessage.type}`, { 'global-message--floating': embedded }]"
        :role="globalMessage.type === 'error' ? 'alert' : 'status'"
        aria-live="polite"
      >
        <span class="global-message__icon" aria-hidden="true">
          <CheckCircle2 v-if="globalMessage.type === 'success'" :size="17" />
          <AlertTriangle v-else-if="globalMessage.type === 'warning'" :size="17" />
          <CircleAlert v-else-if="globalMessage.type === 'error'" :size="17" />
          <Info v-else :size="17" />
        </span>
        <span class="global-message__content">{{ globalMessage.text }}</span>
        <button type="button" aria-label="关闭提示" @click="close">
          <X :size="16" />
        </button>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.global-message {
  --message-accent: var(--ui-accent, #315f5a);
  position: fixed;
  z-index: 24000;
  top: 52px;
  left: 50%;
  display: flex;
  align-items: center;
  gap: 10px;
  width: max-content;
  max-width: min(600px, calc(100vw - 32px));
  min-height: 48px;
  padding: 9px 10px 9px 11px;
  color: var(--ui-text, #202624);
  border: 1px solid color-mix(in srgb, var(--message-accent) 18%, var(--ui-border, #d8ddda));
  border-radius: 12px;
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--message-accent) 5%, var(--ui-surface, #fff)), var(--ui-surface, #fff) 58%);
  box-shadow: none;
  backdrop-filter: blur(18px) saturate(1.08);
  transform: translateX(-50%);
}

.global-message__icon {
  flex: 0 0 auto;
  display: grid;
  width: 20px;
  height: 20px;
  color: var(--message-accent);
  border: 0;
  background: transparent;
  place-items: center;
}

.global-message__content {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--ui-text, #202624);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  letter-spacing: .005em;
}

.global-message--success { --message-accent: var(--ui-success, #287868); }
.global-message--info { --message-accent: var(--ui-accent, #315f5a); }
.global-message--warning { --message-accent: var(--ui-warning, #9a651d); }
.global-message--error { --message-accent: var(--ui-danger, #b64a45); }

.global-message button {
  flex: 0 0 auto;
  display: grid;
  width: 28px;
  height: 28px;
  margin-left: 4px;
  padding: 0;
  place-items: center;
  color: var(--ui-muted, #6b7470);
  border: 0;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
}

.global-message button:hover {
  color: var(--ui-text, #202624);
  background: color-mix(in srgb, var(--ui-text, #202624) 7%, transparent);
}
.global-message--floating { position: relative; top: auto; left: auto; max-width: min(600px,calc(100vw - 24px)); transform: none; }

.global-message-enter-active { transition: opacity 180ms ease, transform 220ms cubic-bezier(.2, .8, .2, 1); }
.global-message-leave-active { transition: opacity 130ms ease, transform 150ms ease; }
.global-message-enter-from { opacity: 0; transform: translate(-50%, -12px) scale(.98); }
.global-message-leave-to { opacity: 0; transform: translate(-50%, -6px) scale(.99); }
</style>
