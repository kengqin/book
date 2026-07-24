import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

function source(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

const appSource = source('apps/desktop/src/App.vue')
requireValue(appSource.includes('<GlobalMessage />'), 'Desktop app must mount the global Message component')

const feedbackSurfaces = [
  'apps/desktop/src/App.vue',
  'apps/desktop/src/components/CloseBehaviorDialog.vue',
  'apps/desktop/src/components/GlobalUpdateStatus.vue',
  'apps/desktop/src/views/BookView.vue',
  'apps/desktop/src/views/IdeIntegrationView.vue',
  'apps/desktop/src/views/LibraryView.vue',
  'apps/desktop/src/views/NotesView.vue',
  'apps/desktop/src/views/ReaderView.vue',
  'apps/desktop/src/views/SearchView.vue',
  'apps/desktop/src/views/SettingsView.vue',
  'apps/desktop/src/views/UpdatesView.vue'
]

for (const path of feedbackSurfaces) {
  requireValue(/showGlobal(?:Message|Error)/.test(source(path)), `${path} must route operation feedback through global Message`)
}

const retiredInlineFeedback = [
  'inline-error',
  'note-editor-alert',
  'note-editor-toast',
  'settings-message'
]

for (const path of [
  ...feedbackSurfaces,
  'apps/desktop/src/styles.css',
  'apps/desktop/src/styles/editorial.css'
]) {
  const contents = source(path)
  for (const className of retiredInlineFeedback) {
    requireValue(!contents.includes(className), `${path} must not restore retired inline feedback class .${className}`)
  }
}

for (const path of feedbackSurfaces) {
  requireValue(!/class="[^"]*(?:toast|notice|alert|message|inline-error)[^"]*"/.test(source(path)), `${path} must not render page-local operation feedback`)
  const messageCalls = source(path).split(/\r?\n/u).filter(line => line.includes('showGlobalMessage(')).join('\n')
  requireValue(!/(?:result\.message|result\.path|targetPath|dataDirectory|databasePath)/.test(messageCalls), `${path} must not expose raw command output or local paths in Message copy`)
  requireValue(!/showGlobalMessage\(cause instanceof Error/.test(source(path)), `${path} must route unknown errors through showGlobalError`)
}

console.log('Desktop operation feedback uses global Message')
