/**
 * 文本 diff 引擎（主进程 diff:text 与渲染端复制同步共用——复制到对侧需即时重算，走本地不走 IPC）
 * jsdiff 逐行 diff + 变更块配对 + 行内（词级）差异 + 次要差异（仅空白/大小写）识别。
 * 输出双栏对齐行（AlignRow）：
 * - 连续 removed+added 区段合为一个变更块（block 编号，导航/概览用）
 * - 块内 del/add 行按 min 长度配对成 changed 行，行内各自给出片段级高亮
 * - 配对行内容仅空白/大小写不同（且未开对应忽略开关）→ 标为 minor（BC 的 unimportant）
 * - 多出的行归 only-left / only-right
 */
import * as jsdiff from 'diff'
import type { DiffOpts, InlineSeg, TextDiffRes, AlignRow } from './diff'

/** 配对行内 diff 累计行数上限：超出后降级为整行高亮（防大改动大文件的病态开销） */
const INLINE_LIMIT = 4000

/** 取原行用于展示，取归一化行用于比较 */
export function normalizeLine(line: string, opts: DiffOpts): string {
  let s = line.replace(/\s+$/, '')
  if (opts.ignoreSpace) s = s.replace(/\s+/g, '')
  if (opts.ignoreCase) s = s.toLowerCase()
  return s
}

const MINOR_OPTS: DiffOpts = { ignoreSpace: true, ignoreCase: true }

/** 忽略空白和大小写后是否相同（次要差异判定） */
function isMinorDiff(l: string, r: string): boolean {
  return normalizeLine(l, MINOR_OPTS) === normalizeLine(r, MINOR_OPTS)
}

export function textDiff(a: string, b: string, opts: DiffOpts): TextDiffRes {
  const aLines = splitLines(a)
  const bLines = splitLines(b)
  const parts = jsdiff.diffArrays(aLines, bLines, {
    comparator: (l: string, r: string) => normalizeLine(l, opts) === normalizeLine(r, opts)
  })

  const rows: AlignRow[] = []
  let la = 1 // 左侧真实行号
  let lb = 1 // 右侧真实行号
  let add = 0
  let del = 0
  let same = 0
  let minor = 0
  let block = -1
  let inlineUsed = 0

  let i = 0
  while (i < parts.length) {
    const p = parts[i]
    if (p.added || p.removed) {
      // 收集连续的 removed/added 区段
      const delLines: string[] = []
      const addLines: string[] = []
      while (i < parts.length && (parts[i].added || parts[i].removed)) {
        const cur = parts[i]
        if (cur.removed) delLines.push(...cur.value)
        else addLines.push(...cur.value)
        i += 1
      }
      block += 1
      const n = Math.min(delLines.length, addLines.length)
      for (let k = 0; k < n; k += 1) {
        // 次要差异：仅空白/大小写不同且未开对应忽略开关 → 标 minor（蓝色，可整体忽略）
        const isMinor = !opts.ignoreSpace && !opts.ignoreCase && isMinorDiff(delLines[k], addLines[k])
        let leftSegs: InlineSeg[]
        let rightSegs: InlineSeg[]
        if (inlineUsed < INLINE_LIMIT) {
          inlineUsed += 1
          leftSegs = inlineSegs(delLines[k], addLines[k], opts)
          rightSegs = inlineSegs(addLines[k], delLines[k], opts)
        } else {
          leftSegs = [{ text: delLines[k], changed: true }]
          rightSegs = [{ text: addLines[k], changed: true }]
        }
        if (isMinor) minor += 1
        rows.push({
          op: isMinor ? 'minor' : 'changed',
          block,
          left: { no: la + k, segs: leftSegs },
          right: { no: lb + k, segs: rightSegs }
        })
      }
      for (let k = n; k < delLines.length; k += 1) {
        rows.push({
          op: 'only-left',
          block,
          left: { no: la + k, segs: [{ text: delLines[k], changed: true }] }
        })
      }
      for (let k = n; k < addLines.length; k += 1) {
        rows.push({
          op: 'only-right',
          block,
          right: { no: lb + k, segs: [{ text: addLines[k], changed: true }] }
        })
      }
      del += delLines.length
      add += addLines.length
      la += delLines.length
      lb += addLines.length
    } else {
      for (const line of p.value) {
        rows.push({
          op: 'same',
          block: null,
          left: { no: la, segs: [{ text: line, changed: false }] },
          right: { no: lb, segs: [{ text: line, changed: false }] }
        })
        la += 1
        lb += 1
        same += 1
      }
      i += 1
    }
  }

  return {
    rows,
    blocks: block + 1,
    add,
    del,
    same,
    minor,
    identical: add === 0 && del === 0
  }
}

/**
 * 行内（词级）差异：jsdiff diffWords。
 * ignoreCase 时先 lower 再切、按片段长度 slice 回原文（保住原始大小写显示）；
 * 变长大小写映射（如 İ→i̇）会导致长度错位——退化整行高亮。
 */
export function inlineSegs(left: string, right: string, opts: DiffOpts): InlineSeg[] {
  const L = opts.ignoreCase ? left.toLowerCase() : left
  const R = opts.ignoreCase ? right.toLowerCase() : right
  if (L.length !== left.length || R.length !== right.length) {
    return [{ text: left, changed: true }]
  }
  const words = jsdiff.diffWords(L, R)
  const segs: InlineSeg[] = []
  let offset = 0
  for (const w of words) {
    if (w.added) continue // added 片段属于对侧，不占本侧偏移
    const text = left.slice(offset, offset + w.value.length)
    segs.push({ text, changed: !!w.removed })
    offset += w.value.length
  }
  return segs
}

/** 拆分行为整行数组（保留空行：空串也算一行） */
export function splitLines(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split(/\r\n|\r|\n/)
  // 以换行结尾时，jsdiff 会把末尾空串当成额外一行，导致多一行——修剪掉
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}
