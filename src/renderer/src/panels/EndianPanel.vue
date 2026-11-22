<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { CopyDocument } from '@element-plus/icons-vue'
import { encodeInteger } from '../../../shared/converter-workbench'

/** 解析任意 HEX 字节序列（宽容分隔） */
function parseBytes(input: string): number[] {
  const compact = input.replace(/0x/gi, ' ').replace(/[^0-9a-fA-F]/g, '')
  if (compact.length % 2 !== 0) return []
  const out: number[] = []
  for (let i = 0; i < compact.length; i += 2) out.push(parseInt(compact.slice(i, i + 2), 16))
  return out
}

function hex(n: bigint | number, width: number): string {
  return n.toString(16).padStart(width, '0').toUpperCase()
}

const bytesInput = ref('01 02 03 04 05 06 07 08')
const bytes = computed(() => parseBytes(bytesInput.value))
const widthFilter = ref<'all' | 'u16' | 'u32' | 'u64'>('all')
const showDetails = ref(true)
const activeBytes = ref<{ offset: number; width: Width } | null>(null)
const examples = [
  { label: '01..08 递增序列', data: '01 02 03 04 05 06 07 08' },
  { label: 'Float32 示例', data: '33 33 53 40 00 00 F0 41' },
  { label: '32 位寄存器', data: '78 56 34 12 EF CD AB 89' }
]

/** 按宽度展示字节序解释（字节不足补齐显示 -- ） */
type Width = 1 | 2 | 4 | 8

interface Row {
  width: Width
  count: number
  leHex: string
  leDec: string
  beHex: string
  beDec: string
  leDetail: string
  beDetail: string
}

function rowsFor(width: Width): Row[] {
  const rows: Row[] = []
  const count = Math.floor(bytes.value.length / width)
  for (let i = 0; i < Math.max(count, 1); i += 1) {
    const chunk = bytes.value.slice(i * width, (i + 1) * width)
    const full = chunk.length === width
    let le = 0n
    let be = 0n
    chunk.forEach((b, j) => {
      le |= BigInt(b) << BigInt(8 * j)
      be = (be << BigInt(8)) | BigInt(b)
    })
    const view = full && width === 4 ? new DataView(Uint8Array.from(chunk).buffer) : null
    const detail = (value: bigint, littleEndian: boolean): string => {
      if (!full) return ''
      const signed = BigInt.asIntN(width * 8, value).toString()
      return view ? `有符号 ${signed} · Float32 ${Number(view.getFloat32(0, littleEndian).toPrecision(7))}` : `有符号 ${signed}`
    }
    rows.push({
      width,
      count: i,
      leHex: full ? hex(le, width * 2) : '--',
      leDec: full ? le.toString() : '--',
      beHex: full ? hex(be, width * 2) : '--',
      beDec: full ? be.toString() : '--',
      leDetail: detail(le, true),
      beDetail: detail(be, false)
    })
  }
  return rows
}

const table16 = computed(() => rowsFor(2))
const table32 = computed(() => rowsFor(4))
const table64 = computed(() => rowsFor(8))

/** 数值 -> 字节序列 */
const numInput = ref('305419896') // 0x12345678
const numHex = computed(() => {
  const t = numInput.value.trim()
  if (!t) return null
  let v: bigint | null
  try {
    v = /^0x[0-9a-f]+$/i.test(t) ? BigInt(t) : /^-?\d+$/.test(t) ? BigInt(t) : null
  } catch {
    v = null
  }
  if (v === null) return null
  return ([2, 4, 8] as const).map((width) => ({ width: width * 8, ...encodeInteger(v, width) }))
})

const integerExamples = [
  ['0x12345678', '0x12345678'], ['4660 (0x1234)', '4660'],
  ['-100 (补码)', '-100'], ['64-bit 示例', '0x0102030405060708']
]
/** 字节交换 */
const swapInput = ref('12345678')
const swapResult = computed(() => {
  const t = swapInput.value.replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  if (!t) return null
  const byWidth = (w: number): string | null => {
    if (t.length !== w * 2) return null
    const bytes: string[] = []
    for (let i = 0; i < w; i += 1) bytes.push(t.slice(i * 2, i * 2 + 2))
    return bytes.reverse().join('')
  }
  return {
    raw: t,
    w16: byWidth(2),
    w32: byWidth(4),
    w64: byWidth(8)
  }
})

async function copy(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
  ElMessage.success('已复制')
}
</script>

<template>
  <div class="panel endian-panel converter-page">
    <header class="converter-head">
      <div><h1>大小端转换</h1><p>16 / 32 / 64 位字节序解析、数值编码与翻转</p></div>
      <div class="converter-row">
        <el-button v-for="example in examples" :key="example.label" size="small" @click="bytesInput = example.data">{{ example.label }}</el-button>
      </div>
    </header>
    <div class="panel-section">
      <div class="converter-head">
        <h3>字节序列解析（多宽度 × 大小端）</h3>
        <el-radio-group v-model="widthFilter" size="small" aria-label="解析位宽">
          <el-radio-button value="all">全部位宽</el-radio-button>
          <el-radio-button value="u16">16-bit</el-radio-button>
          <el-radio-button value="u32">32-bit · Float32</el-radio-button>
          <el-radio-button value="u64">64-bit</el-radio-button>
        </el-radio-group>
        <el-checkbox v-model="showDetails">有符号 / 浮点</el-checkbox>
      </div>
      <el-input
        v-model="bytesInput"
        size="small"
        aria-label="HEX 字节序列"
        class="mono"
        placeholder="输入 HEX 字节，如 01 02 03 04（空格/逗号/连续写法均可）"
        clearable
      />
      <div class="converter-row">
        <el-button size="small" :disabled="!bytes.length" @click="bytesInput = bytes.map((byte) => hex(byte, 2)).join(' ')">规范空格</el-button>
        <el-button size="small" :disabled="!bytes.length" @click="bytesInput = [...bytes].reverse().map((byte) => hex(byte, 2)).join(' ')">整串倒序</el-button>
        <el-button size="small" text @click="bytesInput = ''">清空</el-button>
      </div>
      <el-alert
        v-if="bytesInput && bytes.length === 0"
        type="error"
        :closable="false"
        title="HEX 格式非法（长度须为偶数）"
        style="margin-top: 8px"
      />
      <div v-if="bytes.length" class="byte-lane" aria-label="HEX 字节偏移">
        <span
          v-for="(byte, offset) in bytes.slice(0, 64)" :key="offset"
          :class="{ highlighted: activeBytes && offset >= activeBytes.offset && offset < activeBytes.offset + activeBytes.width }"
        ><small>{{ offset }}</small><code>{{ hex(byte, 2) }}</code></span>
        <small v-if="bytes.length > 64">前 64 字节</small>
      </div>
      <template v-for="(rows, name) in { u16: table16, u32: table32, u64: table64 }" :key="name">
        <div v-if="widthFilter === 'all' || widthFilter === name">
          <h4 class="tbl-title">{{ name.toUpperCase() }} 解释（{{ rows.length }} 个）</h4>
          <div class="byte-table">
            <table :aria-label="name.toUpperCase() + ' 字节序解释'">
              <thead>
                <tr>
                  <th scope="col">偏移</th>
                  <th scope="col">小端 HEX (LE)</th>
                  <th scope="col">小端十进制</th>
                  <th scope="col">大端 HEX (BE)</th>
                  <th scope="col">大端十进制</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in rows"
                  :key="row.count"
                  @mouseenter="activeBytes = { offset: row.count * row.width, width: row.width }"
                  @mouseleave="activeBytes = null"
                >
                  <td class="mono">{{ row.count * row.width }}</td>
                  <td>
                    <span class="mono">{{ row.leHex }}</span>
                    <el-button v-if="row.leHex !== '--'" size="small" text :icon="CopyDocument" aria-label="复制小端 HEX" @click="copy(row.leHex)" />
                  </td>
                  <td>
                    <span class="mono">{{ row.leDec }}</span>
                    <div v-if="showDetails && row.leDetail" class="hint">{{ row.leDetail }}</div>
                  </td>
                  <td>
                    <span class="mono">{{ row.beHex }}</span>
                    <el-button v-if="row.beHex !== '--'" size="small" text :icon="CopyDocument" aria-label="复制大端 HEX" @click="copy(row.beHex)" />
                  </td>
                  <td>
                    <span class="mono">{{ row.beDec }}</span>
                    <div v-if="showDetails && row.beDetail" class="hint">{{ row.beDetail }}</div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>
    </div>

    <div class="converter-split equal">
    <div class="panel-section">
      <h3>数值 → 字节序列</h3>
      <div class="row">
        <el-input
          v-model="numInput"
          size="small"
          class="mono fixed-input"
          aria-label="待编码数值" placeholder="十进制（支持负数补码）或 0x 十六进制"
          clearable
        />
      </div>
      <div class="converter-row">
        <el-button v-for="[label, value] in integerExamples" :key="label" size="small" @click="numInput = value">{{ label }}</el-button>
      </div>
      <el-alert v-if="numInput.trim() && !numHex" type="error" :closable="false" title="请输入有效的整数" />
      <div v-if="numHex" class="encoded-result">
        <template v-for="result in numHex" :key="result.width">
          <button v-for="order in (['le', 'be'] as const)" :key="order" type="button" @click="copy(result[order])">
            <span>u{{ result.width }} {{ order.toUpperCase() }} 字节 <small v-if="result.truncated">· 低 {{ result.width }} 位</small></span>
            <code>{{ result[order] }}</code><el-icon><CopyDocument /></el-icon>
          </button>
        </template>
      </div>
    </div>

    <div class="panel-section">
      <h3>字节交换（16/32/64 位）</h3>
      <div class="row">
        <el-input
          v-model="swapInput"
          size="small"
          class="mono fixed-input"
          placeholder="HEX 值，如 12345678"
          clearable
        />
      </div>
      <div class="converter-row">
        <el-button size="small" :disabled="!parseBytes(swapInput).length" @click="bytesInput = parseBytes(swapInput).map((byte) => hex(byte, 2)).join(' ')">送入上方解析</el-button>
        <el-button size="small" text @click="swapInput = ''">清空</el-button>
      </div>
      <el-descriptions v-if="swapResult" :column="2" border size="small" style="margin-top: 10px">
        <el-descriptions-item :label="`u16 交换`">
          <template v-if="swapResult.w16">
            <span class="mono">{{ swapResult.w16 }}</span>
            <el-button size="small" text :icon="CopyDocument" @click="copy(swapResult.w16)" />
          </template>
          <span v-else class="hint">需 4 个 hex 位</span>
        </el-descriptions-item>
        <el-descriptions-item label="u32 交换">
          <template v-if="swapResult.w32">
            <span class="mono">{{ swapResult.w32 }}</span>
            <el-button size="small" text :icon="CopyDocument" @click="copy(swapResult.w32)" />
          </template>
          <span v-else class="hint">需 8 个 hex 位</span>
        </el-descriptions-item>
        <el-descriptions-item label="u64 交换">
          <template v-if="swapResult.w64">
            <span class="mono">{{ swapResult.w64 }}</span>
            <el-button size="small" text :icon="CopyDocument" @click="copy(swapResult.w64)" />
          </template>
          <span v-else class="hint">需 16 个 hex 位</span>
        </el-descriptions-item>
      </el-descriptions>
    </div>
    </div>
  </div>
</template>

<style scoped>
.encoded-result { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:8px; margin-top:12px; }
.encoded-result button { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:4px; padding:8px; border:1px solid var(--el-border-color-lighter); border-radius:6px; background:var(--el-bg-color-page); color:inherit; cursor:pointer; text-align:start; }
.encoded-result button:hover { border-color:var(--el-color-primary); }
.encoded-result span { grid-column:1/-1; font-size:12px; color:var(--el-text-color-secondary); }
.encoded-result code { overflow-wrap:anywhere; font-size:12px; }
.endian-panel {
  overflow: auto;
}

.mono {
  font-family: var(--font-mono);
}

.fixed-input {
  width: min(280px, 100%);
}

.tbl-title {
  font-size: 13px;
  font-weight: 600;
  margin: 12px 0 8px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.byte-table { min-width:0; overflow:auto; border:1px solid var(--el-border-color-lighter); border-radius:8px; }
.byte-table table { width:100%; border-collapse:collapse; font-size:12px; }
.byte-table :is(th, td) { padding:8px 10px; text-align:start; white-space:nowrap; border-bottom:1px solid var(--el-border-color-lighter); }
.byte-table th { background:var(--el-bg-color-page); color:var(--el-text-color-secondary); font-weight:600; }
.byte-table tbody tr:last-child td { border-bottom:0; }
.byte-table tbody tr:hover { background:var(--el-fill-color-light); }
.byte-table .el-button { min-height:22px; margin-inline-start:4px; padding:2px 4px; vertical-align:middle; }
.byte-lane { display:flex; align-items:center; flex-wrap:wrap; gap:4px; margin:12px 0; padding:8px; background:var(--el-bg-color-page); border:1px solid var(--el-border-color-lighter); border-radius:8px; }
.byte-lane > span { display:grid; justify-items:center; min-width:32px; padding:4px; border-radius:6px; background:var(--el-fill-color-light); }
.byte-lane small { font-size:11px; color:var(--el-text-color-secondary); }
.byte-lane > .highlighted { background:var(--el-color-primary-light-8); color:var(--el-color-primary); }
</style>
