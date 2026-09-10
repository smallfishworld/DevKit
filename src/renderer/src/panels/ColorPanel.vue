<script setup lang="ts">
import { onUnmounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Aim, CopyDocument } from '@element-plus/icons-vue'

interface PickedColor {
  x: number
  y: number
  color: string
  time: number
}

const picking = ref(false)
const history = ref<PickedColor[]>([])

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return null
  const n = parseInt(m[1], 16)
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff }
}

async function pick(): Promise<void> {
  picking.value = true
  try {
    const res = (await window.api.invoke('color', 'pick', `color#${Date.now()}`)) as {
      x: number
      y: number
      color: string
    } | null
    if (res) {
      history.value.unshift({ ...res, time: Date.now() })
      if (history.value.length > 50) history.value.pop()
    }
  } finally {
    picking.value = false
  }
}

async function copy(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
  ElMessage.success(`已复制 ${text}`)
}

function rgbStr(hex: string): string {
  const rgb = hexToRgb(hex)
  return rgb ? `${rgb.r}, ${rgb.g}, ${rgb.b}` : ''
}

function onUnmountClear(): void {
  history.value = []
}

onUnmounted(onUnmountClear)
</script>

<template>
  <div class="panel color-panel">
    <div class="panel-section">
      <h3>屏幕取色</h3>
      <div class="row">
        <el-button type="primary" :icon="Aim" :loading="picking" @click="pick">
          截屏取点（点击屏幕任意位置取色，Esc 取消）
        </el-button>
        <span class="hint">坐标为物理像素，颜色为截图像素值</span>
      </div>
    </div>

    <div class="panel-section">
      <h3>取色记录</h3>
      <el-empty v-if="history.length === 0" description="还没有取过颜色" :image-size="80" />
      <div class="color-list">
        <div v-for="(c, i) in history" :key="`${c.time}-${i}`" class="color-item">
          <div class="swatch" :style="{ background: c.color }" />
          <div class="meta">
            <div class="mono val">
              {{ c.color }}
              <el-button size="small" text :icon="CopyDocument" @click="copy(c.color)" />
            </div>
            <div class="mono sub">
              RGB({{ rgbStr(c.color) }}) @ ({{ c.x }}, {{ c.y }})
              <el-button
                size="small"
                text
                :icon="CopyDocument"
                @click="copy(`RGB(${rgbStr(c.color)})`)"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.color-panel {
  overflow: auto;
}

.mono {
  font-family: var(--font-mono);
}

.row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.color-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 480px;
}

.color-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
}

.swatch {
  width: 44px;
  height: 44px;
  border-radius: 6px;
  border: 1px solid var(--el-border-color);
  flex: 0 0 44px;
}

.meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.val {
  font-size: 14px;
}

.sub {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
