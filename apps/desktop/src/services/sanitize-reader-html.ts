import DOMPurify from 'dompurify'

const allowedTags = [
  'p', 'div', 'span', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'b', 'em', 'i', 'u', 's', 'small', 'sub', 'sup', 'blockquote',
  'pre', 'code', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody',
  'tfoot', 'tr', 'th', 'td', 'caption', 'figure', 'figcaption', 'img', 'a'
]

export function sanitizeReaderHtml(html: string) {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: allowedTags,
    ALLOWED_ATTR: ['id', 'href', 'title', 'alt', 'src', 'width', 'height', 'colspan', 'rowspan'],
    ALLOW_DATA_ATTR: false,
    FORBID_ATTR: ['style', 'srcset'],
    KEEP_CONTENT: true
  })
}
