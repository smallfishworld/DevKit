/**
 * 程序员计算器表达式引擎：BigInt 精度，按位宽截断
 * 支持：0x/0o/0b/十进制、+ - * / %、括号、& | ^ ~、<< >> >>>（逻辑右移）
 */

export type Width = 8 | 16 | 32 | 64

export interface EvalResult {
  /** 位宽截断后的值（无符号表示） */
  value: bigint
  /** 未截断的完整值 */
  full: bigint
  truncated: boolean
  error: string | null
}

const MASKS: Record<Width, bigint> = {
  8: (1n << 8n) - 1n,
  16: (1n << 16n) - 1n,
  32: (1n << 32n) - 1n,
  64: (1n << 64n) - 1n
}

export function maskOf(width: Width): bigint {
  return MASKS[width]
}

/** 无符号值 -> 有符号（补码解释） */
export function toSigned(value: bigint, width: Width): bigint {
  const mask = MASKS[width]
  const v = value & mask
  const signBit = 1n << BigInt(width - 1)
  return v & signBit ? v - (mask + 1n) : v
}

/** 有符号值 -> 无符号（补码） */
export function toUnsigned(value: bigint, width: Width): bigint {
  return BigInt.asUintN(width, value)
}

// ---------- 分词 ----------
type Token =
  | { t: 'num'; v: bigint }
  | { t: 'op'; v: string }
  | { t: 'lparen' }
  | { t: 'rparen' }

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (/\s/.test(ch)) {
      i += 1
      continue
    }
    if (ch === '(') {
      tokens.push({ t: 'lparen' })
      i += 1
      continue
    }
    if (ch === ')') {
      tokens.push({ t: 'rparen' })
      i += 1
      continue
    }
    // 数字：0x/0o/0b 前缀或十进制（支持下划线分隔）
    if (/[0-9]/.test(ch)) {
      let j = i
      if (ch === '0' && /[xob]/i.test(src[i + 1] ?? '')) {
        const base = { x: 16, o: 8, b: 2 }[src[i + 1].toLowerCase() as 'x' | 'o' | 'b']
        j = i + 2
        let digits = ''
        while (j < src.length && /[0-9a-f_]/i.test(src[j])) {
          if (src[j] !== '_') digits += src[j]
          j += 1
        }
        if (!digits) throw new Error(`无效的数字（位置 ${i}）`)
        tokens.push({ t: 'num', v: BigInt((base === 16 ? '0x' : base === 8 ? '0o' : '0b') + digits) })
      } else {
        let digits = ''
        while (j < src.length && /[0-9_]/.test(src[j])) {
          if (src[j] !== '_') digits += src[j]
          j += 1
        }
        tokens.push({ t: 'num', v: BigInt(digits) })
      }
      i = j
      continue
    }
    // 多字符运算符
    const two = src.slice(i, i + 3)
    if (two === '>>>') {
      tokens.push({ t: 'op', v: '>>>' })
      i += 3
      continue
    }
    const pair = src.slice(i, i + 2)
    if (pair === '<<' || pair === '>>') {
      tokens.push({ t: 'op', v: pair })
      i += 2
      continue
    }
    if ('+-*/%&|^~'.includes(ch)) {
      tokens.push({ t: 'op', v: ch })
      i += 1
      continue
    }
    throw new Error(`无法识别的字符 "${ch}"（位置 ${i}）`)
  }
  return tokens
}

// ---------- 递归下降解析求值 ----------
// 优先级：~ > * / % > + - > 移位 > & > ^ > |
class Parser {
  private pos = 0

  constructor(
    private readonly tokens: Token[],
    private readonly width: Width
  ) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos]
  }

  private next(): Token | undefined {
    return this.tokens[this.pos++]
  }

  /** 按位宽语义求值：/ % >> 按补码有符号解释，其余按无符号 */
  parse(): bigint {
    if (this.tokens.length === 0) throw new Error('空表达式')
    const v = this.parseOr()
    if (this.pos < this.tokens.length) throw new Error('表达式末尾有多余内容')
    return v
  }

  private parseOr(): bigint {
    let left = this.parseXor()
    while (this.isOp('|')) {
      this.pos += 1
      left |= this.parseXor()
    }
    return left
  }

  private parseXor(): bigint {
    let left = this.parseAnd()
    while (this.isOp('^')) {
      this.pos += 1
      left ^= this.parseAnd()
    }
    return left
  }

  private parseAnd(): bigint {
    let left = this.parseShift()
    while (this.isOp('&')) {
      this.pos += 1
      left &= this.parseShift()
    }
    return left
  }

  private parseShift(): bigint {
    let left = this.parseAdd()
    while (this.isOp('<<') || this.isOp('>>') || this.isOp('>>>')) {
      const op = (this.next() as { t: 'op'; v: string }).v
      const right = this.parseAdd()
      const shift = Number(right & 0xffffn) // 移位量按无符号低位取
      const lSigned = toSigned(left, this.width)
      if (op === '<<') left = left << BigInt(shift)
      else if (op === '>>') left = lSigned >> BigInt(shift)
      else left = left >> BigInt(shift)
    }
    return left
  }

  private parseAdd(): bigint {
    let left = this.parseMul()
    while (this.isOp('+') || this.isOp('-')) {
      const op = (this.next() as { t: 'op'; v: string }).v
      const right = this.parseMul()
      left = op === '+' ? left + right : left - right
    }
    return left
  }

  private parseMul(): bigint {
    let left = this.parseUnary()
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = (this.next() as { t: 'op'; v: string }).v
      const right = this.parseUnary()
      if (op === '*') {
        left = left * right
      } else {
        // 除法/取模按有符号补码语义
        const a = toSigned(left, this.width)
        const b = toSigned(right, this.width)
        if (b === 0n) throw new Error('除数为 0')
        left = op === '/' ? a / b : a % b
      }
    }
    return left
  }

  private parseUnary(): bigint {
    if (this.isOp('~')) {
      this.pos += 1
      return ~this.parseUnary()
    }
    if (this.isOp('-')) {
      this.pos += 1
      return -this.parseUnary()
    }
    if (this.isOp('+')) {
      this.pos += 1
      return this.parseUnary()
    }
    return this.parsePrimary()
  }

  private parsePrimary(): bigint {
    const tok = this.next()
    if (!tok) throw new Error('表达式意外结束')
    if (tok.t === 'num') return tok.v
    if (tok.t === 'lparen') {
      const v = this.parseOr()
      const close = this.next()
      if (!close || close.t !== 'rparen') throw new Error('缺少右括号')
      return v
    }
    throw new Error(`意外的运算符 "${(tok as { v: string }).v}"`)
  }

  private isOp(v: string): boolean {
    const tok = this.peek()
    return tok !== undefined && tok.t === 'op' && tok.v === v
  }
}

export function evalExpr(src: string, width: Width): EvalResult {
  try {
    const parser = new Parser(tokenize(src), width)
    const full = parser.parse()
    const value = full & MASKS[width]
    return { value, full, truncated: value !== full, error: null }
  } catch (err) {
    return {
      value: 0n,
      full: 0n,
      truncated: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

// ---------- 各进制格式化 ----------
export function fmtHex(v: bigint, width: Width): string {
  const hex = (v & MASKS[width]).toString(16).toUpperCase()
  const digits = width / 4
  const padded = hex.padStart(digits, '0')
  // 每两位（一字节）分组
  const groups = padded.match(/.{2}/g) ?? []
  return '0x' + groups.join(' ')
}

export function fmtDec(v: bigint, width: Width, signed: boolean): string {
  return signed ? toSigned(v, width).toString(10) : (v & MASKS[width]).toString(10)
}

export function fmtOct(v: bigint, width: Width): string {
  return '0o' + (v & MASKS[width]).toString(8)
}

export function fmtBin(v: bigint, width: Width): string {
  const bin = (v & MASKS[width]).toString(2).padStart(width, '0')
  return bin.match(/.{4}/g)?.join(' ') ?? bin
}

/** 字节布局：1~8 字节，大端/小端对照 */
export function byteLayout(v: bigint, width: Width): { be: string[]; le: string[] } {
  const byteCount = width / 8
  const mask = MASKS[width]
  const u = v & mask
  const bytes: string[] = []
  for (let i = byteCount - 1; i >= 0; i -= 1) {
    const b = (u >> BigInt(i * 8)) & 0xffn
    bytes.push(b.toString(16).toUpperCase().padStart(2, '0'))
  }
  // bytes 为大端序（MSB 在前）
  return { be: bytes, le: [...bytes].reverse() }
}
