import { createApp } from 'vue'
import { invoke, isTauri } from '@tauri-apps/api/core'
import App from './App.vue'
import { router } from './router'
import { syncApplicationWindowChrome } from './services/window-chrome'
import { PAGE_TURN_DURATION, startPageTurn } from './services/startup-animation'
import './styles.css'
import './styles/editorial.css'

window.addEventListener('contextmenu', event => event.preventDefault(), true)

const app = createApp(App).use(router)
const stopPageTurn = startPageTurn()
app.mount('#app')

function dismissStartupSplash() {
  const splash = document.getElementById('startup-splash')
  if (!splash) {
    stopPageTurn()
    delete document.documentElement.dataset.starting
    void syncApplicationWindowChrome()
    return
  }
  splash.classList.add('startup-splash--leaving')
  window.setTimeout(() => {
    stopPageTurn()
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
  // Local-only visual preview; production startup always dismisses normally.
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('startup-preview')) {
    // Optional frozen frame for visual QA, never included in production startup.
    const frame = new URLSearchParams(location.search).get('frame')
    if (frame !== null && Number.isFinite(Number(frame))) {
      const progress = Math.max(0, Math.min(1, Number(frame)))
      document.querySelectorAll<SVGElement>('.startup-splash__sheet').forEach(element => {
        element.getAnimations().forEach(animation => {
          animation.pause()
          animation.currentTime = progress * PAGE_TURN_DURATION
        })
      })
    }
    return
  }
  // Paint the ready interface before fading, without delaying startup for animation.
  requestAnimationFrame(() => requestAnimationFrame(dismissStartupSplash))
})
