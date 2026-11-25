export const APP_UPDATES = 'app-updates'
export const APP_UPDATES_PANEL = 'workbench'

export interface UpdateRelease {
  version: string
  notes: string
  bytes: number
}

export type UpdateState =
  | { phase: 'disabled' | 'idle' | 'checking' | 'current' | 'publishing' }
  | { phase: 'available' | 'ready' | 'preparing'; release: UpdateRelease; message?: string; installable?: boolean }
  /** speed：平滑后的字节/秒，样本不足时缺省；source：经镜像下载时为镜像主机名，官方直连缺省 */
  | { phase: 'downloading'; release: UpdateRelease; received: number; speed?: number; source?: string }
  | { phase: 'check-failed'; message: string }

/** 下载进度百分比（总大小未知时为 undefined） */
export function downloadPercent(received: number, bytes: number): number | undefined {
  if (!(bytes > 0)) return undefined
  return Math.min(100, Math.floor((received / bytes) * 100))
}

/** 速度文案：1 MB/s 以上保留一位小数，以下取整 KB/s */
export function formatSpeed(bytesPerSecond: number): string {
  return bytesPerSecond >= 1048576
    ? `${(bytesPerSecond / 1048576).toFixed(1)} MB/s`
    : `${Math.max(1, Math.round(bytesPerSecond / 1024))} KB/s`
}

/** 体积文案（MB，保留一位小数） */
export function formatMegabytes(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`
}

/** 下载来源说明：官方直连不标注；经第三方镜像时标出主机名，让用户知情 */
export function downloadSourceLabel(source: string | undefined): string {
  return source ? `经镜像 ${source} 加速` : ''
}

/**
 * 平滑测速：吃进累计字节数，吐出字节/秒。
 * 间隔不足 500ms 不更新（进度回调约 125ms 一次）；换源重来时字节回退，丢弃该样本并重置基线。
 */
export function createSpeedEstimator(now: () => number = Date.now): (received: number) => number | undefined {
  let lastAt = now()
  let lastBytes = 0
  let speed: number | undefined
  return (received: number): number | undefined => {
    const at = now()
    const elapsed = at - lastAt
    if (elapsed < 500) return speed
    if (received < lastBytes) {
      lastAt = at
      lastBytes = received
      return speed
    }
    const instant = ((received - lastBytes) / elapsed) * 1000
    lastAt = at
    lastBytes = received
    speed = speed === undefined ? instant : speed * 0.6 + instant * 0.4
    return speed
  }
}

export function updateNotice(state: UpdateState): string {
  switch (state.phase) {
    case 'available': return `发现新版本 v${state.release.version}`
    case 'ready': return `v${state.release.version} 已下载`
    case 'publishing': return '新版本正在发布，请稍后检查。'
    case 'checking': return '正在检查更新…'
    case 'current': return '当前已是最新版本。'
    case 'check-failed': return state.message
    case 'preparing': return '正在准备更新，完成后将重新启动 DevKit。'
    case 'downloading': {
      const percent = downloadPercent(state.received, state.release.bytes)
      return `正在下载更新…${percent === undefined ? '' : ` ${percent}%`}${state.speed ? `（${formatSpeed(state.speed)}）` : ''}`
    }
    default: return ''
  }
}
