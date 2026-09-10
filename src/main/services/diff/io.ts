/**
 * diff 服务文件读取：BOM 嗅探、二进制判定、iconv 多编码解码
 */
import { promises as fs } from 'node:fs'
import iconv from 'iconv-lite'
import type { BinDetect, DiffEncoding, FileReadReq, FileReadRes, FileWriteReq, FileWriteRes } from '../../../shared/diff'
import { toHex } from '../../../shared/hexutil'

/** 文本读取上限（超出视为过大，仅回截断标记） */
export const TEXT_LIMIT = 8 * 1024 * 1024
/** 二进制判定：前多少字节内扫描 NUL */
const PROBE_LEN = 8192

interface BomRule {
  encoding: DiffEncoding
}

/** BOM 表：密钥为字节十六进制串 */
const BOM: Record<string, BomRule> = {
  'efbbbf': { encoding: 'utf8' },
  'fffe': { encoding: 'utf16le' },
  'feff': { encoding: 'utf16be' }
}

/** 读取文件按指定策略确定编码并解码 */
export async function readFileRes(req: FileReadReq): Promise<FileReadRes> {
  const res: FileReadRes = {
    ok: false,
    path: req.path,
    kind: 'binary',
    encoding: 'auto',
    size: 0
  }
  try {
    const st = await fs.stat(req.path)
    if (!st.isFile()) {
      res.error = '不是文件'
      return res
    }
    res.size = st.size
    const buf = await fs.readFile(req.path)

    // BOM 嗅探（先于显式选择，正确处理含 NUL 的 UTF-16）
    const b2 = toHex(buf.subarray(0, 2)).replace(/ /g, '').toLowerCase()
    const b4 = toHex(buf.subarray(0, 4)).replace(/ /g, '').toLowerCase()
    // UTF-32 BE（0000 feff）按 UTF-16BE 兜底；其余查 2 字节 BOM 表
    const bomEnc = b4 === '0000feff' ? { encoding: 'utf16be' as DiffEncoding } : BOM[b2]
    const useAuto = req.encoding === undefined || req.encoding === 'auto'

    let kind: BinDetect
    let encoding: string
    if (bomEnc && useAuto) {
      encoding = bomEnc.encoding
      kind = 'text'
    } else if (useAuto) {
      // 无 BOM：前 8KB 内含 NUL → 二进制；否则按 utf8 判文本
      kind = containsNul(buf.subarray(0, PROBE_LEN)) ? 'binary' : 'text'
      encoding = 'utf8'
    } else {
      encoding = req.encoding as string
      // 显式编码时按解码结果判文本/二进制
      kind = isTextUnder(buf, encoding) ? 'text' : 'binary'
    }

    res.encoding = encoding
    res.kind = kind
    res.hex = toHex(buf)
    if (kind === 'text') {
      if (buf.length > TEXT_LIMIT) {
        res.tooLarge = true
      } else {
        res.text = decode(buf, encoding)
      }
    }
    res.ok = true
    return res
  } catch (err) {
    res.error = err instanceof Error ? err.message : String(err)
    return res
  }
}

/** 前 len 字节内是否存在 NUL */
function containsNul(buf: Uint8Array): boolean {
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0) return true
  }
  return false
}

/** iconv 解码（strip BOM 由 iconv-lite 处理） */
export function decode(buf: Uint8Array, encoding: string): string {
  return iconv.decode(Buffer.from(buf), encoding)
}

/** 写回文件（按读入编码原样回写；写坏/写丢由调用方提示） */
export async function writeFileRes(req: FileWriteReq): Promise<FileWriteRes> {
  try {
    const buf = iconv.encode(req.content, req.encoding)
    await fs.writeFile(req.path, buf)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 以指定编码解码后，统计可打印字符比例判断是否为文本 */
function isTextUnder(buf: Uint8Array, encoding: string): boolean {
  const probe = buf.subarray(0, PROBE_LEN)
  if (containsNul(probe)) return false // 显式编码却含 NUL，仍判二进制
  let s = ''
  try {
    s = decode(probe, encoding)
  } catch {
    return false
  }
  let printable = 0
  let total = 0
  for (let i = 0; i < s.length && total < 200; i += 1) {
    const c = s.charCodeAt(i)
    total += 1
    if (
      c === 9 ||
      c === 10 ||
      c === 13 ||
      (c >= 32 && c <= 126) ||
      c >= 0xa0 // 含中西文多字节、制表符、换行
    ) {
      printable += 1
    }
  }
  if (total === 0) return true
  return printable / total > 0.9
}