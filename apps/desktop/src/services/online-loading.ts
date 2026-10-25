/** Direct HTTP sometimes returns only a script loader or an unfinished reader. */
export function needsBrowserRendering(html: string): boolean {
  if (!/<script\b/iu.test(html)) return false
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('script,style,noscript').forEach(element => element.remove())
  if ((doc.body.textContent || '').trim().length < 40) return true
  // Some hydrated book-detail pages deliver their catalogue only after mounting.
  if (doc.querySelector('#__nuxt') && !doc.querySelector('h1')) return true
  return Array.from(doc.querySelectorAll('#BookText,#chaptercontent,.chaptercontent,.read-content,.reader-content')).some(element =>
    /^(?:正在为您转码|正在加载|加载中|Loading)[\s.…!！]*$/iu.test((element.textContent || '').trim()))
}
