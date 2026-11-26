export const APP_UPDATES = 'app-updates'
export const APP_UPDATES_PANEL = 'workbench'

export type UpdateMessageCode =
  | 'UPDATE_RATE_LIMITED'
  | 'UPDATE_CHECK_FAILED'
  | 'UPDATE_DOWNLOAD_FAILED'
  | 'UPDATE_VERIFY_FAILED'
  | 'UPDATE_PREPARE_FAILED'
  | 'UPDATE_SAVED'
  | 'UPDATE_SAVE_FAILED'
  | 'UPDATE_APPLY_FAILED'
  | 'UPDATE_APPLY_LOCKED'

export interface UpdateRelease {
  version: string
  notes: string
  bytes: number
}

export type UpdateState =
  | { phase: 'disabled' | 'idle' | 'checking' | 'current' | 'publishing' }
  | { phase: 'available' | 'ready' | 'preparing'; release: UpdateRelease; message?: string; messageCode?: UpdateMessageCode; installable?: boolean }
  /** speed：平滑后的字节/秒，样本不足时缺省；source：经镜像下载时为镜像主机名，官方直连缺省 */
  | { phase: 'downloading'; release: UpdateRelease; received: number; speed?: number; source?: string }
  | { phase: 'check-failed'; message: string; messageCode?: UpdateMessageCode }

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

/**
 * 预检拒绝原路径更新时的提示：原因与对策。reason 是更新助手写进交接目录的 ready 信号，
 * detail 是它列出的具体条目（可能没有）；认不出的原因返回 undefined，由调用方落到通用提示。
 */
export function preflightRefusal(reason: string, detail: string, locale: 'zh-CN' | 'en' = 'zh-CN'): string | undefined {
  if (locale === 'en') {
    const items = detail ? ` (${detail})` : ''
    const elsewhere = 'or save the update package and extract it to a new folder.'
    switch (reason) {
      case 'directory':
        return detail
          ? `The application folder does not match the DevKit installation inventory${items}, so it cannot be updated in place. Save the update package and extract it to a new folder.`
          : 'The application folder could not be verified (it may not be readable), so it cannot be updated in place. Save the update package and extract it to a new folder.'
      case 'collision':
        return `The application folder contains files whose names collide with the new version${items}. Move them out of the application folder and try again, ${elsewhere}`
      case 'locked':
        return `Files in the application folder are in use by another program${items}. Close the related windows or programs and try again, ${elsewhere}`
      default:
        return undefined
    }
  }
  const items = detail ? `（${detail}）` : ''
  const elsewhere = '或将更新包另存并解压到新目录。'
  switch (reason) {
    case 'directory':
      return `程序目录${detail ? `与 DevKit 安装清单不符${items}` : '无法核对（可能没有读取权限）'}，无法原路径更新。请将更新包另存并解压到新目录。`
    case 'collision':
      return `程序目录里有与新版本同名的文件${items}，无法原路径更新。请先将它们移出程序目录后重试，${elsewhere}`
    case 'locked':
      return `程序目录里有文件正被其他程序占用${items}，无法原路径更新。请关闭相关窗口或程序后重试，${elsewhere}`
    default:
      return undefined
  }
}

/** 上次「重启并更新」没能完成时的提示；reason 是助手留下的原因码，没有更具体的原因时为空 */
export function applyFailureMessage(reason: string, locale: 'zh-CN' | 'en' = 'zh-CN'): string {
  if (locale === 'en') {
    return reason === 'locked'
      ? 'The last update did not finish because another program was using the application folder. Close the related windows or programs and try again, or save the update package.'
      : 'The last update did not finish. Try again or save the update package.'
  }
  return reason === 'locked'
    ? '上次更新未完成：程序目录被其他程序占用。关闭相关窗口或程序后可重试，或另存更新包。'
    : '上次更新未完成。可重试或另存更新包。'
}

export interface LeftoverFiles {
  /** 保留这些文件的备份目录（完整路径） */
  directory: string
  /** 没能放回程序目录的条目：相对程序目录的路径，目录以 / 结尾 */
  entries: string[]
}

/** 解析更新助手留下的 apply-leftover 标记：首行是备份目录，其后每行一个没放回的条目 */
export function parseLeftover(marker: string): LeftoverFiles | undefined {
  const [directory = '', ...rest] = marker.split(/\r?\n/).map((line) => line.trim())
  const entries = rest.filter(Boolean)
  return directory && entries.length > 0 ? { directory, entries } : undefined
}

/** 提示框里最多列出的条目数，其余合并成一行 */
const LEFTOVER_LISTED = 8

/** 遗留文件的提示框文案；第一个按钮打开备份目录 */
export function leftoverNotice(leftover: LeftoverFiles, locale: 'zh-CN' | 'en' = 'zh-CN'): { message: string; detail: string; buttons: string[] } {
  const listed = leftover.entries.slice(0, LEFTOVER_LISTED)
  const hidden = leftover.entries.length - listed.length
  if (locale === 'en') return {
    message: 'The update finished, but some files could not be restored to the application folder',
    detail: [
      'They remain unchanged in the backup folder below. Move them back manually, then delete the backup folder when it is no longer needed.',
      leftover.directory,
      '',
      ...listed,
      ...(hidden > 0 ? [`…and ${hidden} more`] : [])
    ].join('\n'),
    buttons: ['Open backup folder', 'OK']
  }
  return {
    message: '更新已完成，但程序目录里有些文件没能放回原处',
    detail: [
      '它们已原样保留在下面的备份目录里，请手动移回程序目录；不再需要时删除该目录即可。',
      leftover.directory,
      '',
      ...listed,
      ...(hidden > 0 ? [`…另有 ${hidden} 项`] : [])
    ].join('\n'),
    buttons: ['打开备份目录', '确定']
  }
}
