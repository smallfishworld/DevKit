<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  ANSI_COLOR_KEYS,
  parseTabbyThemeText,
  slugifyThemeName,
  type AnsiColorKey,
  type TerminalTheme
} from '../../../shared/theme'
import { useAppearanceStore } from '@renderer/stores/appearance'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void }>()
const appearance = useAppearanceStore()
const fileInput = ref<HTMLInputElement | null>(null)
const editorOpen = ref(false)

function cloneTheme(theme: TerminalTheme): TerminalTheme {
  return JSON.parse(JSON.stringify(theme)) as TerminalTheme
}

const draft = ref<TerminalTheme>(cloneTheme(appearance.terminalTheme))
const activeTheme = computed(() => appearance.terminalTheme)
const activeIsCustom = computed(() => activeTheme.value.builtin !== true)

const ansiLabels: Record<AnsiColorKey, string> = {
  black: 'Black',
  red: 'Red',
  green: 'Green',
  yellow: 'Yellow',
  blue: 'Blue',
  magenta: 'Magenta',
  cyan: 'Cyan',
  white: 'White',
  brightBlack: 'Bright Black',
  brightRed: 'Bright Red',
  brightGreen: 'Bright Green',
  brightYellow: 'Bright Yellow',
  brightBlue: 'Bright Blue',
  brightMagenta: 'Bright Magenta',
  brightCyan: 'Bright Cyan',
  brightWhite: 'Bright White'
}

function close(): void {
  emit('update:modelValue', false)
}

function startCustomFromActive(): void {
  const base = cloneTheme(activeTheme.value)
  base.id = `custom-${slugifyThemeName(base.name)}-${Date.now().toString(36)}`
  base.name = `${base.name} 自定义`
  base.builtin = false
  draft.value = base
  editorOpen.value = true
}

function editActiveCustom(): void {
  if (!activeIsCustom.value) return
  draft.value = cloneTheme(activeTheme.value)
  editorOpen.value = true
}

function saveDraft(): void {
  draft.value.name = draft.value.name.trim() || 'Custom Terminal'
  draft.value.builtin = false
  draft.value.cursorAccent = draft.value.background
  if (!hasValidColors(draft.value)) {
    ElMessage.error('存在无法识别的颜色值，请使用 #RRGGBB / rgb() / hsl() 等 CSS 颜色')
    return
  }
  if (!appearance.upsertCustomTerminalTheme(cloneTheme(draft.value))) {
    ElMessage.error('自定义主题保存失败，请检查颜色配置')
    return
  }
  editorOpen.value = false
  ElMessage.success('终端主题已保存')
}

async function deleteActiveCustom(): Promise<void> {
  if (!activeIsCustom.value) return
  try {
    await ElMessageBox.confirm(`删除自定义主题「${activeTheme.value.name}」？`, '删除主题', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  appearance.removeCustomTerminalTheme(activeTheme.value.id)
}

function pickThemeFile(): void {
  fileInput.value?.click()
}

function terminalThemeColors(theme: TerminalTheme): string[] {
  return [
    theme.foreground,
    theme.background,
    theme.cursor,
    theme.cursorAccent ?? theme.background,
    theme.selectionBackground,
    ...(theme.selectionForeground ? [theme.selectionForeground] : []),
    ...ANSI_COLOR_KEYS.map((key) => theme.ansi[key])
  ]
}

function hasValidColors(theme: TerminalTheme): boolean {
  return terminalThemeColors(theme).every((color) => CSS.supports('color', color))
}

async function importTheme(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    const theme = parseTabbyThemeText(await file.text())
    if (!hasValidColors(theme)) throw new Error('主题包含无法识别的颜色值')
    if (appearance.terminalThemes.some((item) => item.id === theme.id)) {
      theme.id = `${theme.id}-${Date.now().toString(36)}`
    }
    if (!appearance.upsertCustomTerminalTheme(theme)) throw new Error('主题 ID 与内置主题冲突')
    ElMessage.success(`已导入主题「${theme.name}」`)
  } catch (error) {
    ElMessage.error(`导入失败：${error instanceof Error ? error.message : String(error)}`)
  }
}
</script>

<template>
  <el-dialog
    :model-value="props.modelValue"
    title="外观设置"
    width="760px"
    :destroy-on-close="false"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="settings-body">
      <section class="settings-section">
        <div class="section-title">应用主题</div>
        <div class="ui-theme-row">
          <el-radio-group
            :model-value="appearance.settings.uiThemeId"
            :disabled="appearance.settings.followSystem"
            @change="appearance.setUiTheme(String($event))"
          >
            <el-radio-button v-for="theme in appearance.uiThemes" :key="theme.id" :value="theme.id">
              {{ theme.name }}
            </el-radio-button>
          </el-radio-group>
          <el-checkbox
            :model-value="appearance.settings.followSystem"
            @change="appearance.setFollowSystem(Boolean($event))"
          >
            跟随系统明暗模式
          </el-checkbox>
        </div>
        <div class="hint">应用界面主题与终端配色相互独立，切换不会影响已打开的串口或 SSH 会话。</div>
      </section>

      <section class="settings-section">
        <div class="section-head">
          <div>
            <div class="section-title">终端配色</div>
            <div class="hint">串口和 SSH 共用全局配色；xterm ANSI 16 色、光标和选区实时切换。</div>
          </div>
          <div class="theme-actions">
            <el-button size="small" @click="pickThemeFile">导入 Tabby</el-button>
            <el-button size="small" @click="startCustomFromActive">复制为自定义</el-button>
            <el-button v-if="activeIsCustom" size="small" @click="editActiveCustom">编辑</el-button>
            <el-button v-if="activeIsCustom" size="small" type="danger" plain @click="deleteActiveCustom">
              删除
            </el-button>
          </div>
        </div>

        <input
          ref="fileInput"
          class="hidden-file"
          type="file"
          accept=".yaml,.yml,.json,.tabby"
          @change="importTheme"
        />

        <el-select
          :model-value="appearance.settings.terminalThemeId"
          class="theme-select"
          @change="appearance.setTerminalTheme(String($event))"
        >
          <el-option
            v-for="theme in appearance.terminalThemes"
            :key="theme.id"
            :value="theme.id"
            :label="theme.builtin ? theme.name : `${theme.name} · 自定义`"
          />
        </el-select>

        <div
          class="terminal-preview"
          :style="{ background: activeTheme.background, color: activeTheme.foreground }"
        >
          <div class="preview-line"><span class="prompt" :style="{ color: activeTheme.ansi.green }">devkit@board</span>:~$ ls -la</div>
          <div class="preview-line">
            <span :style="{ color: activeTheme.ansi.green }">SUCCESS</span>
            <span :style="{ color: activeTheme.ansi.yellow }">WARNING</span>
            <span :style="{ color: activeTheme.ansi.red }">ERROR</span>
            <span :style="{ color: activeTheme.ansi.blue }">INFO</span>
            <span :style="{ color: activeTheme.ansi.cyan }">ttyUSB0</span>
          </div>
          <div class="ansi-strip" title="ANSI 16 色">
            <span
              v-for="key in ANSI_COLOR_KEYS"
              :key="key"
              class="ansi-block"
              :style="{ background: activeTheme.ansi[key] }"
            />
          </div>
        </div>
      </section>

      <section v-if="editorOpen" class="settings-section editor-section">
        <div class="section-head">
          <div class="section-title">自定义终端主题</div>
          <el-button size="small" text @click="editorOpen = false">收起</el-button>
        </div>

        <el-form label-position="top" size="small">
          <el-form-item label="主题名称">
            <el-input v-model="draft.name" />
          </el-form-item>

          <div class="color-grid base-grid">
            <label class="color-field">
              <span>前景</span>
              <input v-model="draft.foreground" type="color" />
              <el-input v-model="draft.foreground" />
            </label>
            <label class="color-field">
              <span>背景</span>
              <input v-model="draft.background" type="color" />
              <el-input v-model="draft.background" />
            </label>
            <label class="color-field">
              <span>光标</span>
              <input v-model="draft.cursor" type="color" />
              <el-input v-model="draft.cursor" />
            </label>
            <label class="color-field">
              <span>选区</span>
              <input v-model="draft.selectionBackground" type="color" />
              <el-input v-model="draft.selectionBackground" />
            </label>
          </div>

          <div class="ansi-editor-title">ANSI 16 色</div>
          <div class="color-grid ansi-grid">
            <label v-for="key in ANSI_COLOR_KEYS" :key="key" class="color-field ansi-field">
              <span>{{ ansiLabels[key] }}</span>
              <input v-model="draft.ansi[key]" type="color" />
              <el-input v-model="draft.ansi[key]" />
            </label>
          </div>
        </el-form>

        <div class="editor-actions">
          <el-button @click="editorOpen = false">取消</el-button>
          <el-button type="primary" @click="saveDraft">保存并应用</el-button>
        </div>
      </section>
    </div>

    <template #footer>
      <el-button @click="close">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.settings-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-height: 70vh;
  overflow: auto;
  padding-right: 4px;
}

.settings-section {
  padding: 14px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  background: var(--el-bg-color);
}

.section-head,
.ui-theme-row,
.theme-actions,
.editor-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.section-title {
  margin-bottom: 8px;
  font-size: 14px;
  font-weight: 600;
}

.section-head .section-title {
  margin-bottom: 2px;
}

.hint {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.6;
}

.theme-select {
  width: 280px;
  margin: 12px 0;
}

.hidden-file {
  display: none;
}

.terminal-preview {
  padding: 14px 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.7;
  box-shadow: inset 0 1px 4px rgba(0, 0, 0, 0.22);
}

.preview-line {
  display: flex;
  gap: 14px;
  white-space: pre;
}

.ansi-strip {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 3px;
  margin-top: 10px;
}

.ansi-block {
  height: 14px;
  border-radius: 2px;
}

.editor-section {
  border-color: var(--el-color-primary-light-5);
}

.color-grid {
  display: grid;
  gap: 8px 12px;
}

.base-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.ansi-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.ansi-editor-title {
  margin: 6px 0 8px;
  font-size: 13px;
  font-weight: 600;
}

.color-field {
  display: grid;
  grid-template-columns: 92px 32px minmax(0, 1fr);
  align-items: center;
  gap: 6px;
  color: var(--el-text-color-regular);
  font-size: 12px;
}

.color-field input[type='color'] {
  width: 30px;
  height: 26px;
  padding: 1px;
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
}

.editor-actions {
  justify-content: flex-end;
  margin-top: 14px;
}

@media (max-width: 720px) {
  .base-grid,
  .ansi-grid {
    grid-template-columns: 1fr;
  }
}
</style>
