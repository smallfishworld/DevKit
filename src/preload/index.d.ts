import type { DevKitApi } from './index'

declare global {
  interface Window {
    api: DevKitApi
  }
}

export {}
