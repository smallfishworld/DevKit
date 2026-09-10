<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import {
  evalExpr,
  fmtBin,
  fmtDec,
  fmtHex,
  fmtOct,
  byteLayout,
  type Width
} from '@renderer/tools/calc/engine'

const expr = ref('0xDEAD & 0xFF')
const width = ref<Width>(32)
const value = ref(0n)
const truncated = ref(false)
const error = ref<string | null>(null)

interface HistoryItem {
  expr: string
  hex: string
  dec: string
}
const history = ref<HistoryItem[]>([])

function recompute(): void {
  const r = evalExpr(expr.value, width.value)
  value.value = r.value
  truncated.value = r.truncated
  error.value = r.error
}

watch([expr, width], recompute, { immediate: true })

watch(width, () => {
  truncated.value = false
})

// ---------- 各进制显示 ----------
const hexStr = computed(() => fmtHex(value.value, width.value))
const decUnsigned = computed(() => fmtDec(value.value, width.value, false))
const decSigned = computed(() => fmtDec(value.value, width.value, true))
const octStr = computed(() => fmtOct(value.value, width.value))
const binStr = computed(() => fmtBin(value.value, width.value))

// ---------- bit 编辑器 ----------
const bits = computed(() => {
  const list: { index: number; on: boolean }[] = []
  for (let i = width.value - 1; i >= 0; i -= 1) {
    list.push({ index: i, on: ((value.value >> BigInt(i)) & 1n) === 1n })
  }
  return list
})

function toggleBit(index: number): void {
  value.value ^= 1n << BigInt(index)
  expr.value = '0x' + value.value.toString(16).toUpperCase()
  error.value = null
  truncated.value = false
}

// ---------- 字节布局 ----------
const layout = computed(() => byteLayout(value.value, width.value))

// ---------- 运算符快捷插入 ----------
const OP_BUTTONS = [
  '+', '-', '*', '/', '%',
  '&', '|', '^', '~',
  '<<', '>>', '>>>', '(', ')'
]

function insertOp(op: string): void {
  expr.value += op
}

function evaluate(): void {
  if (error.value) {
    ElMessage.warning(error.value)
    return
  }
  history.value.unshift({
    expr: expr.value,
    hex: hexStr.value,
    dec: decSigned.value
  })
  if (history.value.length > 30) history.value.pop()
}

function loadHistory(item: HistoryItem): void {
  expr.value = item.expr
}
</script>

<template>
  <div class="panel calc-panel">
    <div class="calc-main">
      <!-- 输入区 -->
      <div class="panel-section">
        <div class="panel-row" style="margin-bottom: 10px">
          <el-radio-group v-model="width" size="small">
            <el-radio-button :value="8">8 bit</el-radio-button>
            <el-radio-button :value="16">16 bit</el-radio-button>
            <el-radio-button :value="32">32 bit</el-radio-button>
            <el-radio-button :value="64">64 bit</el-radio-button>
          </el-radio-group>
          <span class="hint">输入表达式，回车存入历史；支持 0x/0o/0b 前缀</span>
        </div>
        <el-input
          v-model="expr"
          class="expr-input"
          placeholder="例：0x1F & ~(1<<3) | (1<<5)"
          autofocus
          @keydown.enter="evaluate"
        >
          <template #prepend>表达式</template>
        </el-input>
        <div class="op-row">
          <el-button
            v-for="op in OP_BUTTONS"
            :key="op"
            size="small"
            class="op-btn"
            @click="insertOp(op)"
          >
            {{ op }}
          </el-button>
          <el-button size="small" type="primary" @click="evaluate">存入历史</el-button>
        </div>
        <div v-if="error" class="err-line">{{ error }}</div>
        <div v-else-if="truncated" class="warn-line">
          结果超出 {{ width }} 位，已按位宽截断
        </div>
      </div>

      <!-- 进制显示 -->
      <div class="panel-section">
        <h3>数值显示</h3>
        <div class="base-grid">
          <div class="base-card">
            <div class="base-label">HEX 十六进制</div>
            <div class="base-value mono">{{ hexStr }}</div>
          </div>
          <div class="base-card">
            <div class="base-label">DEC 无符号 / 有符号</div>
            <div class="base-value mono">
              {{ decUnsigned }} <span class="dec-signed">/ {{ decSigned }}</span>
            </div>
          </div>
          <div class="base-card">
            <div class="base-label">OCT 八进制</div>
            <div class="base-value mono">{{ octStr }}</div>
          </div>
          <div class="base-card base-card-wide">
            <div class="base-label">BIN 二进制（4 位分组）</div>
            <div class="base-value mono bin">{{ binStr }}</div>
          </div>
        </div>
      </div>

      <!-- bit 编辑器 -->
      <div class="panel-section">
        <h3>Bit 编辑器（点击翻转）</h3>
        <div class="bit-editor">
          <div v-for="(bit, i) in bits" :key="bit.index" class="bit-cell-wrap">
            <div
              class="bit-cell mono"
              :class="{ on: bit.on, gap: i % 8 === 7 && i !== bits.length - 1 }"
              :title="'bit ' + bit.index"
              @click="toggleBit(bit.index)"
            >
              {{ bit.on ? 1 : 0 }}
            </div>
            <div v-if="bit.index % 4 === 0" class="bit-idx">{{ bit.index }}</div>
            <div v-else class="bit-idx-placeholder">&nbsp;</div>
          </div>
        </div>
      </div>

      <!-- 字节布局 -->
      <div class="panel-section">
        <h3>内存字节布局（{{ width / 8 }} 字节）</h3>
        <div class="panel-row" style="margin-bottom: 8px">
          <el-tag size="small">大端 BE</el-tag>
          <span v-for="(b, i) in layout.be" :key="'be' + i" class="byte-chip mono">{{ b }}</span>
        </div>
        <div class="panel-row">
          <el-tag size="small" type="warning">小端 LE</el-tag>
          <span v-for="(b, i) in layout.le" :key="'le' + i" class="byte-chip mono">{{ b }}</span>
        </div>
      </div>
    </div>

    <!-- 历史 -->
    <div class="panel-section calc-history">
      <h3>历史记录</h3>
      <el-empty v-if="history.length === 0" description="无历史" :image-size="60" />
      <div
        v-for="(item, i) in history"
        :key="i"
        class="history-item"
        @click="loadHistory(item)"
      >
        <div class="mono history-expr">{{ item.expr }}</div>
        <div class="mono history-result">{{ item.hex }} · {{ item.dec }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.calc-panel {
  flex-direction: row;
  gap: 16px;
  align-items: flex-start;
}

.calc-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

.mono {
  font-family: var(--font-mono);
}

.hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.expr-input :deep(.el-input__inner) {
  font-family: var(--font-mono);
  font-size: 15px;
}

.op-row {
  margin-top: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.op-btn {
  font-family: var(--font-mono);
  min-width: 42px;
  margin: 0 !important;
}

.err-line {
  margin-top: 8px;
  color: var(--el-color-danger);
  font-size: 13px;
}

.warn-line {
  margin-top: 8px;
  color: var(--el-color-warning);
  font-size: 13px;
}

.base-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.base-card {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  padding: 10px 12px;
}

.base-card-wide {
  grid-column: 1 / -1;
}

.base-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-bottom: 6px;
}

.base-value {
  font-size: 16px;
  word-break: break-all;
}

.dec-signed {
  color: var(--el-text-color-secondary);
}

.bin {
  letter-spacing: 1px;
  color: var(--el-color-primary-light-3);
}

.bit-editor {
  display: flex;
  flex-wrap: wrap;
  row-gap: 2px;
}

.bit-cell-wrap {
  width: 30px;
  margin-right: 2px;
}

.bit-cell.gap {
  margin-right: 12px;
}

.bit-cell {
  height: 28px;
  line-height: 28px;
  text-align: center;
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
  color: var(--el-text-color-secondary);
  transition: background 0.1s;
}

.bit-cell:hover {
  border-color: var(--el-color-primary);
}

.bit-cell.on {
  background: var(--el-color-primary);
  border-color: var(--el-color-primary);
  color: #fff;
  font-weight: 700;
}

.bit-idx {
  font-size: 10px;
  text-align: center;
  color: var(--el-text-color-secondary);
}

.byte-chip {
  display: inline-block;
  min-width: 34px;
  text-align: center;
  padding: 4px 6px;
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  background: var(--el-fill-color-light);
}

.calc-history {
  width: 280px;
  flex-shrink: 0;
  max-height: calc(100vh - 160px);
  overflow-y: auto;
}

.history-item {
  padding: 8px 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  margin-bottom: 8px;
  cursor: pointer;
}

.history-item:hover {
  border-color: var(--el-color-primary);
}

.history-expr {
  font-size: 13px;
  word-break: break-all;
}

.history-result {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 4px;
}
</style>
