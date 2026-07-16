/// <reference lib="webworker" />
import type { ParserResponse } from '@novel-library/reader-core'
import { parseEpubBuffer } from '../services/parse-epub'

const scope = self as DedicatedWorkerGlobalScope
const send = (message: ParserResponse) => scope.postMessage(message)

scope.onmessage = (event: MessageEvent<{ buffer: ArrayBuffer; filename: string }>) => {
  try {
    const result = parseEpubBuffer(event.data.buffer, event.data.filename, send)
    send({ type: 'complete', result })
  } catch (cause) {
    send({ type: 'error', message: cause instanceof Error ? cause.message : 'EPUB 解析失败' })
  }
}
