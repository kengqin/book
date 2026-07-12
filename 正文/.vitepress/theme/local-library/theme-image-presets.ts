import inkMountains from './theme-images/ink-mountains.jpg'
import snowRidge from './theme-images/snow-ridge.png'
import starPath from './theme-images/star-path.jpg'
import type { ThemeSettings } from './types'

export interface ImageThemePreset {
  id: string
  name: string
  image: string
  settings: Omit<ThemeSettings, 'coverAssetId'>
}

// Add image-backed presets here after placing the image in theme-images/.
export const imageThemePresets: ImageThemePreset[] = [
  { id: 'ink', name: '水墨山河', image: inkMountains, settings: { preset: 'ink', accent: '#c9a866', background: '#101719', text: '#f1f2ef', overlay: 48, positionX: 50, positionY: 50 } },
  { id: 'snow', name: '风雪江湖', image: snowRidge, settings: { preset: 'snow', accent: '#d4b06b', background: '#15191c', text: '#f4f1eb', overlay: 42, positionX: 55, positionY: 50 } },
  { id: 'stars', name: '星河仙途', image: starPath, settings: { preset: 'stars', accent: '#83b8ae', background: '#101a20', text: '#eef4f0', overlay: 52, positionX: 50, positionY: 48 } }
]
