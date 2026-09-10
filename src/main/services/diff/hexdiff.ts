/**
 * 十六进制对比：16 字节对齐行，左右各一栏 hex（缺侧字节补 '--'）。
 * 输入为全量 hex 字符串（"AA BB"，来自 io.read），此处解析回字节并分块。
 */
import type { HexDiffReq, HexDiffRes, HexRow, HexRowType } from '../../../shared/diff'

const ROW = 16

export function hexDiff(req: HexDiffReq): HexDiffRes {
  const left = hexToBytes(req.leftHex)
  const right = hexToBytes(req.rightHex)
  const rows: HexRow[] = []
  const n = Math.max(left.length, right.length)
  let diffCount = 0

  for (let off = 0; off < n; off += ROW) {
    const lBytes: number[] = []
    const rBytes: number[] = []
    for (let i = 0; i < ROW; i += 1) {
      const pos = off + i
      const lb = pos < left.length ? left[pos] : -1
      const rb = pos < right.length ? right[pos] : -1
      lBytes.push(lb)
      rBytes.push(rb)
      if (lb !== rb) diffCount += 1
    }
    rows.push({
      offset: off,
      left: fmtRow(lBytes),
      right: fmtRow(rBytes),
      leftBytes: lBytes,
      rightBytes: rBytes,
      type: classify(lBytes, rBytes)
    })
  }

  const identical = diffCount === 0
  // 仅当完全一致时左右都无变化；diffCount 已含长度错位部分的计差
  return { rows, leftSize: left.length, rightSize: right.length, diffCount, identical }
}

/** 字节数组 → 16 个两位 hex 或 '--' */
function fmtRow(bytes: number[]): string {
  return bytes.map((b) => (b < 0 ? '--' : b.toString(16).padStart(2, '0').toUpperCase())).join(' ')
}

/** 单行类型：左右是否同（含长度错位侧的归类） */
function classify(l: number[], r: number[]): HexRowType {
  const same = l.every((b, i) => b === r[i])
  if (same) return 'same'
  // 哪一侧更长 / 各自独立多出的字节
  if (r.every((b) => b < 0)) return 'left' // 仅左有
  if (l.every((b) => b < 0)) return 'right' // 仅右有
  const lLen = l.filter((b) => b >= 0).length
  const rLen = r.filter((b) => b >= 0).length
  if (lLen > rLen) return 'left'
  if (rLen > lLen) return 'right'
  return 'lt' // 等长但内容不同
}

/** "AA BB" 空格分隔大写 hex 串 → 字节数组 */
function hexToBytes(hex: string): number[] {
  if (!hex) return []
  return hex
    .trim()
    .split(/\s+/)
    .filter((s) => s && s !== '--')
    .map((s) => parseInt(s, 16))
}