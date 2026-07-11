import { defineConfig } from 'vitepress'

export default defineConfig({
  title: '永恒道途',
  description: '修仙小说《永恒道途》在线阅读',
  lang: 'zh-CN',
  base: '/book/',

  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '卷首', link: '/第一卷-山门有路/第一章-根浅而韧' }
    ],

    sidebar: [
      {
        text: '第一卷 · 山门有路',
        items: [
          { text: '第一章 根浅而韧', link: '/第一卷-山门有路/第一章-根浅而韧' },
          { text: '第二章 瓶中一滴春', link: '/第一卷-山门有路/第二章-瓶中一滴春' },
          { text: '第三章 山门三百四十里', link: '/第一卷-山门有路/第三章-山门三百四十里' },
          { text: '第四章 一柄旧药锄', link: '/第一卷-山门有路/第四章-一柄旧药锄' },
          { text: '第五章 四气入丹田', link: '/第一卷-山门有路/第五章-四气入丹田' },
          { text: '第六章 十九株乌鳞草', link: '/第一卷-山门有路/第六章-十九株乌鳞草' },
          { text: '第七章 账外之交', link: '/第一卷-山门有路/第七章-账外之交' },
          { text: '第八章 三次半拍', link: '/第一卷-山门有路/第八章-三次半拍' },
          { text: '第九章 第一寸剑痕', link: '/第一卷-山门有路/第九章-第一寸剑痕' },
          { text: '第十章 第一重练成', link: '/第一卷-山门有路/第十章-第一重练成' },
          { text: '第十一章 六十剑', link: '/第一卷-山门有路/第十一章-六十剑' },
          { text: '第十二章 黑风山朱榜', link: '/第一卷-山门有路/第十二章-黑风山朱榜' },
          { text: '第十三章 月光只剩一线', link: '/第一卷-山门有路/第十三章-月光只剩一线' },
          { text: '第十四章 山门警钟', link: '/第一卷-山门有路/第十四章-山门警钟' },
          { text: '第十五章 先赢眼前一剑', link: '/第一卷-山门有路/第十五章-先赢眼前一剑' },
          { text: '第十六章 白线以内', link: '/第一卷-山门有路/第十六章-白线以内' },
          { text: '第十七章 青莲未收', link: '/第一卷-山门有路/第十七章-青莲未收' },
          { text: '第十八章 第三名与旧伤', link: '/第一卷-山门有路/第十八章-第三名与旧伤' },
          { text: '第十九章 看剑，不看根', link: '/第一卷-山门有路/第十九章-看剑，不看根' },
          { text: '第二十章 一壶冷药', link: '/第一卷-山门有路/第二十章-一壶冷药' },
          { text: '第二十一章 十战九败', link: '/第一卷-山门有路/第二十一章-十战九败' },
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
