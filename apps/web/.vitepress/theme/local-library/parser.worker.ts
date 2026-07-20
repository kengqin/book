/// <reference lib="webworker" />
import { parseNovel } from '@novel-library/novel-parser'
import type { ParserRequest, ParserResponse } from './types'

const scope = self as DedicatedWorkerGlobalScope

function send(message: ParserResponse) { scope.postMessage(message) }

scope.onmessage = (event: MessageEvent<ParserRequest>) => {
  try {
    const result = parseNovel(event.data, send)
    send({ type: 'complete', result })
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : '解析失败' })
  }
}
