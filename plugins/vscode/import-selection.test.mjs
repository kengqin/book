import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { IMPORT_DIALOG_OPTIONS, selectImportFile } = require('./import-selection.js')

test('command palette import opens a TXT/EPUB file picker', async () => {
  const selectedFile = { fsPath: 'C:\\books\\sample.epub' }
  let receivedOptions
  const result = await selectImportFile({
    async showOpenDialog(options) {
      receivedOptions = options
      return [selectedFile]
    }
  })

  assert.equal(result, selectedFile)
  assert.equal(receivedOptions, IMPORT_DIALOG_OPTIONS)
  assert.equal(receivedOptions.canSelectFiles, true)
  assert.equal(receivedOptions.canSelectFolders, false)
  assert.deepEqual(receivedOptions.filters['小说文件'], ['txt', 'text', 'epub'])
})

test('editor context import keeps the explicitly selected file', async () => {
  const contextFile = { fsPath: 'C:\\books\\context.txt' }
  let opened = false
  const result = await selectImportFile({
    async showOpenDialog() {
      opened = true
      return []
    }
  }, contextFile)

  assert.equal(result, contextFile)
  assert.equal(opened, false)
})

test('cancelling the picker cancels the import', async () => {
  const result = await selectImportFile({ async showOpenDialog() { return undefined } })
  assert.equal(result, undefined)
})
