<script setup lang="ts">
import { onUnmounted, ref } from 'vue'
import { usePanelMessage } from '@renderer/composables/panelOverlays'
import { Aim, CopyDocument } from '@element-plus/icons-vue'
import { useI18n } from 'vue-i18n'

const ElMessage = usePanelMessage()
const { t } = useI18n()

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
  if (picking.value) return
  picking.value = true
  // 取点窗口会盖住整个屏幕：先给个提示，避免用户以为按钮没反应
  const hint = ElMessage({ message: t('colorPicker.hint'), duration: 0, showClose: false })
  try {
    const res = (await window.api.invoke('color', 'pick', `color#${Date.now()}`)) as {
      x: number
      y: number
      color: string
    } | null
    if (res) {
      history.value.unshift({ ...res, time: Date.now() })
      if (history.value.length > 50) history.value.pop()
      ElMessage.success(t('colorPicker.picked', { color: res.color }))
    }
  } catch (error) {
    ElMessage.error(t('colorPicker.failed', { error: String(error) }))
  } finally {
    hint.close()
    picking.value = false
  }
}

async function copy(text: string): Promise<void> {
  await window.api.win.writeClipboard(text)
  ElMessage.success(t('colorPicker.copied', { text }))
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
  <div class="panel converter-page color-panel">
    <header class="converter-head">
      <div>
        <h1>{{ t('colorPicker.title') }}</h1>
        <p>{{ t('colorPicker.subtitle') }}</p>
      </div>
    </header>

    <div class="panel-section">
      <h3>{{ t('colorPicker.screen') }}</h3>
      <div class="row">
        <el-button type="primary" size="small" :icon="Aim" :loading="picking" @click="pick">
          {{ t('colorPicker.pick') }}
        </el-button>
        <span class="hint">{{ t('colorPicker.instructions') }}</span>
      </div>
    </div>

    <div class="panel-section">
      <h3>{{ t('colorPicker.history') }}</h3>
      <el-empty v-if="history.length === 0" :description="t('colorPicker.empty')" :image-size="80" />
      <div v-else class="color-list">
        <div v-for="(c, i) in history" :key="`${c.time}-${i}`" class="color-item">
          <div class="swatch" :style="{ background: c.color }" />
          <div class="meta">
            <div class="mono val">
              <span>{{ c.color }}</span>
              <el-button size="small" text :icon="CopyDocument" @click="copy(c.color)" />
            </div>
            <div class="mono sub">
              <span>RGB({{ rgbStr(c.color) }}) @ ({{ c.x }}, {{ c.y }})</span>
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
  flex-wrap: wrap;
  gap: 12px;
}

.hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

/* 宽屏自适应多列色卡网格，消除原先 480px 限宽带来的右侧大片空白 */
.color-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}

.color-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--el-bg-color-overlay);
}

.swatch {
  width: 44px;
  height: 44px;
  border-radius: 6px;
  border: 1px solid var(--el-border-color);
  flex: 0 0 44px;
}

.meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.val,
.sub {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.val {
  font-size: 14px;
  font-weight: 600;
}

.sub {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
