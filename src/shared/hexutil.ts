/** HEX 文本 <-> 字节 互转（串口/网络助手共用），渲染与主进程均可用 */

/** Buffer -> "AA BB CC" */
export function toHex(buf: Uint8Array): string {
  const out: string[] = []
  for (const b of buf) out.push(b.toString(16).padStart(2, '0').toUpperCase())
  return out.join(' ')
}

/**
 * 解析 HEX 文本为字节。宽容处理：空格/逗号/0x 前缀/连续写法（"AA BB" "0xaa,0xbb" "aabb"）
 * 返回 null 表示格式非法
 */
export function parseHex(text: string): Uint8Array | null {
  const cleaned = text
    .replace(/0x/gi, ' ')
    .replace(/[,;\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const compact = cleaned.replace(/ /g, '')
  if (compact.length === 0) return new Uint8Array(0)
  if (compact.length % 2 !== 0) return null
  if (!/^[0-9a-fA-F]+$/.test(compact)) return null
  const out = new Uint8Array(compact.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(compact.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/** 追加换行模式（发送时附加） */
export type NewlineMode = 'none' | 'crlf' | 'lf' | 'cr'

export function newlineBytes(mode: NewlineMode): Uint8Array {
  switch (mode) {
    case 'crlf':
      return new Uint8Array([0x0d, 0x0a])
    case 'lf':
      return new Uint8Array([0x0a])
    case 'cr':
      return new Uint8Array([0x0d])
    default:
      return new Uint8Array(0)
  }
}

/** 组装发送载荷：mode=hex 解析 HEX 文本；mode=ascii 文本 + 可选换行。返回 null 表示解析失败 */
export function buildPayload(
  mode: 'ascii' | 'hex',
  text: string,
  newline: NewlineMode
): Uint8Array | null {
  if (mode === 'hex') {
    const hex = parseHex(text)
    if (hex === null) return null
    const nl = newlineBytes(newline)
    const out = new Uint8Array(hex.length + nl.length)
    out.set(hex)
    out.set(nl, hex.length)
    return out
  }
  const body = new TextEncoder().encode(text)
  const nl = newlineBytes(newline)
  const out = new Uint8Array(body.length + nl.length)
  out.set(body)
  out.set(nl, body.length)
  return out
}
