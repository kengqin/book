import { defineConfig } from 'vitepress'

export default defineConfig({
  title: '永恒道途',
  description: '修仙小说《永恒道途》在线阅读',
  lang: 'zh-CN',
  base: '/book/',

  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '开始阅读', link: '/第一卷-青云初啼/第一章-寒门少年' }
    ],

    sidebar: [
      {
        text: '第一卷 · 青云初啼',
        items: [
          { text: '第一章 寒门少年', link: '/第一卷-青云初啼/第一章-寒门少年' },
          { text: '第二章 掌天瓶现', link: '/第一卷-青云初啼/第二章-掌天瓶现' },
          { text: '第三章 初入青云', link: '/第一卷-青云初啼/第三章-初入青云' },
          { text: '第四章 药园杂役', link: '/第一卷-青云初啼/第四章-药园杂役' },
          { text: '第五章 月下修炼', link: '/第一卷-青云初啼/第五章-月下修炼' },
          { text: '第六章 初试锋芒', link: '/第一卷-青云初啼/第六章-初试锋芒' },
          { text: '第七章 王胖子', link: '/第一卷-青云初啼/第七章-王胖子' },
          { text: '第八章 外门大比', link: '/第一卷-青云初啼/第八章-外门大比' },
          { text: '第九章 青元剑诀', link: '/第一卷-青云初啼/第九章-青元剑诀' },
          { text: '第十章 初遇苏婉', link: '/第一卷-青云初啼/第十章-初遇苏婉' },
          { text: '第十一章 剑气初成', link: '/第一卷-青云初啼/第十一章-剑气初成' },
          { text: '第十二章 生死任务', link: '/第一卷-青云初啼/第十二章-生死任务' },
          { text: '第十三章 绿液疗伤', link: '/第一卷-青云初啼/第十三章-绿液疗伤' },
          { text: '第十四章 反击', link: '/第一卷-青云初啼/第十四章-反击' },
          { text: '第十五章 大比前夜', link: '/第一卷-青云初啼/第十五章-大比前夜' },
          { text: '第十六章 内门大比（上）', link: '/第一卷-青云初啼/第十六章-内门大比（上）' },
          { text: '第十七章 内门大比（中）', link: '/第一卷-青云初啼/第十七章-内门大比（中）' },
          { text: '第十八章 内门大比（下）', link: '/第一卷-青云初啼/第十八章-内门大比（下）' },
          { text: '第十九章 拜师', link: '/第一卷-青云初啼/第十九章-拜师' },
          { text: '第二十章 师恩', link: '/第一卷-青云初啼/第二十章-师恩' },
        ]
      }
    ],

    outline: false,

    socialLinks: [
      { icon: 'github', link: 'https://github.com/kengqin/book' }
    ],

    search: {
      provider: 'local'
    },

    docFooter: {
      prev: '上一章',
      next: '下一章'
    },

    darkModeSwitchLabel: '主题',
    sidebarMenuLabel: '目录',
    returnToTopLabel: '回到顶部',
  }
})
