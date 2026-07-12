import jianlaiHero from '../../../../书库/剑来/站点/jianlai-hero.jpg'
import xuezhongHero from '../../../../书库/雪中悍刀行/站点/xuezhong-hero.png'
import eternalHero from '../../../../书库/永恒道途/站点/eternal-path-hero.jpg'
import type { ThemeSettings } from './types'

export interface ThemePreset {
  id: string
  name: string
  image?: string
  settings: Omit<ThemeSettings, 'coverAssetId'>
}

export const themePresets: ThemePreset[] = [
  { id: 'ink', name: '水墨山河', image: jianlaiHero, settings: { preset: 'ink', accent: '#c9a866', background: '#101719', text: '#f1f2ef', overlay: 48, positionX: 50, positionY: 50 } },
  { id: 'snow', name: '风雪江湖', image: xuezhongHero, settings: { preset: 'snow', accent: '#d4b06b', background: '#15191c', text: '#f4f1eb', overlay: 42, positionX: 55, positionY: 50 } },
  { id: 'stars', name: '星河仙途', image: eternalHero, settings: { preset: 'stars', accent: '#83b8ae', background: '#101a20', text: '#eef4f0', overlay: 52, positionX: 50, positionY: 48 } },
  { id: 'paper', name: '旧纸书页', settings: { preset: 'paper', accent: '#a64232', background: '#e9e3d3', text: '#302f2b', overlay: 8, positionX: 50, positionY: 50 } },
  { id: 'night', name: '深夜阅读', settings: { preset: 'night', accent: '#d0aa62', background: '#121416', text: '#e9ece8', overlay: 62, positionX: 50, positionY: 50 } }
]

export function getThemePreset(id: string) { return themePresets.find(theme => theme.id === id) ?? themePresets[0] }

