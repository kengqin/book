/// <reference lib="webworker" />
import type { ParserResponse } from '@novel-library/reader-core'
import { parseEpubBuffer } from '../../../desktop/src/services/parse-epub'

const scope = self as DedicatedWorkerGlobalScope
const send = (message: ParserResponse) => scope.postMessage(message)

scope.onmessage = (event: MessageEvent<{ buffer: ArrayBuffer; filename: string }>) => {
  try {
    send({ type: 'complete', result: parseEpubBuffer(event.data.buffer, event.data.filename, send) })
  } catch (cause) {
    send({ type: 'error', message: cause instanceof Error ? cause.message : 'EPUB 解析失败' })
  }
}
