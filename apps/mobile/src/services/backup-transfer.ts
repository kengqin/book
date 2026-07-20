import { Capacitor } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'

function safeFilename(value: string) {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').slice(0, 80) || '小说书库'
}

function downloadJson(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export async function exportAndShareJson(payload: unknown, filename: string, title: string) {
  const normalizedName = `${safeFilename(filename)}.json`
  const content = JSON.stringify(payload)
  if (!Capacitor.isNativePlatform()) {
    downloadJson(normalizedName, content)
    return
  }
  const result = await Filesystem.writeFile({ path: normalizedName, data: content, directory: Directory.Cache, encoding: Encoding.UTF8 })
  await Share.share({ title, text: title, url: result.uri, dialogTitle: title })
}

export async function readBackupFile(file: File) {
  if (file.size > 512 * 1024 * 1024) throw new Error('备份文件超过 512 MB，已阻止导入')
  try {
    return JSON.parse(await file.text()) as unknown
  } catch {
    throw new Error('备份文件不是有效的 JSON')
  }
}
