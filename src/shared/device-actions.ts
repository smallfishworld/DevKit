/**
 * 设备动作配置结构（主进程解析 + 渲染进程表单共用）。
 * 解析与校验在主进程 device-actions-config.ts，渲染端只负责编辑这个结构。
 */

export type DeviceActionKind = 'challenge-response'
/** manual = 快捷命令步骤发起；auto = 串口常驻监听，设备输出命中特征码即执行 */
export type DeviceActionTrigger = 'manual' | 'auto'

export interface DeviceActionDetectPrefix {
  type: 'prefix'
  /** 行首前缀，前缀后为挑战码（如 "Challenge:"） */
  prefix: string
}
export interface DeviceActionDetectBase64 {
  type: 'base64-line'
  shortMin: number
  shortMax: number
  longMin: number
  longMinDecoded: number
}
export type DeviceActionDetect = DeviceActionDetectPrefix | DeviceActionDetectBase64

export interface DeviceActionResultLine {
  type: 'line'
  successLine: string
  failureLine: string
}
export interface DeviceActionResultPrompt {
  type: 'prompt-repeat'
  promptText: string
  decisionDelayMs: number
  silenceMs: number
}
export type DeviceActionResult = DeviceActionResultLine | DeviceActionResultPrompt

export interface DeviceActionHold {
  maxBytes: number
  maxMs: number
}

export interface DeviceActionProfile {
  id: string
  label: string
  actionLabel: string
  kind: DeviceActionKind
  trigger: DeviceActionTrigger
  triggerWords: string[]
  detect: DeviceActionDetect
  result: DeviceActionResult
  command?: string
  newline: 'cr' | 'lf' | 'crlf'
  challengeTimeoutMs: number
  challengeTtlMs: number
  resultTimeoutMs: number
  holdInput: false | DeviceActionHold
}

export interface DeviceActionAuthCheckJson {
  type: 'json'
  url: string
  field: string
}
export interface DeviceActionAuthCheckHttp {
  type: 'http-ok'
  url: string
}
export type DeviceActionAuthCheck = DeviceActionAuthCheckJson | DeviceActionAuthCheckHttp

export interface DeviceActionIssue {
  url: string
  /** POST JSON 体模板，值中的 $challenge 会被挑战码替换 */
  body: Record<string, string>
  /** 响应中点路径取口令（如 data.data） */
  responsePath: string
  /** 这些 HTTP 状态视为登录失效 */
  loginExpiredHttp: number[]
  /** 这些业务 code 视为登录失效 */
  loginExpiredCodes: string[]
  /** 过期后自动重新登录一次再重试 */
  retryLoginOnce: boolean
  userAgent?: string
}

export interface DeviceActionsConfig {
  loginUrl: string
  authOrigins: string[]
  authCheck: DeviceActionAuthCheck
  issue: DeviceActionIssue
  profiles: DeviceActionProfile[]
}

/** 新增动作的默认值：手动档发 debug 读 Challenge:；自动档监听裸 base64 并按 Password: 判定。 */
export function createDeviceActionProfile(trigger: DeviceActionTrigger, id: string): DeviceActionProfile {
  const auto = trigger === 'auto'
  return {
    id,
    label: auto ? '自动应答设备' : '设备动作',
    actionLabel: auto ? '自动解锁 Debug' : '解锁 Debug',
    kind: 'challenge-response',
    trigger,
    triggerWords: auto ? ['debug'] : [],
    detect: auto
      ? { type: 'base64-line', shortMin: 20, shortMax: 21, longMin: 300, longMinDecoded: 260 }
      : { type: 'prefix', prefix: 'Challenge:' },
    result: auto
      ? { type: 'prompt-repeat', promptText: 'Password:', decisionDelayMs: 150, silenceMs: 3000 }
      : { type: 'line', successLine: 'Debug unlocked', failureLine: 'Debug denied' },
    command: auto ? undefined : 'debug',
    newline: 'cr',
    challengeTimeoutMs: 5000,
    challengeTtlMs: 30_000,
    resultTimeoutMs: 5000,
    holdInput: auto ? { maxBytes: 4096, maxMs: 15_000 } : false
  }
}

/** 首次使用时的完整示例（地址与字段均为占位，需按公司环境修改）。 */
export function createDeviceActionsExample(): DeviceActionsConfig {
  const manual = createDeviceActionProfile('manual', 'debug-unlock')
  manual.label = 'Release 设备解锁 Debug'
  const auto = createDeviceActionProfile('auto', 'debug-auto')
  auto.label = 'Release 设备自动解锁'
  return {
    loginUrl: 'https://oa.example.com/login',
    authOrigins: [],
    authCheck: { type: 'json', url: 'https://oa.example.com/api/session', field: 'authenticated' },
    issue: {
      url: 'https://oa.example.com/api/device/token',
      body: { challenge: '$challenge' },
      responsePath: 'response',
      loginExpiredHttp: [401, 403],
      loginExpiredCodes: [],
      retryLoginOnce: true
    },
    profiles: [manual, auto]
  }
}
