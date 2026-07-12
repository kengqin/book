import { imageThemePresets } from './theme-image-presets'
import type { ThemeSettings } from './types'

export interface ThemePreset {
  id: string
  name: string
  image?: string
  settings: Omit<ThemeSettings, 'coverAssetId'>
}

export const themePresets: ThemePreset[] = [
  ...imageThemePresets,
  { id: 'paper', name: '旧纸书页', settings: { preset: 'paper', accent: '#a64232', background: '#e9e3d3', text: '#302f2b', overlay: 8, positionX: 50, positionY: 50 } },
  { id: 'night', name: '深夜阅读', settings: { preset: 'night', accent: '#d0aa62', background: '#121416', text: '#e9ece8', overlay: 62, positionX: 50, positionY: 50 } }
]

export function getThemePreset(id: string) { return themePresets.find(theme => theme.id === id) ?? themePresets[0] }
