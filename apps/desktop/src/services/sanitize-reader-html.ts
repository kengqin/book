import DOMPurify from 'dompurify'

const allowedTags = [
  'p', 'div', 'span', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'b', 'em', 'i', 'u', 's', 'small', 'sub', 'sup', 'blockquote',
  'pre', 'code', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody',
  'tfoot', 'tr', 'th', 'td', 'caption', 'figure', 'figcaption', 'img', 'a'
]

const safeStyleProperties = new Set([
  'color', 'background-color', 'font-family', 'font-size', 'font-style', 'font-weight',
  'letter-spacing', 'line-height', 'text-align', 'text-decoration', 'text-indent', 'white-space'
])

function sanitizeInlineStyles(html: string) {
  const template = document.createElement('template')
  template.innerHTML = html
  template.content.querySelectorAll<HTMLElement>('[style]').forEach(element => {
    const safeDeclarations = element.getAttribute('style')
      ?.split(';')
      .map(declaration => {
        const separator = declaration.indexOf(':')
        if (separator < 0) return ''
        const property = declaration.slice(0, separator).trim().toLowerCase()
        const value = declaration.slice(separator + 1).trim()
        if (!safeStyleProperties.has(property) || !value || /url\s*\(|expression\s*\(|javascript\s*:/iu.test(value)) return ''
        return `${property}: ${value}`
      })
      .filter(Boolean)
      .join('; ')
    if (safeDeclarations) element.setAttribute('style', safeDeclarations)
    else element.removeAttribute('style')
  })
  return template.innerHTML
}

export function sanitizeReaderHtml(html: string, options: { preserveStyles?: boolean } = {}) {
  const cleanHtml = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: allowedTags,
    ALLOWED_ATTR: ['id', 'href', 'title', 'alt', 'src', 'width', 'height', 'colspan', 'rowspan', ...(options.preserveStyles ? ['style'] : [])],
    ALLOW_DATA_ATTR: false,
    FORBID_ATTR: [ ...(options.preserveStyles ? [] : ['style']), 'srcset'],
    KEEP_CONTENT: true
  })
  return options.preserveStyles ? sanitizeInlineStyles(cleanHtml) : cleanHtml
}
