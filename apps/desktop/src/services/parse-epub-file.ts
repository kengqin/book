import type { ParseResult, ParserResponse } from '@novel-library/reader-core'

export function parseEpubFile(file: File, onProgress: (progress: number, message: string) => void) {
  return new Promise<ParseResult>(async (resolve, reject) => {
    const worker = new Worker(new URL('../workers/epub-parser.worker.ts', import.meta.url), { type: 'module' })
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
      reject(new Error(event.message || 'EPUB 解析线程异常'))
    }

    try {
      const buffer = await file.arrayBuffer()
      worker.postMessage({ buffer, filename: file.name }, [buffer])
    } catch (cause) {
      worker.terminate()
      reject(cause)
    }
  })
}
