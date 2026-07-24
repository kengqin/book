(() => {
  if (window.__novelLibraryWheelInjection) return
  window.__novelLibraryWheelInjection = true

  const connections = new Map()
  let accumulatedDelta = 0
  let lastMoveAt = 0

  function markedDecoration(start) {
    let element = start instanceof Element ? start : start?.parentElement
    for (let depth = 0; element && depth < 12; depth += 1, element = element.parentElement) {
      for (const pseudo of ['::before', '::after']) {
        const style = getComputedStyle(element, pseudo)
        if (style.getPropertyValue('--novel-library-wheel').trim() !== '1') continue
        const port = Number.parseInt(style.getPropertyValue('--novel-library-wheel-port').trim(), 10)
        const token = style.getPropertyValue('--novel-library-wheel-token').trim()
        if (port > 0 && /^[a-f0-9]{36}$/.test(token)) {
          return {
            port,
            token,
            element,
            pseudo,
            style,
            navigation: style.getPropertyValue('--novel-library-navigation').trim() === '1',
            previousEnabled: style.getPropertyValue('--novel-library-previous-enabled').trim() === '1',
            nextEnabled: style.getPropertyValue('--novel-library-next-enabled').trim() === '1'
          }
        }
      }
      if (element.classList.contains('monaco-editor')) break
    }
    return undefined
  }

  function connectionFor(endpoint) {
    const key = `${endpoint.port}/${endpoint.token}`
    let connection = connections.get(key)
    if (!connection || connection.socket.readyState > WebSocket.OPEN) {
      const socket = new WebSocket(`ws://127.0.0.1:${endpoint.port}/novel-library-wheel/${endpoint.token}`)
      connection = { socket, queue: [] }
      connections.set(key, connection)
      socket.addEventListener('open', () => {
        for (const message of connection.queue.splice(0)) socket.send(message)
      })
      socket.addEventListener('close', () => connections.delete(key), { once: true })
      socket.addEventListener('error', () => socket.close(), { once: true })
    }
    return connection
  }

  function sendMessage(endpoint, message) {
    const connection = connectionFor(endpoint)
    if (connection.socket.readyState === WebSocket.OPEN) connection.socket.send(message)
    else connection.queue.push(message)
  }

  function sendMove(endpoint, direction) {
    sendMessage(endpoint, String(direction))
  }

  const measurementCanvas = document.createElement('canvas')
  const measurementContext = measurementCanvas.getContext('2d')

  function decorationText(style) {
    const content = style.content || ''
    if (content.length < 2 || !['"', "'"].includes(content[0])) return content
    if (content[0] === '"') {
      try { return JSON.parse(content) } catch { }
    }
    return content.slice(1, -1).replace(/\\([\\'"])/g, '$1')
  }

  function measuredTextWidth(style, text) {
    if (!measurementContext) return text.length * (Number.parseFloat(style.fontSize) || 13)
    measurementContext.font = [style.fontStyle, style.fontVariant, style.fontWeight, style.fontSize, style.fontFamily]
      .filter(Boolean)
      .join(' ')
    const spacing = Number.parseFloat(style.letterSpacing) || 0
    return measurementContext.measureText(text).width + Math.max(0, text.length - 1) * spacing
  }

  function navigationDirection(marker, clientX) {
    if (!marker.navigation) return 0
    const text = decorationText(marker.style)
    const previousLabel = '[上一章]'
    const nextLabel = '[下一章]'
    const previousIndex = text.lastIndexOf(previousLabel)
    const nextIndex = text.lastIndexOf(nextLabel)
    if (previousIndex < 0 || nextIndex < 0) return 0
    const rect = marker.element.getBoundingClientRect()
    const start = marker.pseudo === '::after'
      ? rect.right - measuredTextWidth(marker.style, text)
      : rect.left + (Number.parseFloat(marker.style.paddingLeft) || 0)
    const previousStart = start + measuredTextWidth(marker.style, text.slice(0, previousIndex))
    const previousEnd = previousStart + measuredTextWidth(marker.style, previousLabel)
    const nextStart = start + measuredTextWidth(marker.style, text.slice(0, nextIndex))
    const nextEnd = nextStart + measuredTextWidth(marker.style, nextLabel)
    if (marker.previousEnabled && clientX >= previousStart && clientX <= previousEnd) return -1
    if (marker.nextEnabled && clientX >= nextStart && clientX <= nextEnd) return 1
    return 0
  }

  let discoveryTimer
  function scheduleDiscovery() {
    clearTimeout(discoveryTimer)
    discoveryTimer = setTimeout(() => {
      for (const element of document.querySelectorAll('.monaco-editor .view-line *')) {
        const endpoint = markedDecoration(element)
        if (endpoint) connectionFor(endpoint)
      }
    }, 180)
  }

  new MutationObserver(scheduleDiscovery).observe(document.documentElement, { childList: true, subtree: true })
  scheduleDiscovery()

  document.addEventListener('wheel', event => {
    if (event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
    const target = document.elementFromPoint(event.clientX, event.clientY) || event.target
    const endpoint = markedDecoration(target)
    if (!endpoint) {
      accumulatedDelta = 0
      return
    }
    event.preventDefault()
    event.stopImmediatePropagation()
    accumulatedDelta += event.deltaY
    const threshold = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 1 : 30
    if (Math.abs(accumulatedDelta) < threshold) return
    const now = Date.now()
    if (now - lastMoveAt < 70) return
    sendMove(endpoint, accumulatedDelta > 0 ? 1 : -1)
    accumulatedDelta = 0
    lastMoveAt = now
  }, { capture: true, passive: false })

  document.addEventListener('mousedown', event => {
    if (event.button !== 0) return
    const target = document.elementFromPoint(event.clientX, event.clientY) || event.target
    const endpoint = markedDecoration(target)
    const direction = endpoint ? navigationDirection(endpoint, event.clientX) : 0
    if (!direction) return
    event.preventDefault()
    event.stopImmediatePropagation()
    sendMessage(endpoint, `chapter:${direction}`)
  }, { capture: true })
})()
