import inkMountains from './theme-images/ink-mountains.jpg'
import snowRidge from './theme-images/snow-ridge.png'
import starPath from './theme-images/star-path.jpg'
import moonlitBamboo from './theme-images/moonlit-bamboo.png'
import desertDawn from './theme-images/desert-dawn.png'
import rainAlley from './theme-images/rain-alley.png'
import autumnLake from './theme-images/autumn-lake.png'
import twilightCoast from './theme-images/twilight-coast.png'
import auroraIce from './theme-images/aurora-ice.png'
import amberLibrary from './theme-images/amber-library.png'
import mistyPines from './theme-images/misty-pines.png'
import violetObservatory from './theme-images/violet-observatory.png'
import springValley from './theme-images/spring-valley.png'
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
  { id: 'stars', name: '星河仙途', image: starPath, settings: { preset: 'stars', accent: '#83b8ae', background: '#101a20', text: '#eef4f0', overlay: 52, positionX: 50, positionY: 48 } },
  { id: 'bamboo-moon', name: '竹影月河', image: moonlitBamboo, settings: { preset: 'bamboo-moon', accent: '#b7d8d2', background: '#14252a', text: '#edf4f1', overlay: 44, positionX: 50, positionY: 50 } },
  { id: 'desert-dawn', name: '荒原晨光', image: desertDawn, settings: { preset: 'desert-dawn', accent: '#e3ae75', background: '#312726', text: '#fff3e6', overlay: 38, positionX: 52, positionY: 50 } },
  { id: 'rain-alley', name: '雨巷微灯', image: rainAlley, settings: { preset: 'rain-alley', accent: '#dfaa66', background: '#111a20', text: '#f4f1e9', overlay: 55, positionX: 50, positionY: 48 } },
  { id: 'autumn-lake', name: '秋湖斜阳', image: autumnLake, settings: { preset: 'autumn-lake', accent: '#d67c4e', background: '#33271f', text: '#fff5e8', overlay: 42, positionX: 50, positionY: 50 } },
  { id: 'twilight-coast', name: '海崖暮色', image: twilightCoast, settings: { preset: 'twilight-coast', accent: '#84bccc', background: '#142433', text: '#edf5f7', overlay: 48, positionX: 50, positionY: 48 } },
  { id: 'aurora-ice', name: '极光冰原', image: auroraIce, settings: { preset: 'aurora-ice', accent: '#69e3cb', background: '#0b1b32', text: '#e8fbff', overlay: 42, positionX: 50, positionY: 46 } },
  { id: 'amber-library', name: '琥珀书房', image: amberLibrary, settings: { preset: 'amber-library', accent: '#dda968', background: '#241a13', text: '#fff3df', overlay: 52, positionX: 50, positionY: 50 } },
  { id: 'misty-pines', name: '松谷晨雾', image: mistyPines, settings: { preset: 'misty-pines', accent: '#a9c9ae', background: '#173129', text: '#eff6ef', overlay: 36, positionX: 50, positionY: 50 } },
  { id: 'violet-observatory', name: '紫夜观星', image: violetObservatory, settings: { preset: 'violet-observatory', accent: '#c7a7eb', background: '#171126', text: '#f3edff', overlay: 50, positionX: 52, positionY: 45 } },
  { id: 'spring-valley', name: '春谷花桥', image: springValley, settings: { preset: 'spring-valley', accent: '#9bc982', background: '#1d3527', text: '#f0f8ea', overlay: 34, positionX: 50, positionY: 48 } }
]
