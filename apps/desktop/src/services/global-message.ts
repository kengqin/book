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

export function userFacingError(cause: unknown, fallback = '操作未完成，请稍后重试') {
  const raw = (cause instanceof Error ? cause.message : String(cause)).trim()
  const firstLine = raw.split(/\r?\n/u, 1)[0].replace(/^Error:\s*/iu, '').trim()
  return /[\u3400-\u9fff]/u.test(firstLine) && firstLine.length <= 160 ? firstLine : fallback
}

export function showGlobalError(cause: unknown, fallback = '操作未完成，请稍后重试', duration = 6000) {
  showGlobalMessage(userFacingError(cause, fallback), 'error', duration)
}
