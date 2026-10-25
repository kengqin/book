<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { RefreshCw, X } from 'lucide-vue-next'
import GlobalMessage from '../components/GlobalMessage.vue'
import { acceptFloatingMessage, type GlobalMessageState } from '../services/global-message'
interface Layer { kind: 'message' | 'tooltip' | 'progress'; input: { id: number; text: string; tone?: GlobalMessageState['type']; variant?: string; subtitle?: string; action?: string } }
const state = ref<Layer | null>(null), frame = ref<HTMLElement>()
let unlisten: UnlistenFn | undefined, observer: ResizeObserver | undefined
function cancelProgress() { if (state.value?.kind === 'progress') void invoke('hide_floating_layer', { kind: 'progress', id: state.value.input.id }) }
function measure() {
  if (!state.value || !frame.value) return
  const r = frame.value.getBoundingClientRect()
  void invoke('resize_floating_layer', { id: state.value.input.id, width: Math.ceil(r.width), height: Math.ceil(r.height) }).catch(console.warn)
}
async function accept(value: Layer | null) {
  state.value = value
  acceptFloatingMessage(value?.kind === 'message' ? { id: value.input.id, text: value.input.text, type: value.input.tone || 'info' } : undefined)
  await nextTick(); measure()
}
onMounted(async () => {
  unlisten = await listen<Layer | null>('floating-layer-state', event => { void accept(event.payload) }, { target: getCurrentWindow().label })
  await accept(await invoke<Layer | null>('get_floating_layer'))
  observer = new ResizeObserver(measure); if (frame.value) observer.observe(frame.value)
})
onBeforeUnmount(() => { unlisten?.(); observer?.disconnect() })
</script>
<template><div ref="frame" class="floating-layer-frame"><GlobalMessage v-if="state?.kind === 'message'" embedded /><div v-else-if="state?.kind === 'tooltip'" class="app-tooltip" :class="{ 'app-tooltip--title': state.input.variant === 'page-title' }" role="tooltip">{{ state.input.text }}</div><section v-else-if="state?.kind === 'progress'" class="floating-progress-card" role="dialog" aria-label="正在解析" aria-busy="true"><header><h2>正在解析</h2><button type="button" class="icon-button" aria-label="关闭解析弹框" @click="cancelProgress"><X :size="16" /></button></header><div class="floating-progress-site" role="status"><RefreshCw :size="21" class="spinning" /><div><strong>{{ state.input.text }}</strong><span>{{ state.input.subtitle }}</span></div></div><div class="floating-progress-track"><i /></div><footer><button v-if="state.input.action" type="button" class="secondary-command" @click="emitTo('main','floating-progress-verify',state.input.id)">{{ state.input.action }}</button><button type="button" class="secondary-command" @click="cancelProgress">取消</button></footer></section></div></template>
<style scoped>
.floating-layer-frame { display: inline-block; width: max-content; max-width: 100vw; padding: 12px; vertical-align: top; }
.app-tooltip { width: max-content; max-width: min(320px,calc(100vw - 24px)); padding: 7px 11px; border: 1px solid rgb(255 255 255 / 9%); border-radius: 8px; color: #fff; background: #29292b; box-shadow: 0 4px 14px rgb(0 0 0 / 17%); font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; animation: hint-in 110ms ease-out; }
.app-tooltip--title { padding: 9px 13px; border-color: var(--ui-border); color: var(--ui-text); background: var(--ui-surface); line-height: 1.6; }
.floating-progress-card { width: 420px; max-width: calc(100vw - 24px); padding: 20px; border: 1px solid var(--ui-border); border-radius: 12px; color: var(--ui-text); background: var(--ui-surface); box-shadow: 0 4px 12px rgb(0 0 0 / 10%); }
.floating-progress-card > header { display: flex; align-items: center; justify-content: space-between; }
.floating-progress-card h2 { margin: 0; font-size: 15px; font-weight: 600; }
.floating-progress-site { display: flex; align-items: center; gap: 14px; margin: 22px 0; }
.floating-progress-site > svg { color: var(--ui-accent); }
.floating-progress-site > div { display: grid; gap: 7px; }
.floating-progress-site strong { font-size: 13px; font-weight: 500; }
.floating-progress-site span { color: var(--ui-text-3); font-size: 12px; }
.floating-progress-track { height: 3px; overflow: hidden; border-radius: 3px; background: var(--ui-border); }
.floating-progress-track > i { display: block; width: 36%; height: 100%; border-radius: inherit; background: var(--ui-accent); animation: progress 1.3s ease-in-out infinite; }
.floating-progress-card footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
@keyframes progress { from { transform: translateX(-110%); } to { transform: translateX(390%); } }
@keyframes hint-in { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: translateY(0); } }
</style>
