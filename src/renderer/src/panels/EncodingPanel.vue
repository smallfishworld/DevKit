<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { usePanelMessage } from '@renderer/composables/panelOverlays'
import { CopyDocument } from '@element-plus/icons-vue'

const ElMessage = usePanelMessage()

const CODEC_PANEL = 'codec#main'

const src = ref('Hello 嵌入式 123')

/** GBK 编解码走主进程（iconv-lite 需 Node Buffer，渲染端无 polyfill） */
const gbkHex = ref('')
const gbkBytes = ref(0)

function requestGbk(text: string): void {
  window.api
    .invoke('codec', 'gbk:encode', CODEC_PANEL, { text })
    .then((res) => {
      const r = res as { hex: string; bytes: number }
      gbkHex.value = r.hex
      gbkBytes.value = r.bytes
    })
    .catch(() => {})
}

watch(
  src,
  (v) => requestGbk(v),
  { immediate: true }
)

/** 文本 -> 各编码 HEX 字节（GBK 见上方异步结果） */
const encodings = computed(() => {
  const text = src.value
  const utf8 = [...new TextEncoder().encode(text)]
  const utf16: number[] = []
  for (const ch of text) {
    for (const unit of Array.from(ch).flatMap((c) => {
      const v = c.codePointAt(0) ?? 0
      return v > 0xffff
        ? [0xd800 + ((v - 0x10000) >> 10), 0xdc00 + ((v - 0x10000) & 0x3ff)]
        : [v]
    })) {
      utf16.push((unit >> 8) & 0xff, unit & 0xff)
    }
  }
  const esc = Array.from(text)
    .map((c) => {
      const v = c.codePointAt(0) ?? 0
      return v > 0xffff
        ? ''
        : v < 0x80 && v >= 0x20
          ? c
          : '\\u' + v.toString(16).padStart(4, '0').toUpperCase()
    })
    .join('')
  return [
    { name: 'UTF-8', text: toHex(utf8), len: `${utf8.length} 字节` },
    { name: 'GBK', text: gbkHex.value, len: gbkBytes.value ? `${gbkBytes.value} 字节` : '' },
    { name: 'UTF-16BE', text: toHex(utf16), len: `${utf16.length} 字节` },
    { name: 'Unicode 转义', text: esc, len: '' }
  ]
})

function toHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')
}

/** HEX 字节 -> 文本（UTF-8 本地解码；GBK 走主进程） */
const hexInput = ref('E5 B5 8C E5 85 A5 E5 BC 8F')
const decodeEnc = ref<'utf-8' | 'gbk'>('utf-8')
const gbkDecoded = ref<{ ok: boolean; text: string } | null>(null)

const utf8Decoded = computed(() => {
  const compact = hexInput.value.replace(/0x/gi, ' ').replace(/[^0-9a-fA-F]/g, '')
  if (!compact || compact.length % 2 !== 0) return { ok: false, text: '' }
  const bytes = new Uint8Array(compact.length / 2)
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(compact.slice(i * 2, i * 2 + 2), 16)
  try {
    return { ok: true, text: new TextDecoder('utf-8').decode(bytes) }
  } catch {
    return { ok: false, text: '' }
  }
})

watch(
  [hexInput, decodeEnc],
  ([hex, enc]) => {
    if (enc !== 'gbk') return
    window.api
      .invoke('codec', 'gbk:decode', CODEC_PANEL, { hex })
      .then((res) => {
        gbkDecoded.value = res as { ok: boolean; text: string }
      })
      .catch(() => {})
  },
  { immediate: true }
)

const decoded = computed(() => (decodeEnc.value === 'gbk' ? (gbkDecoded.value ?? { ok: true, text: '' }) : utf8Decoded.value))

/** Base64（UTF-8 语义） */
const b64 = computed(() => {
  try {
    return btoa(String.fromCharCode(...new TextEncoder().encode(src.value)))
  } catch {
    return '(内容过长)'
  }
})

const b64Input = ref('')
const b64Decoded = computed(() => {
  try {
    const bin = atob(b64Input.value.trim())
    return new TextDecoder('utf-8').decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
  } catch {
    return null
  }
})

/** URL 编码还原 */
const urlDecoded = computed(() => {
  try {
    return decodeURIComponent(src.value)
  } catch {
    return null
  }
})

async function copy(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
  ElMessage.success('已复制')
}
</script>

<template>
  <div class="panel converter-page enc-panel">
    <header class="converter-head">
      <div>
        <h1>编码转换</h1>
        <p>UTF-8 / GBK / UTF-16BE / Base64 / URL 实时互转</p>
      </div>
    </header>

    <div class="panel-section">
      <h3>文本 → 字节编码</h3>
      <el-input
        v-model="src"
        type="textarea"
        :rows="3"
        placeholder="输入文本，下方实时显示各编码结果"
      />
      <el-descriptions :column="2" border size="small" class="enc-desc">
        <el-descriptions-item v-for="e in encodings" :key="e.name" :label="e.name">
          <div class="desc-cell">
            <span class="mono wrap flex-1">{{ e.text }}</span>
            <span v-if="e.len" class="hint">{{ e.len }}</span>
            <el-button size="small" text :icon="CopyDocument" @click="copy(e.text)" />
          </div>
        </el-descriptions-item>
      </el-descriptions>
    </div>

    <div class="panel-section">
      <h3>HEX 字节 → 文本</h3>
      <div class="row">
        <el-radio-group v-model="decodeEnc" size="small">
          <el-radio-button value="utf-8">UTF-8</el-radio-button>
          <el-radio-button value="gbk">GBK</el-radio-button>
        </el-radio-group>
        <el-input
          v-model="hexInput"
          size="small"
          class="mono flex-1"
          placeholder="如 E5 B5 8C（空格/逗号/连续写法均可）"
          clearable
        />
      </div>
      <el-alert
        v-if="hexInput && decoded.ok"
        type="success"
        :closable="false"
        class="mono result-alert"
        :title="decoded.text || '(空)'"
      />
      <el-alert
        v-else-if="hexInput"
        type="error"
        :closable="false"
        class="result-alert"
        title="HEX 格式非法或长度不是偶数"
      />
    </div>

    <div class="converter-split equal">
      <div class="panel-section">
        <h3>Base64</h3>
        <div class="row">
          <span class="lbl">编码</span>
          <span class="mono wrap flex-1">{{ b64 }}</span>
          <el-button size="small" text :icon="CopyDocument" @click="copy(b64)" />
        </div>
        <div class="row mt-8">
          <span class="lbl">解码</span>
          <el-input v-model="b64Input" size="small" class="mono flex-1" placeholder="粘贴 Base64" clearable />
        </div>
        <div v-if="b64Input" class="b64-out mono wrap">{{ b64Decoded ?? '(无效 Base64)' }}</div>
      </div>

      <div class="panel-section">
        <h3>URL 编码还原</h3>
        <div class="row">
          <span class="mono wrap flex-1">{{ urlDecoded ?? '(无效转义)' }}</span>
          <el-button size="small" text :icon="CopyDocument" @click="copy(urlDecoded ?? '')" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.enc-panel {
  overflow: auto;
}

.mono {
  font-family: var(--font-mono);
}

.wrap {
  word-break: break-all;
  white-space: pre-wrap;
}

.flex-1 {
  flex: 1;
  min-width: 0;
}

.enc-desc {
  margin-top: 12px;
}

.desc-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mt-8 {
  margin-top: 8px;
}

.result-alert {
  margin-top: 12px;
}

.b64-out {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--el-fill-color-light);
  font-size: 12px;
}

.lbl {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  flex: 0 0 36px;
}

.hint {
  flex: none;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
