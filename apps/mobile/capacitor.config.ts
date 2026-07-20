import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.kengqin.novellibrary.mobile',
  appName: '小说书库',
  webDir: 'dist',
  bundledWebRuntime: false,
  server: {
    androidScheme: 'https'
  },
  android: {
    allowMixedContent: false,
    backgroundColor: '#0d1715'
  },
  ios: {
    backgroundColor: '#0d1715',
    contentInset: 'automatic'
  }
}

export default config
