import { ref } from 'vue'

export type Appearance = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'novel-library:appearance'

function readAppearance(): Appearance {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
  } catch {
    return 'system'
  }
}

const appearance = ref<Appearance>(readAppearance())

function applyAppearance(value: Appearance) {
  document.documentElement.dataset.appearance = value
}

applyAppearance(appearance.value)

export function useAppearance() {
  function setAppearance(value: Appearance) {
    appearance.value = value
    applyAppearance(value)
    try {
      localStorage.setItem(STORAGE_KEY, value)
    } catch {
      // The selected appearance remains available for the current session.
    }
  }

  return { appearance, setAppearance }
}
