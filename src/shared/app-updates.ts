export const APP_UPDATES = 'app-updates'
export const APP_UPDATES_PANEL = 'workbench'

export interface UpdateRelease {
  version: string
  notes: string
  bytes: number
}

export type UpdateState =
  | { phase: 'disabled' | 'idle' | 'checking' | 'current' | 'publishing' }
  | { phase: 'available' | 'ready' | 'preparing'; release: UpdateRelease; message?: string }
  | { phase: 'downloading'; release: UpdateRelease; received: number }
  | { phase: 'check-failed'; message: string }

export function updateNotice(state: UpdateState): string {
  switch (state.phase) {
    case 'available': return `发现新版本 v${state.release.version}`
    case 'ready': return `v${state.release.version} 已下载`
    case 'publishing': return '新版本正在发布，请稍后检查。'
    case 'checking': return '正在检查更新…'
    case 'current': return '当前已是最新版本。'
    case 'check-failed': return state.message
    case 'preparing': return '正在准备更新，完成后将重新启动 DevKit。'
    case 'downloading': return '正在下载更新…'
    default: return ''
  }
}
