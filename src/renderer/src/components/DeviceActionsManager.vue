<script setup lang="ts">
/**
 * 设备动作配置管理器：可视化编辑 device-actions.json。
 * 表单页签负责日常配置，高级 JSON 页签兜底全部字段；保存由主进程统一校验并原子写入。
 */
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, FolderOpened, Plus, Refresh } from '@element-plus/icons-vue'
import type {
  DeviceActionDetect,
  DeviceActionHold,
  DeviceActionProfile,
  DeviceActionResult,
  DeviceActionsConfig
} from '../../../shared/device-actions'
import { createDeviceActionProfile, createDeviceActionsExample } from '../../../shared/device-actions'

const props = defineProps<{
  visible: boolean
  panelId: string
  /** 从「快捷命令 → 设备动作步骤」打开时直接落到动作列表 */
  initialTab?: 'global' | 'profiles'
}>()
const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'saved'): void
}>()

const visible = computed({
  get: () => props.visible,
  set: (value: boolean) => emit('update:visible', value)
})

interface InfoResult {
  path: string
  exists: boolean
  text?: string
  config?: DeviceActionsConfig
  error?: string
}
interface SaveResult { ok: boolean; path?: string; error?: string }
interface ValidateResult { ok: boolean; config?: DeviceActionsConfig; error?: string }

type Tab = 'global' | 'profiles' | 'json'

const tab = ref<Tab>('global')
const loading = ref(false)
const saving = ref(false)
const path = ref('')
const exists = ref(false)
const loadError = ref('')
const draft = ref<DeviceActionsConfig | null>(null)
const jsonText = ref('')
const jsonError = ref('')
const jsonDirty = ref(false)
const profileExpanded = ref<string[]>(['0'])
let profileSeq = 0

const globalForm = reactive({
  loginUrl: '',
  authOrigins: '',
  authCheckType: 'json' as 'json' | 'http-ok',
  authCheckUrl: '',
  authCheckField: 'authenticated',
  issueUrl: '',
  issueBody: [] as { key: string; value: string }[],
  responsePath: 'response',
  loginExpiredHttp: '401, 403',
  loginExpiredCodes: '',
  retryLoginOnce: true,
  userAgent: ''
})

function call<T>(action: string, payload?: unknown): Promise<T> {
  return window.api.invoke('serial', action, props.panelId, payload) as Promise<T>
}

/** 把 Vue 响应式代理脱壳成可结构化克隆的普通对象。 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function splitLines(value: string): string[] {
  return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean)
}

function splitCsv(value: string): string[] {
  return value.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean)
}

function parseHttpCodes(value: string): number[] {
  return splitCsv(value).map(Number).filter((code) => Number.isInteger(code))
}

function syncGlobal(): void {
  const config = draft.value
  if (!config) return
  globalForm.loginUrl = config.loginUrl
  globalForm.authOrigins = config.authOrigins.join('\n')
  globalForm.authCheckType = config.authCheck.type
  globalForm.authCheckUrl = config.authCheck.url
  globalForm.authCheckField = config.authCheck.type === 'json' ? config.authCheck.field : 'authenticated'
  globalForm.issueUrl = config.issue.url
  globalForm.issueBody = Object.entries(config.issue.body).map(([key, value]) => ({ key, value }))
  globalForm.responsePath = config.issue.responsePath
  globalForm.loginExpiredHttp = config.issue.loginExpiredHttp.join(', ')
  globalForm.loginExpiredCodes = config.issue.loginExpiredCodes.join(', ')
  globalForm.retryLoginOnce = config.issue.retryLoginOnce
  globalForm.userAgent = config.issue.userAgent ?? ''
}

function buildConfig(): DeviceActionsConfig {
  const base = draft.value
  if (!base) throw new Error('尚未创建设备动作配置')
  const body: Record<string, string> = {}
  for (const row of globalForm.issueBody) {
    const key = row.key.trim()
    if (key) body[key] = row.value
  }
  return {
    ...base,
    loginUrl: globalForm.loginUrl.trim(),
    authOrigins: splitLines(globalForm.authOrigins),
    authCheck: globalForm.authCheckType === 'json'
      ? {
          type: 'json',
          url: globalForm.authCheckUrl.trim(),
          field: globalForm.authCheckField.trim() || 'authenticated'
        }
      : { type: 'http-ok', url: globalForm.authCheckUrl.trim() },
    issue: {
      ...base.issue,
      url: globalForm.issueUrl.trim(),
      body,
      responsePath: globalForm.responsePath.trim() || 'response',
      loginExpiredHttp: parseHttpCodes(globalForm.loginExpiredHttp),
      loginExpiredCodes: splitCsv(globalForm.loginExpiredCodes),
      retryLoginOnce: globalForm.retryLoginOnce,
      userAgent: globalForm.userAgent.trim() || undefined
    }
  }
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  jsonError.value = ''
  try {
    const info = await call<InfoResult>('device-config:info')
    path.value = info.path
    exists.value = info.exists
    if (info.config) {
      draft.value = info.config
      syncGlobal()
      jsonText.value = JSON.stringify(info.config, null, 2)
      jsonDirty.value = false
      profileExpanded.value = info.config.profiles.length ? ['0'] : []
    } else {
      draft.value = null
      jsonText.value = info.text ?? ''
      loadError.value = info.error ?? ''
    }
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '无法读取设备动作配置'
  } finally {
    loading.value = false
  }
}

watch(() => props.visible, (value) => {
  if (!value) return
  tab.value = props.initialTab ?? 'global'
  profileSeq = 0
  void load()
})

watch(tab, (value) => {
  if (value === 'json' && !jsonDirty.value && draft.value) {
    try { jsonText.value = JSON.stringify(buildConfig(), null, 2) } catch { /* 表单未就绪时保留原文 */ }
  }
})

function createExample(): void {
  draft.value = createDeviceActionsExample()
  syncGlobal()
  jsonText.value = JSON.stringify(draft.value, null, 2)
  jsonDirty.value = false
  profileExpanded.value = ['0']
  loadError.value = ''
  jsonError.value = ''
  // 创建后直接展示动作列表，新增/删除入口就在眼前
  tab.value = 'profiles'
}

async function openDir(): Promise<void> {
  const result = await call<SaveResult>('device-config:open-dir')
  if (!result.ok) ElMessage.warning(result.error ?? '无法打开配置目录')
}

async function save(): Promise<void> {
  if (!draft.value && !jsonText.value.trim()) return
  saving.value = true
  jsonError.value = ''
  try {
    let config: unknown
    if (!draft.value || tab.value === 'json') {
      try {
        config = JSON.parse(jsonText.value)
      } catch (error) {
        jsonError.value = `JSON 语法错误：${(error as Error).message}`
        return
      }
    } else {
      config = buildConfig()
    }
    const result = await call<SaveResult>('device-config:save', { config: plain(config) })
    if (!result.ok) {
      ElMessage.error(result.error ?? '保存失败')
      if (tab.value === 'json') jsonError.value = result.error ?? '保存失败'
      return
    }
    ElMessage.success('设备动作配置已保存')
    emit('saved')
    await load()
    tab.value = 'global'
  } catch (error) {
    const message = error instanceof Error ? error.message : '保存失败'
    ElMessage.error(message)
    if (tab.value === 'json') jsonError.value = message
  } finally {
    saving.value = false
  }
}

function addProfile(trigger: 'manual' | 'auto'): void {
  if (!draft.value) return
  profileSeq++
  const id = `${trigger === 'auto' ? 'auto' : 'action'}-${Date.now().toString(36)}${profileSeq}`
  draft.value.profiles.push(createDeviceActionProfile(trigger, id))
  profileExpanded.value = [...profileExpanded.value, String(draft.value.profiles.length - 1)]
}

async function removeProfile(index: number): Promise<void> {
  if (!draft.value) return
  try {
    await ElMessageBox.confirm(
      '删除后引用该 ID 的快捷命令将无法回放，确定删除此设备动作？', '删除设备动作', { type: 'warning' }
    )
  } catch {
    return
  }
  draft.value.profiles.splice(index, 1)
}

function setTrigger(profile: DeviceActionProfile, trigger: 'manual' | 'auto'): void {
  profile.trigger = trigger
  if (trigger === 'manual') {
    profile.command ||= 'debug'
    profile.holdInput = false
  } else {
    if (!profile.triggerWords.length) profile.triggerWords = ['debug']
    if (profile.holdInput === false) profile.holdInput = { maxBytes: 4096, maxMs: 15_000 }
  }
}

function setDetect(profile: DeviceActionProfile, type: DeviceActionDetect['type']): void {
  profile.detect = type === 'prefix'
    ? { type: 'prefix', prefix: 'Challenge:' }
    : { type: 'base64-line', shortMin: 20, shortMax: 21, longMin: 300, longMinDecoded: 260 }
}

function setResult(profile: DeviceActionProfile, type: DeviceActionResult['type']): void {
  profile.result = type === 'line'
    ? { type: 'line', successLine: 'Debug unlocked', failureLine: 'Debug denied' }
    : { type: 'prompt-repeat', promptText: 'Password:', decisionDelayMs: 150, silenceMs: 3000 }
}

function setHold(profile: DeviceActionProfile, enabled: boolean): void {
  profile.holdInput = enabled ? { maxBytes: 4096, maxMs: 15_000 } : false
}

function setTriggerWords(profile: DeviceActionProfile, value: string): void {
  profile.triggerWords = splitCsv(value)
}

function holdLimits(profile: DeviceActionProfile): DeviceActionHold | undefined {
  return profile.holdInput === false ? undefined : profile.holdInput
}

function generateJson(): void {
  if (!draft.value) return
  try {
    jsonText.value = JSON.stringify(buildConfig(), null, 2)
    jsonDirty.value = false
    jsonError.value = ''
  } catch (error) {
    jsonError.value = (error as Error).message
  }
}

function formatJson(): void {
  try {
    jsonText.value = JSON.stringify(JSON.parse(jsonText.value), null, 2)
    jsonDirty.value = true
    jsonError.value = ''
  } catch (error) {
    jsonError.value = `JSON 语法错误：${(error as Error).message}`
  }
}

async function applyJson(): Promise<void> {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText.value)
  } catch (error) {
    jsonError.value = `JSON 语法错误：${(error as Error).message}`
    return
  }
  const result = await call<ValidateResult>('device-config:validate', { config: parsed })
  if (!result.ok || !result.config) {
    jsonError.value = result.error ?? '配置校验失败'
    return
  }
  jsonError.value = ''
  draft.value = result.config
  syncGlobal()
  jsonText.value = JSON.stringify(result.config, null, 2)
  jsonDirty.value = false
  tab.value = 'global'
  ElMessage.success('已应用到表单')
}
</script>

<template>
  <el-dialog
    v-model="visible"
    title="设备动作配置"
    width="900px"
    top="5vh"
    append-to-body
    :close-on-click-modal="false"
  >
    <div class="config-head">
      <div class="path" :title="path">{{ path || 'device-actions.json' }}</div>
      <el-button size="small" text :icon="FolderOpened" @click="openDir">打开文件夹</el-button>
      <el-button size="small" text :icon="Refresh" :loading="loading" @click="load">重新读取</el-button>
    </div>

    <el-alert
      v-if="loadError"
      type="warning"
      :closable="false"
      :title="loadError"
      description="可在下方直接修复后保存，或改用示例配置。"
      class="load-alert"
    />

    <div v-if="loading && !draft" class="empty">正在读取配置…</div>

    <div v-else-if="!draft && loadError" class="body">
      <div class="json-head">
        <span class="hint">原配置文件无法解析，可直接修复下面的内容后保存；也可以改用示例配置。</span>
        <el-button size="small" @click="createExample">改用示例配置</el-button>
      </div>
      <el-input
        v-model="jsonText"
        type="textarea"
        :rows="18"
        spellcheck="false"
        class="json-area"
        @input="jsonDirty = true"
      />
      <el-alert v-if="jsonError" type="error" :title="jsonError" :closable="false" class="json-error" />
    </div>

    <div v-else-if="!draft" class="empty">
      <p>尚未配置设备动作。</p>
      <p class="hint">
        创建示例后会填入一组可运行的结构，并打开「动作列表」；
        在那里的「新增手动动作 / 新增自动应答」可增加任意条设备动作。
      </p>
      <el-button type="primary" @click="createExample">创建示例配置</el-button>
    </div>

    <div v-else class="body">
      <el-tabs v-model="tab">
        <el-tab-pane label="OA 与取码接口" name="global">
          <el-form label-width="132px" size="small" class="form" @submit.prevent>
            <el-form-item label="OA 登录入口">
              <el-input v-model="globalForm.loginUrl" placeholder="https://oa.example.com/login" />
              <div class="hint">登录状态检查和取码接口必须与它同源。</div>
            </el-form-item>
            <el-form-item label="允许跳转来源">
              <el-input
                v-model="globalForm.authOrigins"
                type="textarea"
                :rows="2"
                placeholder="每行一个来源，如 https://sso.example.com；SSO 的 http:// 回跳地址也可填写"
              />
            </el-form-item>
            <el-form-item label="登录状态检查">
              <el-radio-group v-model="globalForm.authCheckType">
                <el-radio value="json">接口字段为 true</el-radio>
                <el-radio value="http-ok">返回 2xx 即已登录</el-radio>
              </el-radio-group>
            </el-form-item>
            <el-form-item label="检查地址">
              <el-input v-model="globalForm.authCheckUrl" placeholder="https://oa.example.com/api/session" />
            </el-form-item>
            <el-form-item v-if="globalForm.authCheckType === 'json'" label="登录状态字段">
              <el-input v-model="globalForm.authCheckField" placeholder="authenticated（支持 data.ok 这样点路径）" />
            </el-form-item>

            <el-divider content-position="left">取码接口</el-divider>
            <el-form-item label="取码地址">
              <el-input v-model="globalForm.issueUrl" placeholder="https://oa.example.com/api/device/token" />
            </el-form-item>
            <el-form-item label="请求体字段">
              <div class="rows">
                <div v-for="(row, index) in globalForm.issueBody" :key="index" class="row">
                  <el-input v-model="row.key" placeholder="字段名" class="key-input" />
                  <el-input v-model="row.value" placeholder="值；用 $challenge 代表设备挑战码" />
                  <el-button text :icon="Delete" title="删除字段" @click="globalForm.issueBody.splice(index, 1)" />
                </div>
                <el-button text :icon="Plus" @click="globalForm.issueBody.push({ key: '', value: '' })">
                  添加字段
                </el-button>
                <div class="hint">至少一个字段的值必须包含 $challenge。</div>
              </div>
            </el-form-item>
            <el-form-item label="口令字段路径">
              <el-input v-model="globalForm.responsePath" placeholder="response 或 data.data" />
            </el-form-item>
            <el-form-item label="登录失效 HTTP">
              <el-input v-model="globalForm.loginExpiredHttp" placeholder="401, 403" />
            </el-form-item>
            <el-form-item label="登录失效业务码">
              <el-input v-model="globalForm.loginExpiredCodes" placeholder="003, 403003（可留空）" />
            </el-form-item>
            <el-form-item label="失效后重登一次">
              <el-switch v-model="globalForm.retryLoginOnce" />
            </el-form-item>
            <el-form-item label="User-Agent">
              <el-input v-model="globalForm.userAgent" placeholder="留空使用内嵌浏览器 UA" />
            </el-form-item>
          </el-form>
        </el-tab-pane>

        <el-tab-pane label="动作列表" name="profiles">
          <div class="profile-toolbar">
            <el-button size="small" :icon="Plus" @click="addProfile('manual')">新增手动动作</el-button>
            <el-button size="small" :icon="Plus" @click="addProfile('auto')">新增自动应答</el-button>
            <span class="hint toolbar-hint">手动动作出现在快捷命令步骤中；自动应答由串口面板勾选后常驻监听。</span>
          </div>
          <el-empty v-if="!draft.profiles.length" description="至少添加一个设备动作后才能保存" />

          <el-collapse v-model="profileExpanded">
            <el-collapse-item v-for="(profile, index) in draft.profiles" :key="index" :name="String(index)">
              <template #title>
                <span class="profile-title">{{ profile.label || profile.id || '未命名动作' }}</span>
                <el-tag size="small" :type="profile.trigger === 'auto' ? 'warning' : 'info'" effect="plain">
                  {{ profile.trigger === 'auto' ? '自动应答' : '手动' }}
                </el-tag>
              </template>

              <el-form label-width="132px" size="small" @submit.prevent>
                <el-form-item label="唯一 ID">
                  <el-input v-model="profile.id" placeholder="如 debug-unlock" />
                  <div class="hint">快捷命令和配置引用此 ID；修改后已有宏会找不到该动作。</div>
                </el-form-item>
                <el-form-item label="配置名称">
                  <el-input v-model="profile.label" placeholder="显示在步骤选择器中" />
                </el-form-item>
                <el-form-item label="动作名称">
                  <el-input v-model="profile.actionLabel" placeholder="显示在步骤与状态里的动作名" />
                </el-form-item>
                <el-form-item label="触发方式">
                  <el-radio-group
                    :model-value="profile.trigger"
                    @change="(value: string | number | boolean | undefined) => setTrigger(profile, value === 'auto' ? 'auto' : 'manual')"
                  >
                    <el-radio value="manual">快捷命令手动触发</el-radio>
                    <el-radio value="auto">串口自动应答</el-radio>
                  </el-radio-group>
                </el-form-item>
                <el-form-item v-if="profile.trigger === 'manual'" label="起始命令">
                  <el-input v-model="profile.command" placeholder="如 debug" />
                  <div class="hint">DevKit 先发送这条命令，再从设备输出中读取挑战码。</div>
                </el-form-item>
                <el-form-item v-else label="触发词">
                  <el-input
                    :model-value="profile.triggerWords.join(', ')"
                    placeholder="如 debug, zhimakaimen"
                    @update:model-value="(value: string) => setTriggerWords(profile, value)"
                  />
                  <div class="hint">设备回显整行等于触发词时开始扣住用户输入；大小写敏感。</div>
                </el-form-item>

                <el-form-item label="挑战码识别">
                  <el-radio-group
                    :model-value="profile.detect.type"
                    @change="(value: string | number | boolean | undefined) => setDetect(profile, value === 'base64-line' ? 'base64-line' : 'prefix')"
                  >
                    <el-radio value="prefix">固定前缀</el-radio>
                    <el-radio value="base64-line">裸 base64 码行</el-radio>
                  </el-radio-group>
                </el-form-item>
                <el-form-item v-if="profile.detect.type === 'prefix'" label="行首前缀">
                  <el-input v-model="profile.detect.prefix" placeholder="如 Challenge:" />
                </el-form-item>
                <template v-else>
                  <el-form-item label="短码长度">
                    <el-input-number v-model="profile.detect.shortMin" :min="8" :max="256" />
                    <span class="range-sep">至</span>
                    <el-input-number v-model="profile.detect.shortMax" :min="8" :max="512" />
                  </el-form-item>
                  <el-form-item label="长码阈值">
                    <el-input-number v-model="profile.detect.longMin" :min="8" :max="8192" :step="16" />
                    <span class="range-sep">字符，解码至少</span>
                    <el-input-number v-model="profile.detect.longMinDecoded" :min="16" :max="8192" :step="16" />
                    <span class="range-sep">字节</span>
                  </el-form-item>
                </template>

                <el-form-item label="结果判定">
                  <el-radio-group
                    :model-value="profile.result.type"
                    @change="(value: string | number | boolean | undefined) => setResult(profile, value === 'prompt-repeat' ? 'prompt-repeat' : 'line')"
                  >
                    <el-radio value="line">设备打印成功/失败行</el-radio>
                    <el-radio value="prompt-repeat">重新索要口令即失败</el-radio>
                  </el-radio-group>
                </el-form-item>
                <template v-if="profile.result.type === 'line'">
                  <el-form-item label="成功行">
                    <el-input v-model="profile.result.successLine" placeholder="Debug unlocked" />
                  </el-form-item>
                  <el-form-item label="失败行">
                    <el-input v-model="profile.result.failureLine" placeholder="Debug denied" />
                  </el-form-item>
                  <el-form-item label="结果超时">
                    <el-input-number v-model="profile.resultTimeoutMs" :min="100" :max="300000" :step="500" />
                    <span class="range-sep">毫秒</span>
                  </el-form-item>
                </template>
                <template v-else>
                  <el-form-item label="拒绝提示">
                    <el-input v-model="profile.result.promptText" placeholder="Password:" />
                    <div class="hint">注入口令后设备再次出现该提示即判定失败。</div>
                  </el-form-item>
                  <el-form-item label="观察窗">
                    <el-input-number v-model="profile.result.decisionDelayMs" :min="0" :max="2000" :step="50" />
                    <span class="range-sep">毫秒</span>
                  </el-form-item>
                  <el-form-item label="静默视为成功">
                    <el-input-number v-model="profile.result.silenceMs" :min="100" :max="30000" :step="100" />
                    <span class="range-sep">毫秒</span>
                  </el-form-item>
                </template>

                <el-form-item label="换行符">
                  <el-select v-model="profile.newline" style="width: 160px">
                    <el-option value="cr" label="CR (\\r)" />
                    <el-option value="lf" label="LF (\\n)" />
                    <el-option value="crlf" label="CRLF (\\r\\n)" />
                  </el-select>
                </el-form-item>
                <el-form-item label="挑战码超时">
                  <el-input-number v-model="profile.challengeTimeoutMs" :min="100" :max="300000" :step="500" />
                  <span class="range-sep">毫秒</span>
                </el-form-item>
                <el-form-item label="挑战码有效期">
                  <el-input-number v-model="profile.challengeTtlMs" :min="100" :max="300000" :step="1000" />
                  <span class="range-sep">毫秒</span>
                </el-form-item>

                <el-form-item v-if="profile.trigger === 'auto'" label="动作期间扣住输入">
                  <el-switch :model-value="holdLimits(profile) !== undefined" @change="(value: string | number | boolean) => setHold(profile, value === true)" />
                  <template v-if="holdLimits(profile)">
                    <el-input-number
                      :model-value="holdLimits(profile)?.maxBytes"
                      :min="256"
                      :max="1048576"
                      :step="256"
                      @update:model-value="(value: number | undefined) => { const hold = holdLimits(profile); if (hold && value !== undefined) hold.maxBytes = value }"
                    />
                    <span class="range-sep">字节，最多</span>
                    <el-input-number
                      :model-value="holdLimits(profile)?.maxMs"
                      :min="1000"
                      :max="300000"
                      :step="1000"
                      @update:model-value="(value: number | undefined) => { const hold = holdLimits(profile); if (hold && value !== undefined) hold.maxMs = value }"
                    />
                    <span class="range-sep">毫秒</span>
                  </template>
                </el-form-item>
              </el-form>

              <el-button text type="danger" :icon="Delete" class="remove-profile" @click="removeProfile(index)">
                删除此设备动作
              </el-button>
            </el-collapse-item>
          </el-collapse>
        </el-tab-pane>

        <el-tab-pane label="高级 JSON" name="json">
          <div class="json-head">
            <span class="hint">直接编辑完整配置；保存时同样会校验。切到表单页会丢弃未应用的修改。</span>
            <span>
              <el-button size="small" @click="generateJson">从表单生成</el-button>
              <el-button size="small" @click="applyJson">应用到表单</el-button>
              <el-button size="small" @click="formatJson">格式化</el-button>
            </span>
          </div>
          <el-input
            v-model="jsonText"
            type="textarea"
            :rows="20"
            spellcheck="false"
            class="json-area"
            @input="jsonDirty = true"
          />
          <el-alert v-if="jsonError" type="error" :title="jsonError" :closable="false" class="json-error" />
        </el-tab-pane>
      </el-tabs>
    </div>

    <template #footer>
      <span v-if="path" class="footer-path">{{ exists ? '配置文件：' : '保存后创建：' }}{{ path }}</span>
      <el-button @click="visible = false">关闭</el-button>
      <el-button type="primary" :loading="saving" :disabled="!draft && !jsonText.trim()" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.config-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.path {
  flex: 1;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--el-text-color-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.load-alert {
  margin-bottom: 10px;
}

.empty {
  padding: 48px 0;
  color: var(--el-text-color-secondary);
  text-align: center;
}

.empty > p {
  margin: 0 0 8px;
}

.body {
  max-height: 62vh;
  overflow-y: auto;
  padding-right: 4px;
}

.hint {
  margin-top: 2px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.rows {
  width: 100%;
}

.row {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
}

.key-input {
  width: 190px;
  flex: none;
}

.profile-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.toolbar-hint {
  margin: 0;
  margin-left: 4px;
}

.profile-title {
  margin-right: 8px;
  font-weight: 600;
}

.range-sep {
  margin: 0 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.remove-profile {
  margin-top: 8px;
}

.json-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}

.json-area :deep(textarea) {
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
}

.json-error {
  margin-top: 8px;
}

.footer-path {
  display: inline-block;
  max-width: 52%;
  margin-right: 12px;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--el-text-color-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}
</style>
