<script setup lang="ts">
import { computed } from 'vue'
import { Close, Monitor, Moon, Sunny, Brush } from '@element-plus/icons-vue'
import { useAppearanceStore } from '@renderer/stores/appearance'

const visible = defineModel<boolean>({ required: true })
const appearance = useAppearanceStore()
const terminal = computed(() => appearance.terminalTheme)
const presets = [
  { id: 'system', label: '跟随系统', icon: Monitor },
  { id: 'devkit-default', label: '深色石墨', icon: Moon },
  { id: 'solarized-light', label: '浅色纸感', icon: Sunny },
  { id: 'tokyo-night', label: '深海蓝', icon: Brush }
] as const
const selected = computed(() => appearance.settings.followSystem ? 'system' : appearance.settings.terminalTheme)

function selectTheme(id: string): void {
  if (id === 'system') appearance.followSystem()
  else appearance.setTerminalTheme(id)
}
</script>

<template>
  <el-popover v-model:visible="visible" placement="bottom-end" :width="336" trigger="click" popper-class="appearance-popper">
    <template #reference><slot /></template>
    <section class="appearance-settings" aria-label="外观与终端配色">
      <header>
        <h2>外观与终端配色</h2>
        <el-button text size="small" :icon="Close" aria-label="关闭外观浮层" @click="visible = false" />
      </header>
      <div class="skin-presets" role="group" aria-label="快速换肤">
        <button v-for="preset in presets" :key="preset.id" type="button" :aria-pressed="selected === preset.id" @click="selectTheme(preset.id)">
          <el-icon><component :is="preset.icon" /></el-icon>{{ preset.label }}
        </button>
      </div>
      <div class="terminal-preview" :style="{ background: terminal.background, color: terminal.foreground }">
        <div><span :style="{ color: terminal.ansi.blue }">devkit@board:~$</span> status</div>
        <div><span :style="{ color: terminal.ansi.green }">RX [OK]</span> vcc=3.30V</div>
        <div><span :style="{ color: terminal.ansi.yellow }">[WARN]</span> retrying link...</div>
      </div>
      <footer><small>当前 · {{ presets.find((preset) => preset.id === selected)?.label ?? terminal.name }}</small></footer>
      <details>
        <summary>更多终端配色</summary>
        <el-select :model-value="terminal.id" aria-label="更多终端配色" filterable @change="selectTheme">
          <el-option v-for="theme in appearance.terminalThemes" :key="theme.id" :value="theme.id" :label="theme.name" />
        </el-select>
        <div class="palette" aria-label="ANSI 16 色预览">
          <span v-for="(color, name) in terminal.ansi" :key="name" :title="name" :style="{ background: color }" />
        </div>
      </details>
    </section>
  </el-popover>
</template>

<style scoped>
.appearance-settings { display:grid; gap:10px; }
header { display:flex; align-items:center; justify-content:space-between; gap:8px; }
h2 { margin:0; font-size:14px; }
.skin-presets { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:6px; }
.skin-presets button { display:flex; align-items:center; gap:8px; border:1px solid var(--el-border-color); border-radius:6px; padding:7px 9px; color:inherit; background:var(--el-bg-color); font:inherit; cursor:pointer; }
.skin-presets button:hover, .skin-presets button[aria-pressed="true"] { border-color:var(--el-color-primary); color:var(--el-color-primary); background:var(--el-color-primary-light-9); }
.terminal-preview { padding:10px 11px; border:1px solid var(--el-border-color-lighter); border-radius:6px; font:12px/1.6 var(--font-mono); }
footer, summary { color:var(--el-text-color-secondary); font-size:12px; }
summary { margin-bottom:6px; cursor:pointer; }
.palette { display:grid; grid-template-columns:repeat(8,1fr); gap:3px; margin-top:7px; }
.palette span { min-height:12px; border-radius:3px; border:1px solid var(--el-border-color-lighter); }
</style>
