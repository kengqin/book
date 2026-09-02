const IMPORT_DIALOG_OPTIONS = {
  title: '导入 TXT 或 EPUB 小说',
  canSelectFiles: true,
  canSelectFolders: false,
  canSelectMany: false,
  openLabel: '导入小说',
  filters: { '小说文件': ['txt', 'text', 'epub'] }
}

async function selectImportFile(window, uri) {
  if (uri?.fsPath) return uri
  const selected = await window.showOpenDialog(IMPORT_DIALOG_OPTIONS)
  return selected?.[0]
}

module.exports = { IMPORT_DIALOG_OPTIONS, selectImportFile }
