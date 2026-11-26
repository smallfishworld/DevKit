<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { InputSelfTest, InputEventData } from '../../../shared/types'
import { vkName } from '../../../shared/keynames'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ panelId: string }>()
const { t } = useI18n()

// ---------- 原生模块状态 ----------
const selfTest = ref<InputSelfTest | null>(null)

onMounted(async () => {
  selfTest.value = (await window.api.invoke('input', 'selftest', props.panelId)) as InputSelfTest
})

// ---------- 事件捕获 ----------
interface DisplayEvent {
  seq: number
  kind: string
  desc: string
  delta: string
}

const capturing = ref(false)
const ignoreMoves = ref(true)
const total = ref(0)
const events = ref<DisplayEvent[]>([])
let lastTime = 0
let seq = 0

function describe(data: InputEventData): string {
  if (data.kind === 'key') {
    const mods = [
      data.ctrl ? 'Ctrl' : '',
      data.alt ? 'Alt' : '',
      data.shift ? 'Shift' : '',
      data.meta ? 'Win' : ''
    ]
      .filter(Boolean)
      .join('+')
    return `${t(data.down ? 'inputTest.pressed' : 'inputTest.released')} ${mods ? mods + '+' : ''}${vkName(data.vk)} (VK 0x${data.vk
      .toString(16)
      .toUpperCase()})`
  }
  if (data.kind === 'mouse') {
    const btnName = t(`inputTest.${data.button}Button`)
    if (data.action === 'move') return t('inputTest.move', { x: data.x, y: data.y })
    return t('inputTest.mouseAction', { action: t(data.action === 'down' ? 'inputTest.pressed' : 'inputTest.released'), button: btnName, x: data.x, y: data.y })
  }
  return t('inputTest.wheel', { direction: t(data.delta > 0 ? 'inputTest.wheelUp' : 'inputTest.wheelDown'), x: data.x, y: data.y })
}

function onInput(payload: unknown): void {
  const data = payload as InputEventData
  total.value += 1
  const now = Date.now()
  const delta = lastTime === 0 ? '-' : `${now - lastTime}ms`
  lastTime = now
  seq += 1
  events.value.unshift({ seq, kind: data.kind, desc: describe(data), delta })
  if (events.value.length > 200) events.value.pop()
}

let unsub: (() => void) | null = null

async function startCapture(): Promise<void> {
  await window.api.invoke('input', 'capture:start', props.panelId, {
    ignoreMoves: ignoreMoves.value
  })
  capturing.value = true
  unsub = window.api.on('input', props.panelId, 'input', onInput)
}

async function stopCapture(): Promise<void> {
  await window.api.invoke('input', 'capture:stop', props.panelId)
  capturing.value = false
  unsub?.()
  unsub = null
}

function clearEvents(): void {
  events.value = []
  total.value = 0
  lastTime = 0
}

onUnmounted(() => {
  unsub?.()
  window.api.invoke('input', 'dispose', props.panelId).catch(() => {})
})

// ---------- 注入测试 ----------
const injX = ref(100)
const injY = ref(100)
const injText = ref('Hello DevKit!')
const injVk = ref(65)

const VK_OPTIONS = computed(() => [
  { label: 'A', value: 65 },
  { label: 'Enter', value: 13 },
  { label: 'Space', value: 32 },
  { label: 'Esc', value: 27 },
  { label: 'Tab', value: 9 },
  { label: 'F5', value: 116 },
  { label: 'Delete', value: 46 },
  { label: t('inputTest.up'), value: 38 },
  { label: t('inputTest.down'), value: 40 }
])

const lastResult = ref('')

async function doInject(action: string, payload: unknown, label: string): Promise<void> {
  try {
    const res = (await window.api.invoke('input', action, props.panelId, payload)) as {
      ok: boolean
    }
    lastResult.value = `${label}: ${res.ok ? t('extraCommon.success') : t('inputTest.rejected')}`
  } catch (err) {
    lastResult.value = `${label}: ${t('extraCommon.error', { error: String(err) })}`
  }
}
</script>

<template>
  <div class="panel converter-page">
    <header class="converter-head">
      <div>
        <h1>{{ t('inputTest.title') }}</h1>
        <p>{{ t('inputTest.subtitle') }}</p>
      </div>
    </header>

    <div class="panel-section">
      <h3>{{ t('inputTest.nativeStatus') }}</h3>
      <div v-if="selfTest" class="panel-row">
        <el-tag size="small" :type="selfTest.koffiLoaded ? 'success' : 'danger'">
          koffi {{ t(selfTest.koffiLoaded ? 'inputTest.loaded' : 'inputTest.loadFailed') }}
        </el-tag>
        <el-tag size="small" :type="selfTest.sendInputResolved ? 'success' : 'danger'">
          SendInput {{ t(selfTest.sendInputResolved ? 'inputTest.available' : 'inputTest.unavailable') }}
        </el-tag>
        <el-tag size="small" :type="selfTest.inputStructSize === 40 ? 'success' : 'warning'">
          sizeof(INPUT) = {{ selfTest.inputStructSize }}{{ t('inputTest.expectedSize') }}
        </el-tag>
        <el-tag size="small" :type="selfTest.uiohookLoaded ? 'success' : 'danger'">
          uiohook {{ t(selfTest.uiohookLoaded ? 'inputTest.loaded' : 'inputTest.loadFailed') }}
        </el-tag>
        <span v-if="selfTest.error" class="err-text">
          {{ selfTest.error }}
        </span>
      </div>
      <el-skeleton v-else :rows="1" animated class="skeleton-bar" />
    </div>

    <div class="panel-section">
      <h3>{{ t('inputTest.captureTitle') }}</h3>
      <div class="panel-row mb-12">
        <el-button v-if="!capturing" size="small" type="primary" @click="startCapture">{{ t('inputTest.startCapture') }}</el-button>
        <el-button v-else size="small" type="danger" @click="stopCapture">{{ t('inputTest.stopCapture') }}</el-button>
        <el-checkbox v-model="ignoreMoves" size="small">{{ t('inputTest.ignoreMoves') }}</el-checkbox>
        <el-button size="small" text @click="clearEvents">{{ t('extraCommon.clear') }}</el-button>
        <el-tag size="small">{{ t('inputTest.total', { count: total }) }}</el-tag>
        <span v-if="capturing" class="warn-hint">
          {{ t('inputTest.capturingHint') }}
        </span>
      </div>
      <el-table :data="events" height="300" size="small" class="full-w">
        <el-table-column prop="seq" label="#" width="70" />
        <el-table-column prop="kind" :label="t('inputTest.type')" width="90" />
        <el-table-column prop="desc" :label="t('inputTest.event')" min-width="280" />
        <el-table-column prop="delta" :label="t('inputTest.interval')" width="90" />
      </el-table>
    </div>

    <div class="panel-section">
      <h3>{{ t('inputTest.injectionTitle') }}</h3>
      <div class="hint mb-12">
        {{ t('inputTest.injectionHint') }}
      </div>
      <div class="panel-row mb-8">
        <span class="lbl">X</span>
        <el-input-number v-model="injX" :min="0" :max="7680" size="small" />
        <span class="lbl">Y</span>
        <el-input-number v-model="injY" :min="0" :max="4320" size="small" />
        <el-button size="small" @click="doInject('inject:move', { x: injX, y: injY }, t('inputTest.moveCursor'))">
          {{ t('inputTest.moveCursor') }}
        </el-button>
        <el-button
          size="small"
          type="primary"
          @click="doInject('inject:click', { x: injX, y: injY }, t('inputTest.leftClick'))"
        >
          {{ t('inputTest.leftClick') }}
        </el-button>
        <el-button
          size="small"
          @click="doInject('inject:click', { x: injX, y: injY, button: 'right' }, t('inputTest.rightClick'))"
        >
          {{ t('inputTest.rightClick') }}
        </el-button>
      </div>
      <div class="panel-row">
        <el-select v-model="injVk" size="small" class="vk-select">
          <el-option v-for="opt in VK_OPTIONS" :key="opt.value" :label="opt.label" :value="opt.value" />
        </el-select>
        <el-button size="small" @click="doInject('inject:key', { vk: injVk }, t('inputTest.tapKey'))">
          {{ t('inputTest.tapKey') }}
        </el-button>
        <el-input v-model="injText" size="small" class="text-input" />
        <el-button size="small" @click="doInject('inject:text', { text: injText }, t('inputTest.injectText'))">
          {{ t('inputTest.typeText') }}
        </el-button>
        <span v-if="lastResult" class="result-text">{{ lastResult }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mb-12 {
  margin-bottom: 12px;
}

.mb-8 {
  margin-bottom: 8px;
}

.full-w {
  width: 100%;
}

.skeleton-bar {
  width: 400px;
}

.lbl,
.hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.warn-hint {
  font-size: 12px;
  color: var(--el-color-warning);
}

.err-text {
  font-size: 12px;
  color: var(--el-color-danger);
}

.vk-select {
  width: 110px;
}

.text-input {
  width: 240px;
}

.result-text {
  font-size: 12px;
  margin-left: 8px;
}
</style>
