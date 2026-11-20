import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    // Optional native packages must keep their loaders beside their installed prebuilds.
    plugins: [externalizeDepsPlugin({ include: ['uiohook-napi', 'koffi'] })],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'plugin-host': resolve('src/main/services/plugins/host.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [vue()]
  }
})
