/// <reference lib="webworker" />
import { parseNovel } from '@novel-library/novel-parser'
import type { ParserRequest, ParserResponse } from '@novel-library/reader-core'

const scope = self as DedicatedWorkerGlobalScope
const send = (message: ParserResponse) => scope.postMessage(message)

scope.onmessage = (event: MessageEvent<ParserRequest>) => {
  try {
    const result = parseNovel(event.data, send)
    send({ type: 'complete', result })
  } catch (cause) {
    send({ type: 'error', message: cause instanceof Error ? cause.message : '解析失败' })
  }
}
