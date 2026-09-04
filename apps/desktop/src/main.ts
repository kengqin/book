import { createApp } from 'vue'
import { invoke, isTauri } from '@tauri-apps/api/core'
import App from './App.vue'
import { router } from './router'
import { syncApplicationWindowChrome } from './services/window-chrome'
import './styles.css'
import './styles/editorial.css'

window.addEventListener('contextmenu', event => event.preventDefault(), true)

const app = createApp(App).use(router)
app.mount('#app')

const startupStartedAt = performance.now()

function dismissStartupSplash() {
  const splash = document.getElementById('startup-splash')
  if (!splash) {
    delete document.documentElement.dataset.starting
    void syncApplicationWindowChrome()
    return
  }
  splash.classList.add('startup-splash--leaving')
  window.setTimeout(() => {
    splash.remove()
    delete document.documentElement.dataset.starting
    void syncApplicationWindowChrome()
  }, 420)
}

async function waitForStartup() {
  if (!isTauri()) return
  try {
    let timedOut = false
    const timeout = new Promise<void>(resolve => {
      window.setTimeout(() => {
        timedOut = true
        resolve()
      }, 20_000)
    })
    await Promise.race([invoke('wait_for_startup'), timeout])
    if (timedOut) console.warn('application-startup-timeout')
  } catch (error) {
    console.error('application-startup-error', error)
  }
}

void Promise.all([router.isReady(), waitForStartup()]).then(() => {
  const minimumVisibleTime = 900
  const remaining = Math.max(0, minimumVisibleTime - (performance.now() - startupStartedAt))
  window.setTimeout(dismissStartupSplash, remaining)
})
