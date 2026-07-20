import type { ParseOptions, ParseResult, ParserResponse } from '@novel-library/reader-core'

function parseInWorker(file: File, worker: Worker, payload: (buffer: ArrayBuffer) => unknown, onProgress: (progress: number, message: string) => void) {
  return new Promise<ParseResult>(async (resolve, reject) => {
    worker.onmessage = (event: MessageEvent<ParserResponse>) => {
      if (event.data.type === 'progress') {
        onProgress(event.data.progress, event.data.message)
        return
      }
      worker.terminate()
      if (event.data.type === 'complete') resolve(event.data.result)
      else reject(new Error(event.data.message))
    }
    worker.onerror = event => {
      worker.terminate()
      reject(new Error(event.message || '解析线程异常'))
    }
    try {
      const buffer = await file.arrayBuffer()
      worker.postMessage(payload(buffer), [buffer])
    } catch (cause) {
      worker.terminate()
      reject(cause)
    }
  })
}

export function parseMobileBook(file: File, options: ParseOptions, onProgress: (progress: number, message: string) => void) {
  const isEpub = file.name.toLocaleLowerCase().endsWith('.epub')
  const worker = isEpub
    ? new Worker(new URL('../workers/epub-parser.worker.ts', import.meta.url), { type: 'module' })
    : new Worker(new URL('../workers/parser.worker.ts', import.meta.url), { type: 'module' })
  return parseInWorker(file, worker, buffer => isEpub
    ? { buffer, filename: file.name }
    : { buffer, filename: file.name, options }, onProgress)
}
