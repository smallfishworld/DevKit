<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { APP_UPDATES, APP_UPDATES_PANEL, updateNotice, type UpdateState } from '../../../shared/app-updates'

defineProps<{ currentVersion: string }>()

const emit = defineEmits<{
  (e: 'state-change', state: UpdateState): void
}>()

const state = ref<UpdateState>({ phase: 'idle' })
const dialog = ref<HTMLDialogElement>()
const invocationError = ref('')
const release = computed(() => 'release' in state.value ? state.value.release : undefined)
const installable = computed(() =>
  state.value.phase === 'available' ? state.value.installable !== false : true
)
const activity = computed(() => ['checking', 'downloading', 'preparing'].includes(state.value.phase))
const highlighted = computed(() => state.value.phase === 'available' || state.value.phase === 'ready')
const notice = computed(() => updateNotice(state.value))
const message = computed(() => invocationError.value || ('message' in state.value ? state.value.message : ''))
let unsubscribe: (() => void) | undefined

watch(state, (val) => emit('state-change', val), { immediate: true })

onMounted(async () => {
  let receivedEvent = false
  unsubscribe = window.api.on(APP_UPDATES, APP_UPDATES_PANEL, 'state', (value) => {
    receivedEvent = true
    state.value = value as UpdateState
  })
  try {
    const initial = await window.api.invoke(APP_UPDATES, 'state', APP_UPDATES_PANEL) as UpdateState
    if (!receivedEvent) state.value = initial
  } catch {
    // 兼容旧版或未挂载更新服务的后端
  }
})
onUnmounted(() => unsubscribe?.())

async function run(action: 'check' | 'download' | 'restart' | 'save' | 'release'): Promise<void> {
  invocationError.value = ''
  if (action === 'download' || action === 'restart') {
    dialog.value?.querySelector<HTMLButtonElement>('form button')?.focus()
  }
  try {
    await window.api.invoke(APP_UPDATES, action, APP_UPDATES_PANEL)
  } catch {
    invocationError.value = '无法执行更新操作，请重试。'
  }
}

function show(autoCheck = true): void {
  dialog.value?.showModal()
  if (autoCheck && (state.value.phase === 'idle' || state.value.phase === 'current' || state.value.phase === 'check-failed')) {
    void run('check')
  }
}

defineExpose({ show, run })
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="update-dialog" aria-labelledby="app-update-title">
      <h2 id="app-update-title">DevKit 应用更新</h2>
      <p class="update-version">当前版本 v{{ currentVersion || '…' }}</p>
      <p class="update-status" role="status">{{ notice || '点击下方按钮检查 GitHub 最新稳定版本。' }}</p>

      <section v-if="release" aria-labelledby="app-update-notes">
        <h3 id="app-update-notes">v{{ release.version }} 更新内容</h3>
        <p class="update-notes" tabindex="0">{{ release.notes || '此版本未提供更新说明。' }}</p>
        <button type="button" class="update-link" @click="run('release')">在 GitHub 查看发布说明</button>
      </section>

      <progress
        v-if="state.phase === 'downloading'"
        :value="state.received"
        :max="state.release.bytes"
        aria-label="更新包下载进度"
      />
      <p v-if="state.phase === 'ready'" class="update-restart-note">
        重启会结束当前的串口、SSH 和传输会话。
      </p>
      <p v-else-if="state.phase === 'available' && !installable" class="update-restart-note">
        当前运行环境仅支持检查版本，请前往 GitHub Releases 下载对应安装包。
      </p>
      <p class="update-message" role="status">{{ message && message !== notice ? message : '' }}</p>

      <div class="update-actions">
        <form method="dialog">
          <button type="submit" autofocus>{{ highlighted || activity ? '稍后' : '关闭' }}</button>
        </form>
        <button v-if="state.phase === 'ready'" type="button" @click="run('save')">另存更新包</button>
        <button v-if="state.phase === 'ready'" type="button" class="primary" @click="run('restart')">重启并更新</button>
        <button
          v-else-if="state.phase === 'available' && installable"
          type="button"
          class="primary"
          @click="run('download')"
        >
          下载更新 <span class="update-size">{{ (state.release.bytes / 1024 ** 2).toFixed(1) }} MB</span>
        </button>
        <button
          v-else-if="state.phase === 'available' && !installable"
          type="button"
          class="primary"
          @click="run('release')"
        >
          前往 GitHub 下载
        </button>
        <button v-else type="button" class="primary" :disabled="activity" @click="run('check')">检查更新</button>
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.update-dialog {
  width: min(560px, calc(100vw - 48px));
  max-height: calc(100dvh - 64px);
  padding: 24px;
  color: var(--el-text-color-primary);
  background: var(--el-bg-color-overlay);
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  box-shadow: var(--el-box-shadow-dark);
  overflow: auto;
  overscroll-behavior: contain;
}

.update-dialog::backdrop {
  background: rgb(0 0 0 / 48%);
  overflow: hidden;
  overscroll-behavior: contain;
}

.update-dialog h2 {
  margin: 0 0 8px;
  font-size: 20px;
  font-weight: 600;
}

.update-dialog h3 {
  margin: 16px 0 8px;
  font-size: 14px;
  font-weight: 600;
}

.update-version,
.update-restart-note {
  margin: 0;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.update-status {
  margin: 12px 0;
  font-size: 13px;
}

.update-notes {
  max-height: min(34vh, 280px);
  overflow: auto;
  margin: 0;
  padding: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.6;
}

.update-dialog progress {
  width: 100%;
  margin-top: 14px;
  accent-color: var(--el-color-primary);
}

.update-message:not(:empty) {
  color: var(--el-text-color-primary);
  margin: 10px 0 0;
  font-size: 13px;
}

.update-message:empty {
  margin: 0;
}

.update-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
}

.update-actions button,
.update-link {
  min-height: 32px;
  padding: 5px 12px;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  color: var(--el-text-color-primary);
  background: var(--el-bg-color);
  font-size: 13px;
  cursor: pointer;
}

.update-actions .primary {
  color: #fff;
  background: var(--el-color-primary-dark-2);
  border-color: var(--el-color-primary-dark-2);
}

.update-actions button:disabled {
  opacity: 0.55;
  cursor: default;
}

.update-link {
  border-color: transparent;
  background: transparent;
  padding-inline: 0;
  margin-bottom: 8px;
  text-decoration: underline;
  color: var(--el-text-color-secondary);
}

.update-size {
  margin-left: 4px;
  font-size: 12px;
}

.update-dialog :focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}
</style>
