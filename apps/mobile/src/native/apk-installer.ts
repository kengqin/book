import { registerPlugin } from '@capacitor/core'

interface ApkInstallerPlugin {
  install(options: { url: string; sha256?: string }): Promise<void>
}

export const ApkInstaller = registerPlugin<ApkInstallerPlugin>('ApkInstaller')
