<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { FolderOpened, RefreshRight, Search, SwitchButton, VideoPlay } from '@element-plus/icons-vue'
import TerminalView from '@renderer/components/TerminalView.vue'
import { useTabStore } from '@renderer/stores/tabs'
import {
  DEFAULT_LOCAL_TERMINAL_CONFIG,
  normalizeLocalTerminalProfileId,
  type LocalTerminalAttachResult,
  type LocalTerminalConfig,
  type LocalTerminalDataEvent,
  type LocalTerminalExitEvent,
  type ShellProfile
} from '../../../shared/local-terminal'

const props = defineProps<{ panelId: string }>()
const tabStore = useTabStore()
const termView = ref<InstanceType<typeof TerminalView> | null>(null)

const profiles = ref<ShellProfile[]>([])
const profileId = ref(DEFAULT_LOCAL_TERMINAL_CONFIG.defaultProfileId)
const cwd = ref('')
const font = ref(DEFAULT_LOCAL_TERMINAL_CONFIG.font)
const fontSize = ref(DEFAULT_LOCAL_TERMINAL_CONFIG.fontSize)
const running = ref(false)
const starting = ref(false)
const activeProfileId = ref<string | undefined>()
const lastSize = ref({ cols: 120, rows: 30 })
const TERM_SIZES = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 26, 28]
let unsubs: Array<() => void> = []

const selectedProfile = computed(() => profiles.value.find((item) => item.id === profileId.value))
const activeProfile = computed(() => profiles.value.find((item) => item.id === activeProfileId.value))
const availableProfiles = computed(() => profiles.value.filter((item) => item.available))
const windowsProfiles = computed(() => profiles.value.filter((item) => item.kind !== 'wsl'))
const wslProfiles = computed(() => profiles.value.filter((item) => item.kind === 'wsl'))
const profileChanged = computed(
  () => running.value && !!activeProfileId.value && activeProfileId.value !== profileId.value
)

function fallbackProfileId(): string {
  const normalized = normalizeLocalTerminalProfileId(profileId.value, profiles.value)
  if (profiles.value.some((item) => item.id === normalized && item.available)) return normalized
  return availableProfiles.value[0]?.id ?? normalized
}

async function persistConfig(): Promise<void> {
  const config: LocalTerminalConfig = {
    defaultProfileId: profileId.value,
    cwd: cwd.value,
    font: font.value,
    fontSize: fontSize.value
  }
  await window.api.invoke('local-terminal', 'config:set', props.panelId, config)
}

async function start(clearFirst = false): Promise<void> {
  if (starting.value) return
  const profile = selectedProfile.value
  if (!profile?.available) {
    ElMessage.warning(profile?.id === 'git-bash' ? '未检测到 Git for Windows / Git Bash' : '所选 Shell 不可用')
    return
  }
  starting.value = true
  try {
    if (clearFirst) termView.value?.clear()
    const result = (await window.api.invoke('local-terminal', 'start', props.panelId, {
      profileId: profileId.value,
      cwd: cwd.value,
      cols: lastSize.value.cols,
      rows: lastSize.value.rows
    })) as { ok: boolean; error?: string; cwd?: string; profile?: ShellProfile }
    if (!result.ok) {
      running.value = false
      ElMessage.error(`终端启动失败：${result.error ?? '未知错误'}`)
      return
    }
    running.value = true
    const startedProfileId = result.profile?.id ?? profileId.value
    activeProfileId.value = startedProfileId
    profileId.value = startedProfileId
    if (result.cwd) cwd.value = result.cwd
    tabStore.rename(props.panelId, result.profile?.name ?? profile.name)
    await persistConfig()
    termView.value?.focus()
  } finally {
    starting.value = false
  }
}

async function restart(): Promise<void> {
  await start(true)
}

async function stop(): Promise<void> {
  await window.api.invoke('local-terminal', 'kill', props.panelId)
  running.value = false
  activeProfileId.value = undefined
}

function onTermData(text: string): void {
  if (!running.value) return
  void window.api.invoke('local-terminal', 'write', props.panelId, { text })
}

function onTermResize(size: { cols: number; rows: number }): void {
  lastSize.value = size
  if (!running.value) return
  void window.api.invoke('local-terminal', 'resize', props.panelId, size)
}

function onFontSizeUpdate(size: number): void {
  fontSize.value = size
  void persistConfig()
}

function clearTerm(): void {
  termView.value?.clear()
}

function openSearch(): void {
  termView.value?.openSearch()
}

async function pickCwd(): Promise<void> {
  const result = (await window.api.invoke('local-terminal', 'cwd:pick', props.panelId)) as {
    ok: boolean
    path?: string
  }
  if (!result.ok || !result.path) return
  cwd.value = result.path
  await persistConfig()
}

async function onProfileChanged(): Promise<void> {
  await persistConfig()
}

async function onFontChanged(): Promise<void> {
  await persistConfig()
}

onMounted(async () => {
  unsubs.push(
    window.api.on('local-terminal', props.panelId, 'data', (payload) => {
      const evt = payload as LocalTerminalDataEvent
      termView.value?.write(evt.text)
    }),
    window.api.on('local-terminal', props.panelId, 'exit', (payload) => {
      const evt = payload as LocalTerminalExitEvent
      running.value = false
      activeProfileId.value = undefined
      termView.value?.info(`进程已退出，代码 ${evt.exitCode}`)
    }),
    window.api.on('local-terminal', props.panelId, 'status', (payload) => {
      const status = payload as { running?: boolean; profileId?: string; cwd?: string }
      if (typeof status.running === 'boolean') running.value = status.running
      if (status.profileId) activeProfileId.value = status.profileId
      if (status.cwd) cwd.value = status.cwd
    })
  )

  const result = (await window.api.invoke('local-terminal', 'attach', props.panelId)) as LocalTerminalAttachResult
  profiles.value = result.profiles
  profileId.value = result.config.defaultProfileId || DEFAULT_LOCAL_TERMINAL_CONFIG.defaultProfileId
  cwd.value = result.cwd ?? result.config.cwd ?? ''
  font.value = result.config.font || DEFAULT_LOCAL_TERMINAL_CONFIG.font
  fontSize.value = result.config.fontSize || DEFAULT_LOCAL_TERMINAL_CONFIG.fontSize
  running.value = result.running
  activeProfileId.value = result.activeProfileId
  profileId.value = running.value && activeProfileId.value ? activeProfileId.value : fallbackProfileId()

  if (availableProfiles.value.length === 0) {
    termView.value?.info('当前系统没有检测到可用的 Windows Shell。')
    return
  }
  if (!running.value) await start(false)
})

onUnmounted(() => {
  unsubs.forEach((fn) => fn())
  unsubs = []
  void window.api.invoke('local-terminal', 'dispose', props.panelId)
})
</script>

<template>
  <div class="panel local-terminal-panel">
    <div class="terminal-toolbar panel-section">
      <div class="toolbar-row">
        <span class="label">终端</span>
        <el-select v-model="profileId" size="small" style="width: 240px" @change="onProfileChanged">
          <el-option-group label="Windows Shell">
            <el-option
              v-for="profile in windowsProfiles"
              :key="profile.id"
              :value="profile.id"
              :label="profile.source ? `${profile.name} · ${profile.source}` : profile.name"
              :disabled="!profile.available"
            />
          </el-option-group>
          <el-option-group v-if="wslProfiles.length" label="WSL">
            <el-option
              v-for="profile in wslProfiles"
              :key="profile.id"
              :value="profile.id"
              :label="profile.name"
            />
          </el-option-group>
        </el-select>

        <span class="label">工作目录</span>
        <el-input
          v-model="cwd"
          size="small"
          class="cwd-input"
          placeholder="默认使用用户主目录"
          @change="persistConfig"
        />
        <el-button size="small" :icon="FolderOpened" title="选择工作目录" @click="pickCwd" />

        <el-button
          v-if="!running"
          type="primary"
          size="small"
          :icon="VideoPlay"
          :loading="starting"
          @click="start(false)"
        >启动</el-button>
        <el-button v-else size="small" :type="profileChanged ? 'primary' : ''" :icon="RefreshRight" :loading="starting" @click="restart">
          {{ profileChanged ? '切换终端' : '重启' }}
        </el-button>
        <el-button v-if="running" size="small" type="danger" plain :icon="SwitchButton" @click="stop">终止</el-button>
      </div>

      <div class="toolbar-row secondary">
        <el-select v-model="font" size="small" filterable allow-create style="width: 132px" @change="onFontChanged">
          <el-option value="Consolas" label="Consolas" />
          <el-option value="Cascadia Mono" label="Cascadia Mono" />
          <el-option value="Courier New" label="Courier New" />
        </el-select>
        <el-select v-model="fontSize" size="small" style="width: 72px" @change="onFontChanged">
          <el-option v-for="size in TERM_SIZES" :key="size" :value="size" :label="String(size)" />
        </el-select>
        <el-button size="small" text :icon="Search" @click="openSearch">查找</el-button>
        <el-button size="small" text @click="clearTerm">清屏</el-button>
        <span v-if="profileChanged" class="switch-hint">
          当前 {{ activeProfile?.name ?? activeProfileId }}，待切换到 {{ selectedProfile?.name ?? profileId }}
        </span>
        <span class="status" :class="{ online: running }">
          {{ running ? `运行中 · ${activeProfile?.name ?? activeProfileId ?? profileId}` : '已停止' }}
        </span>
      </div>
    </div>

    <div class="terminal-host">
      <TerminalView
        ref="termView"
        :font-size="fontSize"
        :font="font"
        @update:font-size="onFontSizeUpdate"
        @data="onTermData"
        @resize="onTermResize"
      />
    </div>
  </div>
</template>

<style scoped>
.local-terminal-panel {
  height: 100%;
  overflow: hidden;
  gap: 10px;
}

.terminal-toolbar {
  padding: 10px 12px;
  flex-shrink: 0;
}

.toolbar-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.toolbar-row.secondary {
  margin-top: 8px;
}

.label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.cwd-input {
  flex: 1;
  min-width: 180px;
}

.switch-hint {
  font-size: 12px;
  color: var(--el-color-warning);
  white-space: nowrap;
}

.status {
  margin-left: auto;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.status.online {
  color: var(--el-color-success);
}

.terminal-host {
  flex: 1;
  min-height: 0;
  display: flex;
}

.terminal-host :deep(.term-wrap) {
  width: 100%;
}
</style>
