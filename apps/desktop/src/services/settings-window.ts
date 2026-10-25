import { invoke, isTauri } from '@tauri-apps/api/core'
export async function openSettingsWindow(section: 'general' | 'storage' | 'updates' = 'general') {
  if (isTauri()) await invoke('open_settings_window', { section })
  else location.hash = section === 'updates' ? '/settings/updates' : '/settings'
}
