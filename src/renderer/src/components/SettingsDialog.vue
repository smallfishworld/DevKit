<script setup lang="ts">
import { computed } from 'vue'
import { useAppearanceStore } from '@renderer/stores/appearance'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void }>()

const appearance = useAppearanceStore()
const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

const terminal = computed(() => appearance.terminalTheme)

const ansiRows = computed(() => [
  ['black', terminal.value.ansi.black],
  ['red', terminal.value.ansi.red],
  ['green', terminal.value.ansi.green],
  ['yellow', terminal.value.ansi.yellow],
  ['blue', terminal.value.ansi.blue],
  ['magenta', terminal.value.ansi.magenta],
  ['cyan', terminal.value.ansi.cyan],
  ['white', terminal.value.ansi.white],
  ['brightBlack', terminal.value.ansi.brightBlack],
  ['brightRed', terminal.value.ansi.brightRed],
  ['brightGreen', terminal.value.ansi.brightGreen],
  ['brightYellow', terminal.value.ansi.brightYellow],
  ['brightBlue', terminal.value.ansi.brightBlue],
  ['brightMagenta', terminal.value.ansi.brightMagenta],
  ['brightCyan', terminal.value.ansi.brightCyan],
  ['brightWhite', terminal.value.ansi.brightWhite]
] as const)

function onTerminalThemeChange(value: string): void {
  appearance.setTerminalTheme(value)
}
</script>

<template>
  <el-dialog v-model="visible" title="终端配色" width="720px" append-to-body>
    <div class="appearance-settings">
      <section class="setting-section">
        <div class="setting-head">
          <div>
            <h3>终端配色</h3>
            <p>选定的终端主题同时驱动整个界面：主界面、面板、标签栏、按钮、边框与弹层全部跟随，切换后立即生效。</p>
          </div>
          <el-select
            :model-value="appearance.settings.terminalTheme"
            filterable
            style="width: 220px"
            @change="onTerminalThemeChange"
          >
            <el-option
              v-for="theme in appearance.terminalThemes"
              :key="theme.id"
              :value="theme.id"
              :label="theme.name"
            />
          </el-select>
        </div>

        <div
          class="terminal-preview"
          :style="{ background: terminal.background, color: terminal.foreground }"
        >
          <div class="preview-line dim">devkit@device:~$ <span class="cmd">make test</span></div>
          <div class="preview-line">
            <span :style="{ color: terminal.ansi.green }">PASS</span>
            <span> serial protocol tests</span>
          </div>
          <div class="preview-line">
            <span :style="{ color: terminal.ansi.yellow }">WARN</span>
            <span> retrying connection...</span>
          </div>
          <div class="preview-line">
            <span :style="{ color: terminal.ansi.red }">ERROR</span>
            <span> device timeout</span>
          </div>
          <div class="preview-line">
            <span :style="{ color: terminal.ansi.blue }">INFO</span>
            <span> RX 1024 bytes · TX 256 bytes</span>
            <span class="cursor" :style="{ background: terminal.cursor }"></span>
          </div>
        </div>

        <div class="palette" aria-label="ANSI 16 色预览">
          <div
            v-for="([name, color]) in ansiRows"
            :key="name"
            class="swatch-wrap"
            :title="`${name}: ${color}`"
          >
            <span class="swatch" :style="{ background: color }"></span>
            <span class="swatch-name">{{ name.replace('bright', '+') }}</span>
          </div>
        </div>

        <div class="theme-meta">
          <span>{{ terminal.name }}</span>
          <span v-if="terminal.author">· {{ terminal.author }}</span>
          <span>· ANSI 16 色</span>
        </div>
      </section>
    </div>

    <template #footer>
      <el-button type="primary" @click="visible = false">完成</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.appearance-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.setting-section {
  padding: 14px 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  background: var(--el-bg-color);
}

.setting-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}

.setting-head h3 {
  margin: 0 0 4px;
  font-size: 14px;
}

.setting-head p {
  margin: 0;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.6;
}

.terminal-preview {
  margin-top: 14px;
  min-height: 132px;
  padding: 14px 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.65;
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.28);
}

.preview-line {
  white-space: pre-wrap;
}

.preview-line.dim {
  opacity: 0.82;
}

.cmd {
  font-weight: 600;
}

.cursor {
  display: inline-block;
  width: 7px;
  height: 14px;
  margin-left: 4px;
  vertical-align: -2px;
}

.palette {
  display: grid;
  grid-template-columns: repeat(8, minmax(0, 1fr));
  gap: 8px;
  margin-top: 12px;
}

.swatch-wrap {
  min-width: 0;
  text-align: center;
}

.swatch {
  display: block;
  height: 24px;
  border: 1px solid rgba(127, 127, 127, 0.35);
  border-radius: 5px;
}

.swatch-name {
  display: block;
  margin-top: 3px;
  overflow: hidden;
  color: var(--el-text-color-secondary);
  font-family: var(--font-mono);
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.theme-meta {
  margin-top: 10px;
  color: var(--el-text-color-secondary);
  font-size: 11px;
}
</style>
