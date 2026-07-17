import { createRouter, createWebHashHistory } from 'vue-router'
import LibraryView from './views/LibraryView.vue'
import BookView from './views/BookView.vue'
import ReaderView from './views/ReaderView.vue'
import SearchView from './views/SearchView.vue'
import SettingsView from './views/SettingsView.vue'
import UpdatesView from './views/UpdatesView.vue'
import ToolsView from './views/ToolsView.vue'
import NotesView from './views/NotesView.vue'
import IdeIntegrationView from './views/IdeIntegrationView.vue'

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/library' },
    { path: '/library', component: LibraryView },
    { path: '/book/:bookId', component: BookView },
    { path: '/read/:bookId/:chapterNumber', component: ReaderView },
    { path: '/search', component: SearchView },
    { path: '/tools', component: ToolsView },
    { path: '/tools/notes', component: NotesView },
    { path: '/tools/ide-integration', component: IdeIntegrationView },
    { path: '/updates', redirect: '/settings/updates' },
    { path: '/settings/updates', component: UpdatesView },
    { path: '/settings', component: SettingsView }
  ]
})
