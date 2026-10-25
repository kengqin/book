import { invoke, isTauri } from '@tauri-apps/api/core'

export function initializeTooltips() {
  let target: Element | undefined, timer: ReturnType<typeof setTimeout> | undefined, id = Date.now() * 1000 + Math.floor(Math.random() * 1000)
  let keyboard = false, nativeQueue = Promise.resolve()
  const enqueue = (work: () => Promise<unknown>) => { nativeQueue = nativeQueue.then(work).then(() => {}, () => {}) }
  const convert = (element: Element) => {
    const title = element.getAttribute('title')
    if (title?.trim()) { element.setAttribute('data-tooltip', title.trim()); element.removeAttribute('title') }
  }
  const scan = (root: ParentNode) => { if (root instanceof Element) convert(root); root.querySelectorAll('[title]').forEach(convert) }
  scan(document)
  new MutationObserver(records => { for (const record of records) { if (record.type === 'attributes') convert(record.target as Element); else record.addedNodes.forEach(node => { if (node instanceof Element) scan(node) }) } }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['title'] })
  function hide() {
    clearTimeout(timer); target = undefined
    document.querySelector('.app-tooltip-fallback')?.remove()
    const previous = id
    if (isTauri()) enqueue(() => invoke('hide_floating_layer', { kind: 'tooltip', id: previous }))
  }
  function show(element: Element) {
    if (target === element) return
    hide(); target = element
    timer = setTimeout(() => {
      if (target !== element || !element.isConnected) return
      const text = element.getAttribute('data-tooltip'); if (!text) return
      const r = element.getBoundingClientRect(), current = ++id
      const variant = element.getAttribute('data-tooltip-variant') || undefined
      if (isTauri()) enqueue(async () => {
        if (target !== element || !element.isConnected || current !== id) return
        await invoke('show_floating_layer', { kind: 'tooltip', input: { id: current, text, variant, anchor: { x: r.x, y: r.y, width: r.width, height: r.height, right: Boolean(element.closest('.app-sidebar')) } } })
        if (target !== element || !element.isConnected) await invoke('hide_floating_layer', { kind: 'tooltip', id: current })
      })
      else {
        const hint = document.createElement('div'); hint.className = `app-tooltip-fallback${variant === 'page-title' ? ' app-tooltip-fallback--title' : ''}`; hint.textContent = text; hint.setAttribute('role', 'tooltip')
        hint.style.left = `${Math.max(8,Math.min(innerWidth - 200,r.x + r.width / 2 - 60))}px`; hint.style.top = `${r.bottom + 8}px`; document.body.append(hint)
      }
    }, 380)
  }
  document.addEventListener('pointerover', event => { const element = (event.target as Element).closest?.('[data-tooltip],[title]'); if (element) { convert(element); show(element) } })
  document.addEventListener('pointerout', event => { if (target && !target.contains(event.relatedTarget as Node | null)) hide() })
  document.addEventListener('focusin', event => { if (!keyboard) return; const element = (event.target as Element).closest?.('[data-tooltip],[title]'); if (element) { convert(element); show(element) } })
  document.addEventListener('focusout', hide)
  document.addEventListener('pointerdown', () => { keyboard = false; hide() }, true)
  document.addEventListener('keydown', event => { keyboard = event.key === 'Tab'; hide() }, true)
  document.addEventListener('scroll', hide, true)
  window.addEventListener('blur', hide)
  window.addEventListener('pagehide', hide)
  new MutationObserver(() => { if (target && !target.isConnected) hide() }).observe(document.body, { childList: true, subtree: true })
}
