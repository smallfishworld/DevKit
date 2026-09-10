<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { CopyDocument } from '@element-plus/icons-vue'

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

/** 按宽度展示字节序解释（字节不足补齐显示 -- ） */
type Width = 1 | 2 | 4 | 8

interface Row {
  width: Width
  count: number
  leHex: string
  leDec: string
  beHex: string
  beDec: string
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
    rows.push({
      width,
      count: i,
      leHex: full ? hex(le, width * 2) : '--',
      leDec: full ? le.toString() : '--',
      beHex: full ? hex(be, width * 2) : '--',
      beDec: full ? be.toString() : '--'
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
  const abs = v < 0n ? -v : v
  return {
    v,
    le32: bytesToHexLe(abs, 4),
    be32: bytesToHexBe(abs, 4),
    le64: bytesToHexLe(abs, 8),
    be64: bytesToHexBe(abs, 8),
    hex: '0x' + abs.toString(16).toUpperCase()
  }
})

function bytesToHexLe(v: bigint, width: number): string {
  const out: string[] = []
  for (let i = 0; i < width; i += 1) out.push(((v >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, '0').toUpperCase())
  return out.join(' ')
}

function bytesToHexBe(v: bigint, width: number): string {
  const out: string[] = []
  for (let i = width - 1; i >= 0; i -= 1) out.push(((v >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, '0').toUpperCase())
  return out.join(' ')
}

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
  <div class="panel endian-panel">
    <div class="panel-section">
      <h3>字节序列解析（多宽度 × 大小端）</h3>
      <el-input
        v-model="bytesInput"
        class="mono"
        placeholder="输入 HEX 字节，如 01 02 03 04（空格/逗号/连续写法均可）"
        clearable
      />
      <el-alert
        v-if="bytesInput && bytes.length === 0"
        type="error"
        :closable="false"
        title="HEX 格式非法（长度须为偶数）"
        style="margin-top: 8px"
      />
      <template v-for="(rows, name) in { u16: table16, u32: table32, u64: table64 }" :key="name">
        <div class="tbl-title">{{ name.toUpperCase() }} 解释（{{ rows.length }} 个）</div>
        <el-table :data="rows" size="small" border style="width: 100%">
          <el-table-column label="#" width="60">
            <template #default="{ row }">{{ row.count }}</template>
          </el-table-column>
          <el-table-column label="小端 HEX (LE)">
            <template #default="{ row }">
              <span class="mono">{{ row.leHex }}</span>
              <el-button v-if="row.leHex !== '--'" size="small" text :icon="CopyDocument" @click="copy(row.leHex)" />
            </template>
          </el-table-column>
          <el-table-column label="小端 十进制">
            <template #default="{ row }">
              <span class="mono">{{ row.leDec }}</span>
            </template>
          </el-table-column>
          <el-table-column label="大端 HEX (BE)">
            <template #default="{ row }">
              <span class="mono">{{ row.beHex }}</span>
              <el-button v-if="row.beHex !== '--'" size="small" text :icon="CopyDocument" @click="copy(row.beHex)" />
            </template>
          </el-table-column>
          <el-table-column label="大端 十进制">
            <template #default="{ row }">
              <span class="mono">{{ row.beDec }}</span>
            </template>
          </el-table-column>
        </el-table>
      </template>
    </div>

    <div class="panel-section">
      <h3>数值 → 字节序列</h3>
      <div class="row">
        <el-input
          v-model="numInput"
          class="mono"
          style="width: 260px"
          placeholder="十进制或 0x 十六进制"
          clearable
        />
        <span v-if="numHex" class="mono hint">= {{ numHex.hex }}</span>
      </div>
      <el-descriptions v-if="numHex" :column="2" border size="small" style="margin-top: 10px">
        <el-descriptions-item label="u32 LE 字节">
          <span class="mono">{{ numHex.le32 }}</span>
          <el-button size="small" text :icon="CopyDocument" @click="copy(numHex.le32)" />
        </el-descriptions-item>
        <el-descriptions-item label="u32 BE 字节">
          <span class="mono">{{ numHex.be32 }}</span>
          <el-button size="small" text :icon="CopyDocument" @click="copy(numHex.be32)" />
        </el-descriptions-item>
        <el-descriptions-item label="u64 LE 字节">
          <span class="mono">{{ numHex.le64 }}</span>
          <el-button size="small" text :icon="CopyDocument" @click="copy(numHex.le64)" />
        </el-descriptions-item>
        <el-descriptions-item label="u64 BE 字节">
          <span class="mono">{{ numHex.be64 }}</span>
          <el-button size="small" text :icon="CopyDocument" @click="copy(numHex.be64)" />
        </el-descriptions-item>
      </el-descriptions>
    </div>

    <div class="panel-section">
      <h3>字节交换（16/32/64 位）</h3>
      <div class="row">
        <el-input
          v-model="swapInput"
          class="mono"
          style="width: 260px"
          placeholder="HEX 值，如 12345678"
          clearable
        />
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
</template>

<style scoped>
.endian-panel {
  overflow: auto;
}

.mono {
  font-family: var(--font-mono);
}

.tbl-title {
  font-size: 13px;
  font-weight: 600;
  margin: 12px 0 6px;
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
</style>
