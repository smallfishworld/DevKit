/** Stable result codes cross IPC; user-facing text is localized at the edge. */
export const IPC_RESULT_CODES = {
  CANCELLED: 'CANCELLED',
  EMPTY: 'EMPTY'
} as const

export type IpcResultCode = (typeof IPC_RESULT_CODES)[keyof typeof IPC_RESULT_CODES]

export interface IpcFailure {
  ok: false
  code?: IpcResultCode
  /** Compatibility/detail fallback. Never branch on this text. */
  error?: string
}
