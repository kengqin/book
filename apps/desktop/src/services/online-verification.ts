export function isVerificationPage(html: string | Document): boolean {
  if (typeof html === 'string' && !/验证|请稍候|請稍候|安全检查|浏览器检查|challenge|captcha|Just a moment|Checking your browser|Verify you are human|Robot Check/iu.test(html)) return false
  const doc = typeof html === 'string' ? new DOMParser().parseFromString(html, 'text/html') : html
  if (/^(?:安全验证|人机验证|真人验证|访问验证|请稍候|請稍候|正在验证|安全检查|浏览器检查|Just a moment|Checking your browser|Verify you are human|Robot Check|Attention Required.*Cloudflare)/iu.test(doc.title.trim())) return true
  if (doc.querySelector('#challenge-form,#challenge-running,#cf-challenge-running,script[src*="challenge-platform/"][src*="orchestrate/"]')) return true
  const content = doc.querySelector('#content,#chaptercontent,#chapter-content,#txt,#article,.read-content,.chapter-content,.chapter_content,[itemprop="articleBody"]')?.textContent || ''
  if (content.trim().length >= 80) return false
  return Boolean(doc.querySelector('#captcha-form,form[action*="/captcha"],form[action*="/challenge"],iframe[src*="challenges.cloudflare.com"],iframe[src*="hcaptcha.com"],iframe[src*="recaptcha"]'))
    || /请完成人机验证|请先完成安全验证|正在进行安全验证|Verifying you are human|Checking if the site connection is secure/iu.test(doc.body?.textContent?.slice(0, 3000) || '')
}
