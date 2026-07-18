import { createRouter, createWebHashHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/library' },
    { path: '/library', component: () => import('./views/LibraryView.vue') },
    { path: '/book/:bookId', component: () => import('./views/BookView.vue') },
    { path: '/read/:bookId/:chapterNumber', component: () => import('./views/ReaderView.vue') },
    { path: '/search', component: () => import('./views/SearchView.vue') },
    { path: '/tools', component: () => import('./views/ToolsView.vue') },
    { path: '/tools/notes', component: () => import('./views/NotesView.vue') },
    { path: '/tools/ide-integration', component: () => import('./views/IdeIntegrationView.vue') },
    { path: '/updates', redirect: '/settings/updates' },
    { path: '/settings/updates', component: () => import('./views/UpdatesView.vue') },
    { path: '/settings', component: () => import('./views/SettingsView.vue') }
  ]
})
