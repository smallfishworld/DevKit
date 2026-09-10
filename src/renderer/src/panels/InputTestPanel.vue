<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import type { InputSelfTest, InputEventData } from '../../../shared/types'
import { vkName } from '../../../shared/keynames'

const props = defineProps<{ panelId: string }>()

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
    return `${data.down ? '↓按下' : '↑抬起'} ${mods ? mods + '+' : ''}${vkName(data.vk)} (VK 0x${data.vk
      .toString(16)
      .toUpperCase()})`
  }
  if (data.kind === 'mouse') {
    const btnName = { left: '左键', right: '右键', middle: '中键' }[data.button]
    if (data.action === 'move') return `移动 (${data.x}, ${data.y})`
    return `${data.action === 'down' ? '按下' : '抬起'} ${btnName} @(${data.x}, ${data.y})`
  }
  return `滚轮 ${data.delta > 0 ? '↑上' : '↓下'} (${data.x}, ${data.y})`
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

const VK_OPTIONS = [
  { label: 'A', value: 65 },
  { label: 'Enter', value: 13 },
  { label: 'Space', value: 32 },
  { label: 'Esc', value: 27 },
  { label: 'Tab', value: 9 },
  { label: 'F5', value: 116 },
  { label: 'Delete', value: 46 },
  { label: '方向上', value: 38 },
  { label: '方向下', value: 40 }
]

const lastResult = ref('')

async function doInject(action: string, payload: unknown, label: string): Promise<void> {
  try {
    const res = (await window.api.invoke('input', action, props.panelId, payload)) as {
      ok: boolean
    }
    lastResult.value = `${label}: ${res.ok ? '成功' : '失败（SendInput 被拒绝）'}`
  } catch (err) {
    lastResult.value = `${label}: 异常 ${String(err)}`
  }
}
</script>

<template>
  <div class="panel">
    <div class="panel-section">
      <h3>原生模块状态</h3>
      <div v-if="selfTest" class="panel-row">
        <el-tag :type="selfTest.koffiLoaded ? 'success' : 'danger'">
          koffi {{ selfTest.koffiLoaded ? '加载正常' : '加载失败' }}
        </el-tag>
        <el-tag :type="selfTest.sendInputResolved ? 'success' : 'danger'">
          SendInput {{ selfTest.sendInputResolved ? '可用' : '不可用' }}
        </el-tag>
        <el-tag :type="selfTest.inputStructSize === 40 ? 'success' : 'warning'">
          sizeof(INPUT) = {{ selfTest.inputStructSize }}（x64 应为 40）
        </el-tag>
        <el-tag :type="selfTest.uiohookLoaded ? 'success' : 'danger'">
          uiohook {{ selfTest.uiohookLoaded ? '加载正常' : '加载失败' }}
        </el-tag>
        <span v-if="selfTest.error" style="color: var(--el-color-danger)">
          {{ selfTest.error }}
        </span>
      </div>
      <el-skeleton v-else :rows="1" animated style="width: 400px" />
    </div>

    <div class="panel-section">
      <h3>全局事件捕获</h3>
      <div class="panel-row" style="margin-bottom: 10px">
        <el-button v-if="!capturing" type="primary" @click="startCapture">开始捕获</el-button>
        <el-button v-else type="danger" @click="stopCapture">停止捕获</el-button>
        <el-checkbox v-model="ignoreMoves">忽略鼠标移动（只记录点击/按键）</el-checkbox>
        <el-button text @click="clearEvents">清空</el-button>
        <el-tag>累计 {{ total }} 个事件</el-tag>
        <span v-if="capturing" style="color: var(--el-color-warning); font-size: 12px">
          正在捕获全局键鼠，切到任意窗口按键盘试试
        </span>
      </div>
      <el-table :data="events" height="300" size="small" style="width: 100%">
        <el-table-column prop="seq" label="#" width="70" />
        <el-table-column prop="kind" label="类型" width="90" />
        <el-table-column prop="desc" label="事件" min-width="280" />
        <el-table-column prop="delta" label="间隔" width="90" />
      </el-table>
    </div>

    <div class="panel-section">
      <h3>事件注入</h3>
      <div style="font-size: 12px; color: var(--el-text-color-secondary); margin-bottom: 10px">
        注入目标是当前拥有焦点的窗口。建议先打开一个记事本，再把本窗口摆在旁边点击按钮。
      </div>
      <div class="panel-row" style="margin-bottom: 8px">
        <span>X</span>
        <el-input-number v-model="injX" :min="0" :max="7680" size="small" />
        <span>Y</span>
        <el-input-number v-model="injY" :min="0" :max="4320" size="small" />
        <el-button size="small" @click="doInject('inject:move', { x: injX, y: injY }, '移动光标')">
          移动光标
        </el-button>
        <el-button
          size="small"
          type="primary"
          @click="doInject('inject:click', { x: injX, y: injY }, '左键点击')"
        >
          左键点击
        </el-button>
        <el-button
          size="small"
          @click="doInject('inject:click', { x: injX, y: injY, button: 'right' }, '右键点击')"
        >
          右键点击
        </el-button>
      </div>
      <div class="panel-row">
        <el-select v-model="injVk" size="small" style="width: 110px">
          <el-option v-for="opt in VK_OPTIONS" :key="opt.value" :label="opt.label" :value="opt.value" />
        </el-select>
        <el-button size="small" @click="doInject('inject:key', { vk: injVk }, '轻敲按键')">
          轻敲按键
        </el-button>
        <el-input v-model="injText" size="small" style="width: 240px" />
        <el-button size="small" @click="doInject('inject:text', { text: injText }, '注入文本')">
          打字
        </el-button>
        <span v-if="lastResult" style="font-size: 12px; margin-left: 8px">{{ lastResult }}</span>
      </div>
    </div>
  </div>
</template>
