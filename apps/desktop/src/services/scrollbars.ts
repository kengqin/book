export function initializeScrollbars() {
  const visible = new Set<Element>()
  let pointer: { x: number; y: number } | undefined, frame = 0
  function clear() {
    cancelAnimationFrame(frame); pointer = undefined
    visible.forEach(element => element.removeAttribute('data-scrollbar-visible')); visible.clear()
  }
  function update() {
    if (!pointer) return
    const next = new Set<Element>()
    for (let element = document.elementFromPoint(pointer.x, pointer.y); element; element = element.parentElement) {
      const style = getComputedStyle(element)
      const viewport = element === document.scrollingElement
      if ((element.scrollHeight > element.clientHeight + 1 && (viewport || /auto|scroll|overlay/.test(style.overflowY)))
        || (element.scrollWidth > element.clientWidth + 1 && (viewport || /auto|scroll|overlay/.test(style.overflowX)))) next.add(element)
    }
    visible.forEach(element => { if (!next.has(element)) { element.removeAttribute('data-scrollbar-visible'); visible.delete(element) } })
    next.forEach(element => { if (!visible.has(element)) { element.setAttribute('data-scrollbar-visible', ''); visible.add(element) } })
  }
  function schedule(event?: PointerEvent) {
    if (event) pointer = { x: event.clientX, y: event.clientY }
    cancelAnimationFrame(frame); frame = requestAnimationFrame(update)
  }
  document.addEventListener('pointerover', schedule)
  document.addEventListener('pointermove', schedule)
  document.addEventListener('pointerout', event => { if (!event.relatedTarget) clear() })
  document.addEventListener('scroll', () => schedule(), true)
  window.addEventListener('resize', () => schedule())
  window.addEventListener('blur', clear)
  window.addEventListener('pagehide', clear)
}
