import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import './styles.css'

const app = createApp(App).use(router)
app.mount('#app')

function dismissStartupSplash() {
  const splash = document.getElementById('startup-splash')
  if (!splash) return
  splash.classList.add('startup-splash--leaving')
  window.setTimeout(() => splash.remove(), 420)
}

void router.isReady().then(dismissStartupSplash)
