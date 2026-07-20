import { createRouter, createWebHashHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/library' },
    { path: '/library', component: () => import('./views/LibraryView.vue') },
    { path: '/book/:bookId', component: () => import('./views/BookView.vue') },
    { path: '/read/:bookId/:chapterNumber', component: () => import('./views/ReaderView.vue'), meta: { reader: true } },
    { path: '/search', component: () => import('./views/SearchView.vue') },
    { path: '/settings', component: () => import('./views/SettingsView.vue') }
  ]
})
