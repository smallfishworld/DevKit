/**
 * 终端快捷命令（宏）共享模块：串口助手 / SSH 终端共用
 * 每条宏 = 步骤序列：命令（ASCII/HEX）、延时等待、特殊按键
 */

/** 单个步骤：发命令 / 延时 / 按键 */
export interface QuickCmdStep {
  type: 'cmd' | 'sleep' | 'key'
  /** 命令文本（cmd） */
  text?: string
  /** 命令格式（cmd，hex 时 text 为十六进制串） */
  mode?: 'ascii' | 'hex'
  /** 命令后追加 \r\n（cmd） */
  crlf?: boolean
  /** 延时毫秒（sleep） */
  ms?: number
  /** 按键转义序列（key，见 TERM_KEYS） */
  key?: string
}

/** 命名快捷命令：多步骤序列，点击后按顺序执行 */
export interface QuickCmd {
  name: string
  /** 分组名（空 = 未分组） */
  group?: string
  steps: QuickCmdStep[]
}

/** 常用按键（编辑器下拉选项；录制时按序号反查显示名） */
export const TERM_KEYS: { name: string; seq: string }[] = [
  { name: 'Enter', seq: '\r' },
  { name: 'Esc', seq: '\x1b' },
  { name: 'Tab', seq: '\t' },
  { name: 'Backspace', seq: '\x7f' },
  { name: 'Space', seq: ' ' },
  { name: 'Ctrl+C', seq: '\x03' },
  { name: 'Ctrl+D', seq: '\x04' },
  { name: 'Ctrl+Z', seq: '\x1a' },
  { name: 'Ctrl+U', seq: '\x15' },
  { name: 'Ctrl+L', seq: '\x0c' },
  { name: '↑', seq: '\x1b[A' },
  { name: '↓', seq: '\x1b[B' },
  { name: '←', seq: '\x1b[D' },
  { name: '→', seq: '\x1b[C' },
  { name: 'Home', seq: '\x1b[H' },
  { name: 'End', seq: '\x1b[F' },
  { name: 'Delete', seq: '\x1b[3~' },
  { name: 'PageUp', seq: '\x1b[5~' },
  { name: 'PageDown', seq: '\x1b[6~' },
  { name: 'F1', seq: '\x1bOP' },
  { name: 'F2', seq: '\x1bOQ' },
  { name: 'F3', seq: '\x1bOR' },
  { name: 'F4', seq: '\x1bOS' },
  { name: 'F5', seq: '\x1b[15~' },
  { name: 'F6', seq: '\x1b[17~' },
  { name: 'F7', seq: '\x1b[18~' },
  { name: 'F8', seq: '\x1b[19~' },
  { name: 'F9', seq: '\x1b[20~' },
  { name: 'F10', seq: '\x1b[21~' },
  { name: 'F11', seq: '\x1b[23~' },
  { name: 'F12', seq: '\x1b[24~' }
]

/** 转义序列 → 显示名（未收录则原样以 \xNN 形式显示） */
export function keyName(seq: string): string {
  return TERM_KEYS.find((k) => k.seq === seq)?.name ?? seq.replace(/\x1b/g, 'ESC')
}

/** 步骤 → 纯文本预览 */
export function stepPreview(st: QuickCmdStep): string {
  if (st.type === 'sleep') return `延时 ${st.ms}ms`
  if (st.type === 'key') return `按键 ${keyName(st.key ?? '')}`
  return st.mode === 'hex' ? `[HEX] ${st.text}` : `${st.text}${st.crlf ? '⏎' : ''}`
}

/** 兼容旧版单命令格式（{mode,text,newline}）→ 新步骤格式；保留分组 */
export function migrateQuickCmd(c: { name: string; group?: string; mode?: string; text?: string; newline?: string } | QuickCmd): QuickCmd {
  const anyC = c as { steps?: QuickCmdStep[]; mode?: string; text?: string; newline?: string }
  if (Array.isArray(anyC.steps)) {
    return { name: c.name, group: (c as QuickCmd).group ?? '', steps: anyC.steps }
  }
  return {
    name: c.name,
    group: c.group ?? '',
    steps: [
      {
        type: 'cmd',
        text: anyC.text ?? '',
        mode: anyC.mode === 'hex' ? 'hex' : 'ascii',
        crlf: anyC.newline !== 'none'
      }
    ]
  }
}

/** config.json 的 quickCmds 节 */
export interface QuickCmdsConfig {
  list: QuickCmd[]
  /** 已声明的分组名（允许空分组，独立于命令存在并持久化） */
  groups?: string[]
}

/** MobaXterm 宏按键名 → 终端转义序列（用于导入映射） */
const MOBA_KEY_MAP: Record<string, string> = {
  RETURN: '\r',
  ENTER: '\r',
  ESC: '\x1b',
  ESCAPE: '\x1b',
  TAB: '\t',
  BACKSPACE: '\x7f',
  SPACE: ' ',
  UP: '\x1b[A',
  DOWN: '\x1b[B',
  LEFT: '\x1b[D',
  RIGHT: '\x1b[C',
  HOME: '\x1b[H',
  END: '\x1b[F',
  DELETE: '\x1b[3~',
  PAGEUP: '\x1b[5~',
  PAGEDOWN: '\x1b[6~',
  INSERT: '\x1b[2~',
  F1: '\x1bOP',
  F2: '\x1bOQ',
  F3: '\x1bOR',
  F4: '\x1bOS',
  F5: '\x1b[15~',
  F6: '\x1b[17~',
  F7: '\x1b[18~',
  F8: '\x1b[19~',
  F9: '\x1b[20~',
  F10: '\x1b[21~',
  F11: '\x1b[23~',
  F12: '\x1b[24~'
}

/** MobaXterm 宏文本占位符还原 */
function unescapeMoba(text: string): string {
  return text.replace(/__DBLDOT__/g, ':').replace(/__PIIPE__/g, '|')
}

/**
 * 解析 MobaXterm 宏导出文件（.mxtmacros 或 ini 的 [Macros] 节，GBK 编码）
 * 步骤格式（| 分隔）：`258:13:1835009:RETURN`=按键；`0:0:0:SLEEPEQUAL100`=延时100ms；
 * `12:2:0:文本`=发送文本（后紧跟 RETURN 时合并为一条带换行的命令）。
 * 文本后紧跟的 RETURN 合并为 crlf 命令；空值条目（重复的 "(N)" 名）跳过。
 * @param raw 文本内容（已按 GBK 解码）
 * @param group 导入后的分组名
 */
export function parseMobaMacros(raw: string, group = 'MobaXterm 导入'): QuickCmd[] {
  // 只取 [Macros] 节（该节之后、下一节之前）
  const lines = raw.split(/\r?\n/)
  let inSection = false
  const out: QuickCmd[] = []
  for (const line of lines) {
    const sec = line.trim().match(/^\[(.+)\]$/)
    if (sec) {
      inSection = sec[1] === 'Macros'
      continue
    }
    if (!inSection) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const name = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (!name || !value) continue // 空值条目（重复名占位）跳过
    const steps = parseMobaSteps(value)
    if (steps.length === 0) continue
    out.push({ name, group, steps })
  }
  return out
}

/** 单条宏步骤串 → QuickCmdStep[]（文本+紧随 RETURN 合并为一条 crlf 命令） */
function parseMobaSteps(value: string): QuickCmdStep[] {
  const steps: QuickCmdStep[] = []
  const parts = value.split('|')
  for (const part of parts) {
    if (!part) continue
    // 形如 a:b:c:rest；rest 本身可含冒号（文本）
    const m = part.match(/^\d+:\d+:\d+:(.*)$/)
    if (!m) continue
    const rest = m[1]
    if (rest.startsWith('SLEEPEQUAL')) {
      const ms = Number(rest.slice('SLEEPEQUAL'.length))
      if (Number.isFinite(ms) && ms > 0) steps.push({ type: 'sleep', ms })
      continue
    }
    if (rest.startsWith('SLEEPGTE')) {
      const ms = Number(rest.slice('SLEEPGTE'.length))
      if (Number.isFinite(ms) && ms > 0) steps.push({ type: 'sleep', ms })
      continue
    }
    const keySeq = MOBA_KEY_MAP[rest.toUpperCase()]
    if (keySeq) {
      // 文本步骤后紧跟 RETURN → 合并为一条带换行命令
      const last = steps[steps.length - 1]
      if (keySeq === '\r' && last && last.type === 'cmd' && !last.crlf) {
        last.crlf = true
        continue
      }
      steps.push({ type: 'key', key: keySeq })
      continue
    }
    // 其余视为要发送的文本（无自动换行；RETURN 是显式按键步骤）
    const text = unescapeMoba(rest)
    if (text) steps.push({ type: 'cmd', text, mode: 'ascii', crlf: false })
  }
  // 结尾无 RETURN 的末条文本：保持不换行（忠实原宏）
  return steps
}

export const DEFAULT_QUICKCMDS_CONFIG: QuickCmdsConfig = {
  list: [
    {
      name: '复位(Atlas)',
      steps: [{ type: 'cmd', text: 'reset', mode: 'ascii', crlf: true }]
    },
    {
      name: '查询版本',
      steps: [{ type: 'cmd', text: 'version?', mode: 'ascii', crlf: true }]
    }
  ]
}
