// Indentation belongs to presentation, not to the stored book content.
export function normalizeParagraphStart(text: string): string {
  return text.replace(/^[\s\u3000]+/u, '')
}

export function prepareReaderParagraphs(safeHtml: string): string {
  const template = document.createElement('template')
  template.innerHTML = safeHtml
  template.content.querySelectorAll('p').forEach(paragraph => {
    if (paragraph.closest('pre, code, li, table, figure, blockquote')) return
    if (!paragraph.textContent?.trim() || paragraph.querySelector('img')) return
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node) {
      node.textContent = normalizeParagraphStart(node.textContent || '')
      if (node.textContent) break
      node = walker.nextNode()
    }
    paragraph.classList.add('reader-body-paragraph')
  })
  return template.innerHTML
}
