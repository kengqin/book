import DefaultTheme from 'vitepress/theme'
import ThemeLayout from './ThemeLayout.vue'
import EternalHome from './components/EternalHome.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  Layout: ThemeLayout,
  enhanceApp({ app }) {
    app.component('EternalHome', EternalHome)
  }
}
