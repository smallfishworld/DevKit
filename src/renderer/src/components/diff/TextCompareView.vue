<script setup lang="ts">
/**
 * 双栏对齐文本对比（对标 VSCode diff editor + Beyond Compare）：
 * - 单滚动容器 + 每行一个 grid div（行号|左文|复制钮|行号|右文），天然两侧对齐
 * - 折叠相同区（>8 行连续相同收起，点击展开）；变更块头部整块复制；悬停行单行复制到对侧
 * - 次要差异（仅空白/大小写）蓝标可整体忽略；只看差异；内联（VSCode 式 +/-）视图
 * - 概览条：差异块刻度 + 当前视窗框，点击跳块；上一处/下一处导航（已同步块实时退出序列）
 * - 引擎在渲染端本地跑（shared/textdiff）：复制后即时重算，零 IPC 延迟
 * - 保存：按读入编码写回左右文件（复制只改内存，显式「保存」才落盘）
 */
import { computed, nextTick, onMounted, ref, shallowRef, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { ArrowDown, ArrowUp, FolderOpened } from '@element-plus/icons-vue'
import type { AlignRow, DiffEncoding, InlineSeg, TextDiffRes } from '../../../../shared/diff'
import { textDiff } from '../../../../shared/textdiff'
import { ENCODINGS, useDiff } from '../../composables/useDiff'
import { useDropSides } from '../../composables/useDiffDrop'

const props = defineProps<{
  /** 父层（文件夹视图"对比文件"）传入的待比较文件；seq 递增防同路径不触发 */
  pending?: { left: string; right: string; hex: boolean; seq: number } | null
}>()

const { pickFile, readFile, writeFile } = useDiff()

// ---------- 基础状态 ----------
const left = ref('')
const right = ref('')
const leftPath = ref('')
const rightPath = ref('')
/** 读入时实际采用的编码（保存时原样回写，避免 GBK 文件写坏） */
const leftEnc = ref('utf8')
const rightEnc = ref('utf8')
/** 行结束符（保存/复制重组时保持 CRLF 不丢） */
let leftEol = '\n'
let rightEol = '\n'

const enc = ref<DiffEncoding>('auto')
const ignoreSpace = ref(false)
const ignoreCase = ref(false)
/** 忽略次要差异（仅空白/大小写不同的变更行视为相同） */
const ignoreMinor = ref(false)
const onlyDiff = ref(false)
const foldSame = ref(true)
const inlineView = ref(false)
const binaryHint = ref('')
const tooLargeHint = ref('')
/** 复制后未保存标记 */
const dirty = ref(false)

const result = shallowRef<TextDiffRes | null>(null)
const busy = ref(false)
/** 手输/粘贴原文的编辑区（对比出结果后自动收起，可再展开改文本） */
const showEditors = ref(true)

// ---------- 行文本工具 ----------
function textOf(row: AlignRow, side: 'left' | 'right'): string {
  const cell = side === 'left' ? row.left : row.right
  if (!cell) return ''
  return cell.segs.map((s) => s.text).join('')
}

/** 按行结束符拆行 */
function sideLines(text: string, eol: string): string[] {
  return text.split(eol === '\r\n' ? /\r\n/ : /\n/)
}
/** 引擎有效行数（引擎把末尾空行去掉；splice 插入须按引擎行号） */
function engineLen(arr: string[]): number {
  return arr.length > 0 && arr[arr.length - 1] === '' ? arr.length - 1 : arr.length
}

// ---------- 差异判定 ----------
/** 有效差异行：非 same，且开「忽略次要差异」时 minor 视为相同 */
function effDiffRow(row: AlignRow): boolean {
  if (row.op === 'same') return false
  if (row.op === 'minor' && ignoreMinor.value) return false
  return true
}

/** 仍存在差异的块（导航序列；复制同步后实时缩短） */
const liveBlocks = computed<number[]>(() => {
  const r = result.value
  if (!r) return []
  const set = new Set<number>()
  r.rows.forEach((row) => {
    if (row.block !== null && effDiffRow(row)) set.add(row.block)
  })
  return [...set].sort((a, b) => a - b)
})

// ---------- 显示列表（折叠 + 块头 + 行） ----------
interface DispItem {
  kind: 'row' | 'fold' | 'head'
  row?: AlignRow
  ri?: number
  hidden?: number
  block?: number
  chg?: number
  adds?: number
  dels?: number
}

/** 手动展开的折叠区（key = 起始行下标） */
const expanded = ref(new Set<number>())
const FOLD_THRESHOLD = 8

const display = computed<DispItem[]>(() => {
  const r = result.value
  if (!r) return []
  const items: DispItem[] = []
  const rows = r.rows
  const only = onlyDiff.value
  const folding = foldSame.value && !only
  let i = 0
  let openBlock = -1
  while (i < rows.length) {
    const row = rows[i]
    if (only && !effDiffRow(row)) {
      i += 1
      continue
    }
    // 折叠相同区：连续 same 超阈值 → 前 3 行 + 胶囊 + 后 3 行（循环自然输出尾部）
    if (folding && row.op === 'same') {
      let j = i
      while (j < rows.length && rows[j].op === 'same') j += 1
      const run = j - i
      if (run > FOLD_THRESHOLD && !expanded.value.has(i)) {
        for (let k = i; k < i + 3; k += 1) items.push({ kind: 'row', row: rows[k], ri: k })
        items.push({ kind: 'fold', ri: i, hidden: run - 6 })
        i = j - 3
        continue
      }
    }
    // 变更块头：进入新块时插一行块头
    if (effDiffRow(row) && row.block !== null && row.block !== openBlock) {
      openBlock = row.block
      let chg = 0
      let adds = 0
      let dels = 0
      rows.forEach((x) => {
        if (x.block !== row.block) return
        if (x.op === 'changed' || x.op === 'minor') chg += 1
        else if (x.op === 'only-right') adds += 1
        else if (x.op === 'only-left') dels += 1
      })
      items.push({ kind: 'head', block: row.block, chg, adds, dels })
    }
    items.push({ kind: 'row', row, ri: i })
    i += 1
  }
  // 渲染护栏
  return items.length > 9000 ? items.slice(0, 9000) : items
})
const displayCapped = computed(() => {
  const r = result.value
  if (!r) return false
  return r.rows.length > 9000 && display.value.length >= 9000
})

function expandFold(ri: number): void {
  const next = new Set(expanded.value)
  next.add(ri)
  expanded.value = next
}

// ---------- 复制到对侧（BC 核心操作，本地重算） ----------
function canCopyTo(row: AlignRow, dir: 'l' | 'r'): boolean {
  if (!effDiffRow(row)) return false
  if (dir === 'r') return !!row.left
  return !!row.right
}

/** 插入行落点：块内其后第一条有对侧行的行号前；无则文件末尾 */
function insertIdx(rows: AlignRow[], from: number, side: 'left' | 'right', arrLen: number): number {
  for (let i = from + 1; i < rows.length; i += 1) {
    const cell = side === 'left' ? rows[i].left : rows[i].right
    if (cell) return cell.no - 1
  }
  return arrLen
}

function rowCopy(ri: number, dir: 'l' | 'r'): void {
  const r = result.value
  if (!r) return
  const row = r.rows[ri]
  if (!row || !canCopyTo(row, dir)) return
  const L = sideLines(left.value, leftEol)
  const R = sideLines(right.value, rightEol)
  if (dir === 'r') {
    const text = textOf(row, 'left')
    if (row.right) R[row.right.no - 1] = text
    else R.splice(insertIdx(r.rows, ri, 'right', engineLen(R)), 0, text)
    right.value = R.join(rightEol)
  } else {
    const text = textOf(row, 'right')
    if (row.left) L[row.left.no - 1] = text
    else L.splice(insertIdx(r.rows, ri, 'left', engineLen(L)), 0, text)
    left.value = L.join(leftEol)
  }
  afterCopy()
}

/** 整块复制：替换行直接写；插入行先按原行号收集位置，再倒序 splice */
function blockCopy(block: number, dir: 'l' | 'r'): void {
  const r = result.value
  if (!r) return
  const L = sideLines(left.value, leftEol)
  const R = sideLines(right.value, rightEol)
  const inserts: { at: number; text: string }[] = []
  r.rows.forEach((row, i) => {
    if (row.block !== block) return
    if (!canCopyTo(row, dir)) return
    if (dir === 'r') {
      const text = textOf(row, 'left')
      if (row.right) R[row.right.no - 1] = text
      else inserts.push({ at: insertIdx(r.rows, i, 'right', engineLen(R)), text })
    } else {
      const text = textOf(row, 'right')
      if (row.left) L[row.left.no - 1] = text
      else inserts.push({ at: insertIdx(r.rows, i, 'left', engineLen(L)), text })
    }
  })
  // 倒序 splice 保证多条插入位置不失效
  inserts.sort((a, b) => b.at - a.at)
  const arr = dir === 'r' ? R : L
  for (const ins of inserts) arr.splice(ins.at, 0, ins.text)
  if (dir === 'r') right.value = R.join(rightEol)
  else left.value = L.join(leftEol)
  afterCopy()
}

/** 复制后本地重算 */
function afterCopy(): void {
  runDiff()
  dirty.value = true
}

// ---------- 对比（引擎本地跑） ----------
const curOpts = computed(() => ({ ignoreSpace: ignoreSpace.value, ignoreCase: ignoreCase.value }))

function runDiff(): void {
  result.value = textDiff(left.value, right.value, curOpts.value)
  expanded.value = new Set()
  if (cur.value >= liveBlocks.value.length) cur.value = Math.max(0, liveBlocks.value.length - 1)
}

async function run(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    await nextTick()
    runDiff()
    cur.value = 0
    showEditors.value = false
  } finally {
    busy.value = false
  }
}

// 忽略开关变化时即时重算（纯本地，零成本）
watch([ignoreSpace, ignoreCase], () => {
  if (result.value) runDiff()
})

// ---------- 导航 ----------
const cur = ref(0)
const flashRi = ref(-1)
const sbsBox = ref<HTMLElement | null>(null)

function jumpToBlock(block: number): void {
  const lb = liveBlocks.value
  const k = lb.indexOf(block)
  if (k >= 0) cur.value = k
  const box = sbsBox.value
  const item = display.value.find((x) => x.kind === 'row' && x.row && x.row.block === block && effDiffRow(x.row))
  if (!box || !item || item.kind !== 'row') return
  void nextTick(() => {
    const el = box.querySelector(`[data-ri="${item.ri}"]`)
    if (el) {
      el.scrollIntoView({ block: 'center' })
      flashRi.value = item.ri ?? -1
      setTimeout(() => {
        if (flashRi.value === item.ri) flashRi.value = -1
      }, 1000)
    }
  })
}

function navBlock(delta: number): void {
  const lb = liveBlocks.value
  if (!lb.length) return
  cur.value = (cur.value + delta + lb.length) % lb.length
  jumpToBlock(lb[cur.value])
}

// ---------- 概览条 ----------
interface MapMark {
  kind: 'add' | 'del' | 'mixed' | 'minor'
  top: string
  height: string
  block: number
}
const blockMarks = computed<MapMark[]>(() => {
  const r = result.value
  if (!r || !r.rows.length) return []
  const total = r.rows.length
  const per = new Map<number, { first: number; last: number; kinds: Set<string> }>()
  r.rows.forEach((row, i) => {
    if (row.block === null || !effDiffRow(row)) return
    let e = per.get(row.block)
    if (!e) {
      e = { first: i, last: i, kinds: new Set() }
      per.set(row.block, e)
    }
    e.last = i
    e.kinds.add(row.op)
  })
  return [...per.entries()].map(([block, e]) => {
    const kinds = e.kinds
    let kind: MapMark['kind']
    if (kinds.has('changed') || (kinds.has('only-left') && kinds.has('only-right'))) kind = 'mixed'
    else if (kinds.has('minor')) kind = 'minor'
    else if (kinds.has('only-right')) kind = 'add'
    else kind = 'del'
    return {
      kind,
      block,
      top: `${(e.first / total) * 100}%`,
      height: `${Math.max(0.8, ((e.last - e.first + 1) / total) * 100)}%`
    }
  })
})

/** 视窗框（当前滚动位置在概览条上的映射） */
const vpStyle = ref({ top: '0%', height: '100%' })
function onBoxScroll(): void {
  const box = sbsBox.value
  if (!box) return
  const sh = box.scrollHeight
  if (sh <= 0) return
  vpStyle.value = {
    top: `${(box.scrollTop / sh) * 100}%`,
    height: `${(box.clientHeight / sh) * 100}%`
  }
}

// ---------- 内联视图（VSCode 式单栏 +/-） ----------
interface InlineItem {
  no: number
  pm: string
  segs: InlineSeg[]
  cls: string
  minor: boolean
}
const inlineItems = computed<InlineItem[]>(() => {
  const r = result.value
  if (!r) return []
  const out: InlineItem[] = []
  r.rows.forEach((row) => {
    if (onlyDiff.value && !effDiffRow(row)) return
    if (row.op === 'same') {
      out.push({ no: row.left?.no ?? 0, pm: '', segs: row.left?.segs ?? [], cls: '', minor: false })
    } else if (row.op === 'changed' || row.op === 'minor') {
      const minor = row.op === 'minor'
      out.push({ no: row.left?.no ?? 0, pm: '−', segs: row.left?.segs ?? [], cls: 'il-del', minor })
      out.push({ no: row.right?.no ?? 0, pm: '+', segs: row.right?.segs ?? [], cls: 'il-add', minor })
    } else if (row.op === 'only-left') {
      out.push({ no: row.left?.no ?? 0, pm: '−', segs: row.left?.segs ?? [], cls: 'il-del', minor: false })
    } else if (row.op === 'only-right') {
      out.push({ no: row.right?.no ?? 0, pm: '+', segs: row.right?.segs ?? [], cls: 'il-add', minor: false })
    }
  })
  return out.length > 9000 ? out.slice(0, 9000) : out
})

// ---------- 打开文件 / 路径输入 ----------
async function openFromPath(side: 'left' | 'right', path: string): Promise<boolean> {
  const res = await readFile({ path, encoding: enc.value })
  if (!res.ok) {
    ElMessage.warning(`读取失败：${res.error}`)
    return false
  }
  if (res.kind === 'binary') {
    binaryHint.value = `「${path}」为二进制文件，请用「十六进制」模式查看`
    return false
  }
  binaryHint.value = ''
  tooLargeHint.value = res.tooLarge ? '文件超过 8MB 文本上限，已截断显示' : ''
  const text = res.text ?? ''
  if (side === 'left') {
    leftPath.value = path
    left.value = text
    leftEnc.value = res.encoding
    leftEol = text.includes('\r\n') ? '\r\n' : '\n'
  } else {
    rightPath.value = path
    right.value = text
    rightEnc.value = res.encoding
    rightEol = text.includes('\r\n') ? '\r\n' : '\n'
  }
  return true
}

async function openFile(side: 'left' | 'right'): Promise<void> {
  const picked = await pickFile(side === 'left' ? '选择左侧文本文件' : '选择右侧文本文件')
  if (!picked.ok) return
  const ok = await openFromPath(side, picked.path!)
  if (ok) result.value = null
}

async function onPathInput(side: 'left' | 'right'): Promise<void> {
  const p = side === 'left' ? leftPath.value.trim() : rightPath.value.trim()
  if (!p) return
  const ok = await openFromPath(side, p)
  if (ok) result.value = null
}

/** 交换左右（文本/路径/编码一起换，重算） */
function swapSides(): void {
  ;[left.value, right.value] = [right.value, left.value]
  ;[leftPath.value, rightPath.value] = [rightPath.value, leftPath.value]
  ;[leftEnc.value, rightEnc.value] = [rightEnc.value, leftEnc.value]
  ;[leftEol, rightEol] = [rightEol, leftEol]
  if (result.value) runDiff()
}

// ---------- 保存（复制只改内存，显式保存才写盘） ----------
async function save(): Promise<void> {
  if (!dirty.value) {
    ElMessage.info('没有需要保存的修改（复制到对侧后才会产生改动）')
    return
  }
  const jobs: Promise<{ ok: boolean; error?: string }>[] = []
  if (leftPath.value) jobs.push(writeFile({ path: leftPath.value, content: left.value, encoding: leftEnc.value }))
  if (rightPath.value) jobs.push(writeFile({ path: rightPath.value, content: right.value, encoding: rightEnc.value }))
  if (!jobs.length) {
    ElMessage.warning('左右两侧均未关联文件路径，无法保存（请先打开文件）')
    return
  }
  const res = await Promise.all(jobs)
  const failed = res.filter((x) => !x.ok)
  if (failed.length) {
    ElMessage.error(`保存失败：${failed[0].error ?? '未知错误'}`)
    return
  }
  dirty.value = false
  ElMessage.success('已保存到文件')
}

// ---------- 拖放文件（拖 1 个 → 落点侧；拖 2 个 → 首给落点侧、次给对侧） ----------
const { overLeft, overRight, onDragOver: onDropOver, onDragLeave, onDrop: onDropFiles } = useDropSides(
  async (side, paths) => {
    const first = paths[0]
    const second = paths.length > 1 ? paths[1] : null
    const ok1 = await openFromPath(side, first)
    let ok2 = true
    if (second) ok2 = await openFromPath(side === 'left' ? 'right' : 'left', second)
    if (ok1 && ok2) await run()
  }
)

// ---------- pending 消费（文件夹视图跳转进来） ----------
let lastSeq = -1
async function consumePending(): Promise<void> {
  const p = props.pending
  if (!p || p.seq === lastSeq || p.hex) return
  lastSeq = p.seq
  const [okL, okR] = await Promise.all([openFromPath('left', p.left), openFromPath('right', p.right)])
  if (okL && okR) await run()
}
watch(
  () => props.pending,
  () => void consumePending()
)
onMounted(() => void consumePending())
</script>

<template>
  <div>
    <div class="opts-row">
      <el-select v-model="enc" size="small" style="width: 190px">
        <el-option v-for="e in ENCODINGS" :key="e.value" :value="e.value" :label="e.label" />
      </el-select>
      <el-button type="primary" size="small" :loading="busy" @click="run">对比</el-button>
      <el-button size="small" text @click="showEditors = !showEditors">
        {{ showEditors ? '收起编辑区' : '编辑原文' }}
      </el-button>
      <el-checkbox v-model="ignoreSpace" size="small">忽略空白</el-checkbox>
      <el-checkbox v-model="ignoreCase" size="small">忽略大小写</el-checkbox>
      <template v-if="result">
        <el-divider direction="vertical" />
        <el-button size="small" text :icon="ArrowUp" :disabled="!liveBlocks.length" @click="navBlock(-1)" />
        <el-button size="small" text :icon="ArrowDown" :disabled="!liveBlocks.length" @click="navBlock(1)" />
        <span class="nav-count">
          {{ liveBlocks.length === 0 ? '无差异' : `第 ${cur + 1} / ${liveBlocks.length} 处` }}
        </span>
        <el-checkbox v-model="foldSame" size="small">折叠相同区</el-checkbox>
        <el-checkbox v-model="ignoreMinor" size="small">忽略次要差异</el-checkbox>
        <el-checkbox v-model="onlyDiff" size="small">只看差异</el-checkbox>
        <el-checkbox v-model="inlineView" size="small">内联视图</el-checkbox>
        <el-button size="small" text :type="dirty ? 'primary' : 'default'" :disabled="!dirty" @click="save">
          保存{{ dirty ? '*' : '' }}
        </el-button>
      </template>
    </div>

    <div class="path-row">
      <el-input
        v-model="leftPath"
        size="small"
        class="path-input"
        :class="{ 'drop-over': overLeft }"
        placeholder="左侧文件路径（可输入、浏览或拖入文件）"
        clearable
        @change="onPathInput('left')"
        @dragover="onDropOver('left', $event)"
        @dragleave="onDragLeave('left')"
        @drop="onDropFiles('left', $event)"
      >
        <template #append>
          <el-button :icon="FolderOpened" @click="openFile('left')" />
        </template>
      </el-input>
      <el-button size="small" text title="交换左右" @click="swapSides">⇄</el-button>
      <el-input
        v-model="rightPath"
        size="small"
        class="path-input"
        :class="{ 'drop-over': overRight }"
        placeholder="右侧文件路径（可输入、浏览或拖入文件）"
        clearable
        @change="onPathInput('right')"
        @dragover="onDropOver('right', $event)"
        @dragleave="onDragLeave('right')"
        @drop="onDropFiles('right', $event)"
      >
        <template #append>
          <el-button :icon="FolderOpened" @click="openFile('right')" />
        </template>
      </el-input>
    </div>

    <div v-if="showEditors" class="editors">
      <el-input v-model="left" type="textarea" :rows="8" class="mono" placeholder="原文（左侧），或点「浏览」打开文件" />
      <el-input v-model="right" type="textarea" :rows="8" class="mono" placeholder="新文（右侧），或点「浏览」打开文件" />
    </div>

    <div v-if="binaryHint" class="hint warn">{{ binaryHint }}</div>
    <div v-if="tooLargeHint" class="hint warn">{{ tooLargeHint }}</div>
    <div v-if="displayCapped" class="hint warn">行数过多已截断——建议勾选「只看差异」查看全部差异</div>

    <!-- 双栏对齐视图 -->
    <div v-if="result && !inlineView" class="sbs-wrap">
      <div ref="sbsBox" class="sbs-box" @scroll.passive="onBoxScroll">
        <template v-for="item in display" :key="item.kind === 'row' ? `r${item.ri}` : item.kind === 'fold' ? `f${item.ri}` : `h${item.block}`">
          <!-- 变更块头：整块复制 -->
          <div v-if="item.kind === 'head'" class="sbs-row head-row">
            <span class="h-title">
              第 {{ (item.block ?? 0) + 1 }} 处<template v-if="item.chg"> · {{ item.chg }} 行变更</template><template v-if="item.dels"> · −{{ item.dels }}</template><template v-if="item.adds"> · +{{ item.adds }}</template>
            </span>
            <span class="h-ops">
              <button class="h-btn" @click="blockCopy(item.block ?? 0, 'r')">整块 → 右</button>
              <button class="h-btn" @click="blockCopy(item.block ?? 0, 'l')">整块 → 左</button>
            </span>
          </div>
          <!-- 折叠相同区 -->
          <div v-else-if="item.kind === 'fold'" class="sbs-row fold-row">
            <span class="fold-pill" @click="expandFold(item.ri ?? 0)">⋯ {{ item.hidden }} 行相同，点击展开 ⋯</span>
          </div>
          <!-- 对齐行 -->
          <div
            v-else
            class="sbs-row"
            :class="[`op-${item.row?.op}`, ignoreMinor && item.row?.op === 'minor' ? 'as-same' : '', flashRi === item.ri ? 'nav-hit' : '']"
            :data-ri="item.ri"
          >
            <span class="c-no">{{ item.row?.left?.no ?? '' }}</span>
            <span class="c-txt c-l">
              <span v-for="(s, j) in item.row?.left?.segs" :key="j" :class="{ 'seg-ch': s.changed && item.row?.op !== 'minor', 'seg-un': s.changed && item.row?.op === 'minor' }">{{ s.text }}</span>
            </span>
            <span class="c-gap">
              <span v-if="item.row && canCopyTo(item.row, 'l')" class="cp to-l" title="复制到左侧" @click="rowCopy(item.ri ?? 0, 'l')">◀</span>
              <span v-if="item.row && canCopyTo(item.row, 'r')" class="cp to-r" title="复制到右侧" @click="rowCopy(item.ri ?? 0, 'r')">▶</span>
            </span>
            <span class="c-no c-right">{{ item.row?.right?.no ?? '' }}</span>
            <span class="c-txt c-r">
              <span v-for="(s, j) in item.row?.right?.segs" :key="j" :class="{ 'seg-ch': s.changed && item.row?.op !== 'minor', 'seg-un': s.changed && item.row?.op === 'minor' }">{{ s.text }}</span>
            </span>
          </div>
        </template>
        <div v-if="display.length === 0" class="hint" style="padding: 8px">
          {{ onlyDiff ? '没有差异行' : '（空）' }}
        </div>
      </div>
      <!-- 概览条 -->
      <div v-if="blockMarks.length" class="sbs-map">
        <div
          v-for="m in blockMarks"
          :key="m.block"
          class="map-mark"
          :class="`mk-${m.kind}`"
          :style="{ top: m.top, height: m.height }"
          :title="`跳到第 ${m.block + 1} 处`"
          @click="jumpToBlock(m.block)"
        />
        <div class="map-vp" :style="vpStyle" />
      </div>
    </div>

    <!-- 内联视图（VSCode 式单栏 +/-） -->
    <div v-if="result && inlineView" class="sbs-wrap">
      <div class="sbs-box">
        <div v-for="(it, i) in inlineItems" :key="i" class="irow" :class="it.cls">
          <span class="c-no">{{ it.no }}</span>
          <span class="i-pm">{{ it.pm }}</span>
          <span class="c-txt">
            <span v-for="(s, j) in it.segs" :key="j" :class="{ 'seg-ch': s.changed && !it.minor, 'seg-un': s.changed && it.minor }">{{ s.text }}</span>
          </span>
        </div>
        <div v-if="inlineItems.length === 0" class="hint" style="padding: 8px">没有差异行</div>
      </div>
    </div>

    <!-- 统计 -->
    <div v-if="result" class="stats-row">
      <el-tag v-if="liveBlocks.length === 0" type="success" size="small">✔ 两侧已同步</el-tag>
      <template v-else>
        <el-tag type="danger" size="small">共 {{ result.blocks }} 处</el-tag>
        <el-tag type="danger" size="small">删 {{ result.del }}</el-tag>
        <el-tag type="success" size="small">增 {{ result.add }}</el-tag>
        <el-tag v-if="result.minor" size="small" class="tag-minor">次要 {{ result.minor }}</el-tag>
        <el-tag type="info" size="small" effect="plain">相同 {{ result.same }}</el-tag>
        <el-tag type="primary" size="small">剩余 {{ liveBlocks.length }} 处未同步</el-tag>
      </template>
    </div>
  </div>
</template>

<style scoped>
.opts-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.path-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  margin-bottom: 8px;
}
.path-input {
  flex: 1;
  min-width: 120px;
  font-family: var(--font-mono);
  font-size: 12px;
}
.mono {
  font-family: var(--font-mono);
}
.editors {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 8px;
}
.hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.warn {
  color: var(--el-color-warning);
  margin-top: 4px;
}
.nav-count {
  font-size: 12px;
  color: var(--el-color-primary);
  min-width: 84px;
}
.stats-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  flex-wrap: wrap;
}
.tag-minor {
  background: rgba(91, 138, 194, 0.14);
  color: #8cadd4;
  border-color: rgba(91, 138, 194, 0.3);
}

/* ===== 双栏对齐视图 ===== */
.sbs-wrap {
  position: relative;
  margin-top: 8px;
}
.sbs-box {
  background: #101418;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px 6px 0 0;
  max-height: 60vh;
  overflow: auto;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  color: #cfd8dc;
}
.sbs-row {
  display: grid;
  grid-template-columns: 44px 1fr 26px 44px 1fr;
  align-items: start;
  white-space: pre-wrap;
  word-break: break-all;
  min-height: 1.6em;
}
.c-no {
  color: #546e7a;
  text-align: right;
  padding: 0 6px;
  user-select: none;
  flex: 0 0 44px;
}
.c-no.c-right,
.c-txt.c-r {
  border-left: 1px solid var(--el-border-color-lighter);
}
.c-txt {
  padding: 0 6px;
}

/* Beyond Compare 惯例：改动行两侧淡红底 + 行内差异深红；插入/删除行（孤儿行）存在侧绿底 */
.op-changed .c-l,
.op-changed .c-r {
  background: var(--dk-change-row);
}
.op-changed .seg-ch {
  background: var(--dk-change-seg);
  border-radius: 2px;
}
.op-only-left .c-l,
.op-only-left .c-no:first-child {
  background: var(--dk-orph-row);
}
.op-only-right .c-r,
.op-only-right .c-no.c-right {
  background: var(--dk-orph-row);
}
/* 次要差异：蓝底 + 深蓝行内段；开「忽略次要差异」后渲染为普通行 */
.op-minor .c-l,
.op-minor .c-r {
  background: rgba(91, 138, 194, 0.12);
}
.op-minor .seg-un {
  background: rgba(91, 138, 194, 0.3);
  border-radius: 2px;
}
.op-minor.as-same .c-l,
.op-minor.as-same .c-r {
  background: transparent;
}
.op-minor.as-same .seg-un {
  background: transparent;
}

/* 中缝复制按钮：悬停行出现 */
.c-gap {
  position: relative;
  border-left: 1px solid #232b34;
  border-right: 1px solid #232b34;
}
.cp {
  position: absolute;
  top: 1px;
  width: 17px;
  height: 17px;
  line-height: 15px;
  text-align: center;
  background: var(--el-color-primary);
  color: #fff;
  border-radius: 4px;
  font-size: 10px;
  cursor: pointer;
  display: none;
  z-index: 3;
}
.cp:hover {
  background: var(--el-color-primary-light-3);
}
.cp.to-r {
  right: 3px;
}
.cp.to-l {
  left: 3px;
}
.sbs-row:hover .cp {
  display: block;
}

/* 变更块头 */
.head-row {
  background: var(--el-fill-color-lighter);
  border-top: 1px solid var(--el-border-color-lighter);
  border-bottom: 1px solid var(--el-border-color-lighter);
  font-family: var(--el-font-family, sans-serif);
  font-size: 11.5px;
  color: var(--el-text-color-secondary);
  align-items: center;
  min-height: 24px;
  user-select: none;
}
.h-title {
  grid-column: 1 / 3;
  padding-left: 8px;
  color: var(--el-color-primary);
}
.h-ops {
  grid-column: 4 / 6;
  display: flex;
  gap: 8px;
  padding-left: 8px;
}
.h-btn {
  background: none;
  border: 1px solid var(--el-border-color);
  color: var(--el-text-color-secondary);
  font-size: 11px;
  border-radius: 4px;
  padding: 1px 8px;
  cursor: pointer;
}
.h-btn:hover {
  border-color: var(--el-color-primary);
  color: #fff;
}

/* 折叠相同区 */
.fold-row {
  display: block;
  text-align: center;
  padding: 2px 0;
}
.fold-pill {
  display: inline-block;
  padding: 1px 14px;
  font-size: 11.5px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  cursor: pointer;
  user-select: none;
  font-family: var(--el-font-family, sans-serif);
}
.fold-pill:hover {
  color: var(--el-color-primary);
  border-color: var(--el-color-primary);
}

/* 导航定位闪烁 */
@keyframes navflash {
  0% {
    box-shadow: inset 0 0 0 2px var(--el-color-primary);
  }
  100% {
    box-shadow: inset 0 0 0 0 transparent;
  }
}
.nav-hit {
  animation: navflash 1s ease;
}

/* ===== 概览条 ===== */
.sbs-map {
  position: absolute;
  top: 1px;
  right: 1px;
  bottom: 1px;
  width: 14px;
  border-left: 1px solid var(--el-border-color-lighter);
  border-radius: 0 6px 0 0;
  background: rgba(255, 255, 255, 0.02);
}
.map-mark {
  position: absolute;
  left: 2px;
  width: 9px;
  min-height: 2px;
  border-radius: 2px;
  cursor: pointer;
  opacity: 0.75;
}
.map-mark:hover {
  opacity: 1;
}
.mk-del {
  background: var(--dk-st-differ);
}
.mk-add {
  background: #81c784;
}
.mk-mixed {
  background: var(--dk-st-only-right);
}
.mk-minor {
  background: #7ba3cc;
}
.map-vp {
  position: absolute;
  left: 0;
  right: 0;
  background: rgba(255, 255, 255, 0.09);
  border: 1px solid rgba(255, 255, 255, 0.15);
  pointer-events: none;
}

/* ===== 内联视图 ===== */
.irow {
  display: grid;
  grid-template-columns: 44px 18px 1fr;
  white-space: pre-wrap;
  word-break: break-all;
  min-height: 1.6em;
}
.i-pm {
  text-align: center;
  color: var(--el-text-color-secondary);
  user-select: none;
}
.il-del .c-txt {
  background: var(--dk-change-row);
}
.il-add .c-txt {
  background: var(--dk-orph-row);
}
.irow .seg-ch {
  background: var(--dk-change-seg);
  border-radius: 2px;
}
.irow .seg-un {
  background: rgba(91, 138, 194, 0.3);
  border-radius: 2px;
}
</style>
