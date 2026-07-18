import { createApp } from 'vue'
import { invoke, isTauri } from '@tauri-apps/api/core'
import App from './App.vue'
import { router } from './router'
import './styles.css'

const app = createApp(App).use(router)
app.mount('#app')

const startupStartedAt = performance.now()

function dismissStartupSplash() {
  const splash = document.getElementById('startup-splash')
  if (!splash) return
  splash.classList.add('startup-splash--leaving')
  window.setTimeout(() => splash.remove(), 420)
}

async function waitForStartup() {
  if (!isTauri()) return
  try {
    await invoke('wait_for_startup')
  } catch (error) {
    console.error('application-startup-error', error)
  }
}

void Promise.all([router.isReady(), waitForStartup()]).then(() => {
  const minimumVisibleTime = 900
  const remaining = Math.max(0, minimumVisibleTime - (performance.now() - startupStartedAt))
  window.setTimeout(dismissStartupSplash, remaining)
})
