import type { DevKitApi } from '../../preload/index'

declare global {
  interface Window {
    api: DevKitApi
  }
}

export {}
