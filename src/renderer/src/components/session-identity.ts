/**
 * 最近会话身份键（纯函数，供 tabs store 与 tests/ 共用）。
 * 同一串口（含参数）/ SSH 主机 / 工作目录视为同一会话；
 * tab id 每次打开自增（serial#1、serial#2…），不能作为身份依据。
 */
import type { TabItem } from '../stores/tabs'

export type SessionLike = Pick<TabItem, 'toolId' | 'serialParams' | 'sshParams' | 'shell'>

export function sessionIdentity(tab: SessionLike): string {
  if (tab.serialParams?.path) {
    const p = tab.serialParams
    return `serial:${p.path}:${p.baudRate}:${p.dataBits}:${p.parity}:${p.stopBits}`
  }
  if (tab.sshParams?.host) return `ssh:${tab.sshParams.username ?? ''}@${tab.sshParams.host}:${tab.sshParams.port ?? 22}`
  if (tab.shell?.cwd) return `shell:${tab.toolId}:${tab.shell.cwd}`
  return `tab:${tab.toolId}`
}

/**
 * 最近会话列表去重：同身份只保留最新（放在最前）的一条。
 * sanitizeRecent 启动清洗与 remember 运行时去重共用。
 */
export function dedupeRecent<T extends SessionLike & { id: string }>(list: T[]): T[] {
  const seen = new Set<string>()
  return list.filter((entry) => {
    const key = sessionIdentity(entry)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
