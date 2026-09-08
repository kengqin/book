// Smooth geometry and one continuous timing curve for the entire page turn.
export const PAGE_TURN_DURATION = 3400
const sheetPoses = [
  "M32 22 C40 20 48 19 56 20 C56 28 56 38 56 48 C48 47 40 48 32 50 Z",
  "M32 22 C40 19 47 17 52 18 C53 26 54 35 54 45 C46 44 38 47 32 50 Z",
  "M32 22 C36 17 42 14 45 15 C47 23 49 32 48 40 C42 41 36 46 32 50 Z",
  "M32 22 C30 18 30 14 32 13 C35 21 39 30 38 38 C35 42 33 47 32 50 Z",
  "M32 22 C28 17 23 14 20 16 C22 24 25 32 25 41 C27 44 30 47 32 50 Z",
  "M32 22 C26 18 17 16 12 18 C12 26 13 35 13 44 C20 43 26 46 32 50 Z",
  "M32 22 C25 18 16 17 8 19 C8 27 8 37 8 46 C17 44 24 46 32 50 Z"
]
const clamp = (x: number) => Math.max(0, Math.min(1, x))
const smooth = (x: number) => { const t = clamp(x); return t * t * (3 - 2 * t) }

export function interpolatePage(poses: string[], progress: number): string {
  const points = poses.map(pose => pose.match(/-?\d+(?:\.\d+)?/g)!.map(Number))
  const position = clamp(progress) * (points.length - 1)
  const segment = Math.min(Math.floor(position), points.length - 2)
  const t = position - segment
  const at = (i: number, coordinate: number) => points[Math.max(0, Math.min(points.length - 1, i))]![coordinate]!
  let coordinate = 0
  return poses[0]!.replace(/-?\d+(?:\.\d+)?/g, () => {
    const a = at(segment - 1, coordinate), b = at(segment, coordinate)
    const c = at(segment + 1, coordinate), d = at(segment + 2, coordinate++)
    // Catmull-Rom keeps velocity continuous when passing each design pose.
    return (0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t)).toFixed(4)
  })
}

export function pageTurnFrame(phase: number) {
  const progress = smooth((phase - .08) / .68)
  // Landing matches the fixed left page exactly. The iteration boundary swaps
  // to the identical right page, so no fade, grey crossfade, or reverse turn is needed.
  return {
    sheet: { d: `path("${interpolatePage(sheetPoses, progress)}")`, opacity: 1 },
  }
}

export function startPageTurn() {
  const media = window.matchMedia('(prefers-reduced-motion: reduce)')
  let animations: Animation[] = []
  const update = () => {
    animations.forEach(animation => animation.cancel())
    animations = []
    if (media.matches) return
    for (const part of ['sheet'] as const) {
      const element = document.querySelector(`.startup-splash__${part}`)
      if (!element) continue
      // Browser interpolation fills between samples at the display refresh rate.
      const frames = Array.from({ length: 201 }, (_, i) => ({ ...pageTurnFrame(i / 200)[part], offset: i / 200 }))
      animations.push(element.animate(frames, { duration: PAGE_TURN_DURATION, iterations: Infinity, easing: 'linear' }))
    }
  }
  update()
  media.addEventListener('change', update)
  return () => {
    animations.forEach(animation => animation.cancel())
    media.removeEventListener('change', update)
  }
}
