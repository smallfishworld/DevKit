<script setup lang="ts">
/**
 * 分屏共享的快捷命令栏：两个终端成员只留这一条命令列表（命令库全局只有一份），
 * 命令发给当前选中的终端（见 composables/useTermMacroTargets）。
 * 宽度与折叠是整条共享栏自己的状态，与各终端自带栏互不影响。
 */
import { computed, ref, watch, watchEffect } from 'vue'
import { ArrowRight } from '@element-plus/icons-vue'
import QuickCmdManager from './QuickCmdManager.vue'
import { useSidebarDrag } from '../composables/useSidebarDrag'
import {
  getTermMacroTargets,
  pickTermMacroTarget,
  registerSharedRecordingFinisher,
  type TermMacroTarget
} from '../composables/useTermMacroTargets'
import type { QuickCmdStep } from '../../../shared/term-macro'
import { SPLIT_CMDS_DEFAULT_WIDTH, readSplitCmdsPrefs, writeSplitCmdsPrefs } from './split-tab'

const props = defineProps<{ members: { id: string; title: string }[] }>()
/** 折叠状态通知外层：收起时没有命令栏，选中终端的高亮线一并隐藏 */
const emit = defineEmits<{ (e: 'hidden-change', hidden: boolean): void }>()

const memberIds = computed(() => props.members.map((m) => m.id))
const target = computed<TermMacroTarget | undefined>(() => pickTermMacroTarget(memberIds.value))
const targetTitle = computed(() => props.members.find((m) => m.id === target.value?.panelId)?.title ?? '终端')
/** 各终端自带侧栏底部的提示（如 SSH 的明文密码提醒），换成共享栏后照常显示 */
const footnotes = computed(() =>
  [...new Set(getTermMacroTargets(memberIds.value).map((t) => t.footnote?.()).filter((t): t is string => !!t))]
)

/** 执行器始终是同一个函数：真正发给谁，在执行那一刻按选中的终端取 */
function runStep(st: QuickCmdStep): Promise<void> | void {
  return target.value?.writer(st)
}

const stored = readSplitCmdsPrefs()
/** 同 useSidebarDrag 的可拖范围，记忆值越界时先夹回来 */
const width = ref(Math.min(460, Math.max(150, stored.width ?? SPLIT_CMDS_DEFAULT_WIDTH)))
const hidden = ref(stored.hidden ?? false)
function save(patch: { width?: number; hidden?: boolean }): void {
  if (patch.width !== undefined) width.value = patch.width
  if (patch.hidden !== undefined) hidden.value = patch.hidden
  writeSplitCmdsPrefs({ width: width.value, hidden: hidden.value })
}
watch(hidden, (value) => emit('hidden-change', value), { immediate: true })
const { onMouseDown: onResize } = useSidebarDrag(width, (w) => save({ width: w }))
function toggle(): void {
  save({ hidden: !hidden.value })
}

// 串口工具栏的「停止录制」在共享栏存在时转给这里的列表实例
const manager = ref<InstanceType<typeof QuickCmdManager>>()
watchEffect((onCleanup) => onCleanup(
  registerSharedRecordingFinisher(memberIds.value, () => manager.value?.finishRecording())
))
</script>

<template>
  <aside v-if="!hidden" class="split-cmds" :style="{ width: width + 'px' }">
    <!-- 点进哪个终端，命令就发给哪个；这里标出当前是哪一个 -->
    <div class="split-cmds-target" title="快捷命令发送到当前选中的终端（点进哪个终端就发给哪个）">
      <i class="split-cmds-dot" aria-hidden="true"></i>
      <span>发送到</span>
      <b>{{ targetTitle }}</b>
    </div>
    <QuickCmdManager
      ref="manager"
      :enabled="target?.enabled() ?? false"
      :writer="runStep"
      :get-connection-generation="target?.getConnectionGeneration"
      :run-plugin-action="target?.runPluginAction"
      :get-plugin-actions="target?.getPluginActions"
      :plugin-config-version="target?.pluginConfigVersion?.()"
      @request-plugin-config="target?.requestPluginConfig?.()"
    />
    <p v-for="note in footnotes" :key="note" class="split-cmds-note">⚠ {{ note }}</p>

    <!-- 拖动调整宽度（与各终端自带栏一致）；中央折叠把手 -->
    <div class="split-cmds-resize" title="拖动调整宽度" @mousedown="onResize">
      <button class="split-cmds-toggle" title="折叠快捷命令栏" @mousedown.stop @click="toggle">
        <svg viewBox="0 0 8 12" width="7" height="10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6.5 1L1.5 6l5 5" />
        </svg>
      </button>
    </div>
  </aside>

  <!-- 折叠后的细条：点击展开（与串口/SSH/本地终端自带栏一致） -->
  <button v-else class="split-cmds-collapsed" title="展开快捷命令栏" @click="toggle">
    <el-icon :size="16"><ArrowRight /></el-icon>
  </button>
</template>

<style scoped>
/* 固定落在内容区网格第 1 行第 1 列（列结构见 global.css 的 .app-body） */
.split-cmds {
  grid-area: 1 / 1;
  position: relative;
  /* 压过右侧终端面板，调宽热区才点得到 */
  z-index: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  padding: 7px 12px 14px;
  overflow: hidden;
  background: var(--el-bg-color-overlay);
}

.split-cmds-collapsed {
  grid-area: 1 / 1;
  width: 16px;
  border: 0;
  border-right: 1px solid var(--el-border-color-lighter);
  background: transparent;
  color: var(--el-text-color-secondary);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.split-cmds-collapsed:hover {
  background: var(--el-fill-color);
  color: var(--el-color-primary);
}

.split-cmds-target {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  margin: 0 2px 7px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.split-cmds-target b {
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--el-color-primary);
  font-weight: 600;
}

.split-cmds-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--el-color-primary);
}

.split-cmds-note {
  flex: none;
  margin: 12px 2px 0;
  padding-top: 10px;
  border-top: 1px solid var(--el-border-color-lighter);
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}

.split-cmds-resize {
  position: absolute;
  top: 0;
  bottom: 0;
  right: -2px;
  width: 4px;
  cursor: col-resize;
  border-radius: 2px;
  transition: background 0.15s ease;
}

.split-cmds-resize:hover {
  background: var(--el-color-primary);
  opacity: 0.5;
}

.split-cmds-toggle {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  height: 32px;
  padding: 0;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--el-text-color-placeholder);
  opacity: 0.45;
  cursor: pointer;
  transition: opacity 0.15s ease, background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.split-cmds-resize:hover .split-cmds-toggle {
  opacity: 1;
}

.split-cmds-toggle:hover {
  background: var(--el-color-primary-light-9);
  border-color: var(--el-color-primary-light-7);
  color: var(--el-color-primary);
}
</style>
