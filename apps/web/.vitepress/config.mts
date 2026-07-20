import { defineConfig } from 'vitepress'
import library from './library.generated.json'

const sidebar: Record<string, Array<Record<string, unknown>>> = {}

for (const book of library.books) {
  const groups = new Map<string, typeof book.chapters>()
  for (const chapter of book.chapters) {
    const items = groups.get(chapter.group) ?? []
    items.push(chapter)
    groups.set(chapter.group, items)
  }

  for (const [group, chapters] of groups) {
    const routePrefix = `/${book.slug}/正文/${group}/`
    sidebar[routePrefix] = [{
      text: `${book.title} · ${chapters[0].label}—${chapters.at(-1)!.label}`,
      items: chapters.map(chapter => ({
        text: `${chapter.label} ${chapter.title}`,
        link: chapter.link
      }))
    }]
  }
}

export default defineConfig({
  title: '小说书库',
  description: '沉浸式在线小说阅读平台',
  lang: 'zh-CN',
  base: '/book/',
  srcDir: './书库',
  srcExclude: [
    '**/设定/**',
    '**/原文/**',
    '**/参考资料/**',
    '**/站点/**',
    '**/book.json',
    '**/README.md',
    '**/AGENTS.md'
  ],

  themeConfig: {
    nav: [
      { text: '书库', link: '/' },
      { text: '本地书架', link: '/本地书架/' },
      ...library.books.map(book => ({ text: book.title, link: book.topicLink }))
    ],
    sidebar,
    outline: false,
    docFooter: { prev: '上一章', next: '下一章' },
    darkModeSwitchLabel: '主题',
    sidebarMenuLabel: '目录',
    returnToTopLabel: '回到顶部'
  }
})
