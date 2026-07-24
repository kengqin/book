import { readonly, ref } from 'vue'

export type GlobalMessageType = 'success' | 'info' | 'warning' | 'error'

interface GlobalMessageState {
  id: number
  text: string
  type: GlobalMessageType
}

const message = ref<GlobalMessageState>()
let nextId = 0
let dismissTimer: number | undefined

export const globalMessage = readonly(message)

export function dismissGlobalMessage(id?: number) {
  if (id !== undefined && message.value?.id !== id) return
  if (dismissTimer !== undefined) window.clearTimeout(dismissTimer)
  dismissTimer = undefined
  message.value = undefined
}

export function showGlobalMessage(text: string, type: GlobalMessageType = 'success', duration = 3600) {
  const normalized = text.trim()
  if (!normalized) return
  dismissGlobalMessage()
  const id = ++nextId
  message.value = { id, text: normalized, type }
  if (duration > 0) {
    dismissTimer = window.setTimeout(() => dismissGlobalMessage(id), duration)
  }
}
