import DefaultTheme from 'vitepress/theme'
import ThemeLayout from './ThemeLayout.vue'
import LibraryHome from './components/LibraryHome.vue'
import BookHome from './components/BookHome.vue'
import BookCatalogue from './components/BookCatalogue.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  Layout: ThemeLayout,
  enhanceApp({ app }) {
    app.component('LibraryHome', LibraryHome)
    app.component('BookHome', BookHome)
    app.component('BookCatalogue', BookCatalogue)
  }
}
