/** 串口「备注名」共享逻辑（渲染进程标签页标题 / 连接栏标题共用）。
 *
 * 用户习惯给板子起个可读名字（例如「黑色串口板子」），保存在会话库里。标签页原先只显示
 * 裸端口号（COM1），滚了三个窗口后完全分不清哪块板子——这里按端口号把备注名关联回来。
 *
 * 备注来源优先级：
 * 1. 用户显式设置的端口备注（config.portLabels，键为端口路径，如 `COM1`）；
 * 2. 最近一次保存在该端口上的会话名；同端口多个会话时取会话列表中最靠前（最新）的；
 * 3. 都没有则返回空串，调用方回退到裸端口号。
 *
 * 端口名归一化：`com3` / `COM3` / `\\.\COM3` 视为同一端口（Windows 下大小写与 `\\.\` 前缀
 * 都合法，用户手输备注时常混用）。
 */

import type { SerialSessionInfo } from './serial'

/** 归一化端口名为大写 `COM3` 形式；非 `COM<n>` 端口（如 `/dev/ttyUSB0`）原样返回 */
export function normalizePortPath(path: string): string {
  const raw = path.trim()
  const m = /^(?:\\\\\.\\)?com(\d+)$/i.exec(raw)
  return m ? `COM${m[1]}` : raw
}

/**
 * 取端口备注名：显式备注优先，其次最近保存的会话名。
 * @param path 端口路径（如 `COM1`）
 * @param labels 端口备注表（键可为任意写法，函数内归一化比较）
 * @param sessions 已存会话（列表最靠前 = 最新保存）
 */
export function portRemark(
  path: string,
  labels: Record<string, string> | undefined,
  sessions: readonly SerialSessionInfo[] | undefined
): string {
  const key = normalizePortPath(path)
  if (!key) return ''
  const remembered = labels?.[key]?.trim()
  if (remembered) return remembered
  const session = sessions?.find((s) => normalizePortPath(s.params.path) === key && s.name.trim())
  return session?.name.trim() ?? ''
}

/**
 * 标签页标题：有备注时 `备注 (COM1)`，没有则裸端口号。
 * 备注与端口号相同时（用户直接把会话命名成端口号）不重复拼。
 */
export function portTabTitle(path: string, labels: Record<string, string> | undefined, sessions: readonly SerialSessionInfo[] | undefined): string {
  const port = normalizePortPath(path)
  const remark = portRemark(path, labels, sessions)
  if (!port) return remark
  if (!remark || remark === port || remark === path.trim()) return port
  return `${remark} (${port})`
}