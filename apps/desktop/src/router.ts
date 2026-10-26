import { createRouter, createWebHashHistory } from 'vue-router'
import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { openSettingsWindow } from './services/settings-window'
import { showGlobalError } from './services/global-message'

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/application-update', component: () => import('./views/UpdateWindowView.vue') },
    { path: '/overlay/:kind', component: () => import('./views/FloatingLayerView.vue') },
    { path: '/browser/menu', component: () => import('./views/BrowserMenuView.vue'), meta: { layout: 'browser' } },
    { path: '/browser', component: () => import('./views/BrowserView.vue'), meta: { layout: 'browser' } },
    { path: '/', redirect: '/library' },
    { path: '/library', component: () => import('./views/LibraryView.vue') },
    { path: '/book/:bookId', component: () => import('./views/BookView.vue') },
    { path: '/read/:bookId/:chapterNumber', component: () => import('./views/ReaderView.vue'), meta: { layout: 'reader' } },
    { path: '/search', component: () => import('./views/SearchView.vue') },
    { path: '/online', component: () => import('./views/OnlineView.vue') },
    { path: '/notes', component: () => import('./views/NotesView.vue') },
    { path: '/ide-integration', component: () => import('./views/IdeIntegrationView.vue') },
    { path: '/tools', redirect: '/library' },
    { path: '/tools/notes', redirect: '/notes' },
    { path: '/tools/ide-integration', redirect: '/ide-integration' },
    { path: '/updates', redirect: '/settings/updates' },
    { path: '/settings/window', component: () => import('./views/SettingsWindowView.vue') },
    { path: '/settings/history', component: () => import('./views/ReleaseHistoryView.vue') },
    { path: '/settings/updates', component: () => import('./views/UpdatesView.vue') },
    { path: '/settings', component: () => import('./views/SettingsView.vue') }
  ]
})

router.beforeEach(async to => {
  if (isTauri() && getCurrentWindow().label === 'main' && to.path.startsWith('/settings')) {
    try { await openSettingsWindow(to.path.includes('updates') ? 'updates' : 'general') } catch (cause) { showGlobalError(cause, '设置打开失败') }
    return false
  }
})
