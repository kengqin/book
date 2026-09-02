import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      '.tools/**',
      'plugins/vscode/import-selection.test.mjs',
      'plugins/vscode/wheel-bridge.test.mjs',
    ],
  },
})
