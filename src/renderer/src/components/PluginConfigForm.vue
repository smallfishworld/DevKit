<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { Delete, Plus } from '@element-plus/icons-vue'
import {
  configFields,
  defaultPluginConfig,
  isConfigObject,
  isFieldVisible,
  visibleConfigFields,
  type ConfigField
} from './plugin-config-form'

const props = defineProps<{ modelValue: Record<string, unknown>; schema: unknown }>()
const emit = defineEmits<{
  (event: 'update:modelValue', value: Record<string, unknown>): void
  (event: 'validity', valid: boolean): void
}>()
const allFields = computed(() => configFields(props.schema))
const fields = computed(() => visibleConfigFields(props.schema, props.modelValue))
const advancedPanel = ref<string[]>([])
const normalFields = computed(() => fields.value.filter((field) => !field.advanced))
const advancedFields = computed(() => fields.value.filter((field) => field.advanced))
const normalItemFields = (field: ConfigField) => (field.itemFields ?? []).filter((sub) => !sub.advanced)
const advancedItemFields = (field: ConfigField) => (field.itemFields ?? []).filter((sub) => sub.advanced)
const jsonText = reactive<Record<string, string>>({})
const errors = reactive<Record<string, string>>({})

watch(() => props.modelValue, (config) => {
  for (const field of allFields.value) {
    if (field.widget === 'json' && !errors[field.key]) {
      jsonText[field.key] = config[field.key] === undefined ? '' : JSON.stringify(config[field.key], null, 2)
    }
  }
}, { immediate: true, deep: true })

function setValue(key: string, value: unknown): void {
  const next = { ...props.modelValue }
  if (value === undefined) delete next[key]
  else next[key] = value
  emit('update:modelValue', next)
}
function setJson(key: string, text: string): void {
  jsonText[key] = text
  try {
    const value: unknown = text.trim() ? JSON.parse(text) : undefined
    delete errors[key]
    setValue(key, value)
  } catch (error) {
    errors[key] = error instanceof Error ? error.message : 'JSON 语法错误'
  }
  emit('validity', Object.keys(errors).length === 0)
}
function arrayRows(key: string): Record<string, unknown>[] {
  const value = props.modelValue[key]
  if (!Array.isArray(value)) return []
  return value.map((item) => (isConfigObject(item) ? item : {}))
}
function addArrayRow(field: ConfigField): void {
  const rows = arrayRows(field.key)
  const itemDefault = defaultPluginConfig(field.schema.items)
  setValue(field.key, [...rows, itemDefault])
}
function removeArrayRow(key: string, index: number): void {
  const rows = arrayRows(key).filter((_, idx) => idx !== index)
  setValue(key, rows)
}
function setArrayCell(key: string, index: number, subKey: string, value: unknown): void {
  const rows = arrayRows(key).map((row, idx) => {
    if (idx !== index) return row
    const next = { ...row }
    if (value === undefined) delete next[subKey]
    else next[subKey] = value
    return next
  })
  setValue(key, rows)
}
function options(field: Record<string, unknown>): Array<string | number | boolean> {
  return field.enum as Array<string | number | boolean>
}
function numeric(field: Record<string, unknown>, key: string): number | undefined {
  return typeof field[key] === 'number' ? field[key] as number : undefined
}
</script>

<template>
  <el-form label-position="top" size="small" class="plugin-config-form" @submit.prevent>
    <el-empty v-if="!fields.length" description="此插件没有普通配置字段，可使用完整 JSON 编辑" :image-size="50" />
    <el-form-item v-for="field in normalFields" :key="field.key" :label="field.title" :required="field.required" :error="errors[field.key]">
      <el-select
        v-if="field.widget === 'enum'"
        :model-value="modelValue[field.key] as string | number | boolean | undefined"
        :clearable="!field.required"
        @update:model-value="(value: unknown) => setValue(field.key, value === '' && !field.required ? undefined : value)"
      >
        <el-option v-for="(option, index) in options(field.schema)" :key="index" :label="String(option)" :value="option" />
      </el-select>
      <el-switch
        v-else-if="field.widget === 'boolean'"
        :model-value="modelValue[field.key] === true"
        @update:model-value="(value: string | number | boolean) => setValue(field.key, value)"
      />
      <el-input-number
        v-else-if="field.widget === 'number'"
        :model-value="typeof modelValue[field.key] === 'number' ? modelValue[field.key] as number : undefined"
        :min="numeric(field.schema, 'minimum')"
        :max="numeric(field.schema, 'maximum')"
        :step="field.schema.type === 'integer' ? 1 : 0.1"
        :precision="field.schema.type === 'integer' ? 0 : undefined"
        @update:model-value="(value: number | undefined) => setValue(field.key, value)"
      />
      <el-input
        v-else-if="field.widget === 'string'"
        :model-value="typeof modelValue[field.key] === 'string' ? modelValue[field.key] as string : ''"
        :type="field.schema.format === 'password' || field.schema.writeOnly === true ? 'password' : 'text'"
        :show-password="field.schema.format === 'password' || field.schema.writeOnly === true"
        :placeholder="typeof field.schema.description === 'string' ? field.schema.description : field.key"
        @update:model-value="(value: string) => setValue(field.key, value)"
      />
      <div v-else-if="field.widget === 'array'" class="array-editor">
        <div v-for="(row, rowIdx) in arrayRows(field.key)" :key="rowIdx" class="array-row">
          <div class="array-row-head">
            <span>规则 #{{ rowIdx + 1 }}</span>
            <el-button size="small" text type="danger" :icon="Delete" @click="removeArrayRow(field.key, rowIdx)">删除</el-button>
          </div>
          <div class="array-row-fields">
            <template v-for="sub in normalItemFields(field)" :key="sub.key">
              <div v-if="isFieldVisible(sub.schema, row)" class="array-sub-field">
                <label class="sub-label">{{ sub.title }}</label>
                <el-select
                  v-if="sub.widget === 'enum'"
                  :model-value="row[sub.key] as string | number | boolean | undefined"
                  size="small"
                  @update:model-value="(v: unknown) => setArrayCell(field.key, rowIdx, sub.key, v)"
                >
                  <el-option v-for="(opt, idx) in options(sub.schema)" :key="idx" :label="String(opt)" :value="opt" />
                </el-select>
                <el-switch
                  v-else-if="sub.widget === 'boolean'"
                  :model-value="row[sub.key] === true"
                  @update:model-value="(v: string | number | boolean) => setArrayCell(field.key, rowIdx, sub.key, v)"
                />
                <el-input-number
                  v-else-if="sub.widget === 'number'"
                  :model-value="typeof row[sub.key] === 'number' ? row[sub.key] as number : undefined"
                  :min="numeric(sub.schema, 'minimum')"
                  :max="numeric(sub.schema, 'maximum')"
                  size="small"
                  @update:model-value="(v: number | undefined) => setArrayCell(field.key, rowIdx, sub.key, v)"
                />
                <el-input
                  v-else
                  :model-value="typeof row[sub.key] === 'string' ? row[sub.key] as string : ''"
                  size="small"
                  :placeholder="sub.description || sub.key"
                  @update:model-value="(v: string) => setArrayCell(field.key, rowIdx, sub.key, v)"
                />
              </div>
            </template>
          </div>
          <details v-if="advancedItemFields(field).length" class="array-advanced">
            <summary>规则高级选项</summary>
            <div class="array-row-fields">
              <template v-for="sub in advancedItemFields(field)" :key="sub.key">
                <div v-if="isFieldVisible(sub.schema, row)" class="array-sub-field">
                  <label class="sub-label">{{ sub.title }}</label>
                  <el-select
                    v-if="sub.widget === 'enum'"
                    :model-value="row[sub.key] as string | number | boolean | undefined"
                    size="small"
                    @update:model-value="(v: unknown) => setArrayCell(field.key, rowIdx, sub.key, v)"
                  >
                    <el-option v-for="(opt, idx) in options(sub.schema)" :key="idx" :label="String(opt)" :value="opt" />
                  </el-select>
                  <el-switch
                    v-else-if="sub.widget === 'boolean'"
                    :model-value="row[sub.key] === true"
                    @update:model-value="(v: string | number | boolean) => setArrayCell(field.key, rowIdx, sub.key, v)"
                  />
                  <el-input-number
                    v-else-if="sub.widget === 'number'"
                    :model-value="typeof row[sub.key] === 'number' ? row[sub.key] as number : undefined"
                    :min="numeric(sub.schema, 'minimum')"
                    :max="numeric(sub.schema, 'maximum')"
                    size="small"
                    @update:model-value="(v: number | undefined) => setArrayCell(field.key, rowIdx, sub.key, v)"
                  />
                  <el-input
                    v-else
                    :model-value="typeof row[sub.key] === 'string' ? row[sub.key] as string : ''"
                    size="small"
                    :placeholder="sub.description || sub.key"
                    @update:model-value="(v: string) => setArrayCell(field.key, rowIdx, sub.key, v)"
                  />
                </div>
              </template>
            </div>
          </details>
        </div>
        <el-button size="small" plain :icon="Plus" @click="addArrayRow(field)">添加{{ field.title }}</el-button>
      </div>
      <el-input
        v-else
        :model-value="jsonText[field.key] ?? ''"
        type="textarea"
        :rows="5"
        spellcheck="false"
        class="json-input"
        placeholder="以 JSON 编辑数组、对象或复杂字段"
        @update:model-value="(value: string) => setJson(field.key, value)"
      />
      <div v-if="field.description" class="field-help">{{ field.description }}</div>
    </el-form-item>
    <el-collapse v-if="advancedFields.length" class="advanced-collapse" v-model="advancedPanel">
      <el-collapse-item name="advanced" title="高级选项（保持默认即可）">
        <el-form-item v-for="field in advancedFields" :key="field.key" :label="field.title" :required="field.required" :error="errors[field.key]">
          <el-select
            v-if="field.widget === 'enum'"
            :model-value="modelValue[field.key] as string | number | boolean | undefined"
            :clearable="!field.required"
            @update:model-value="(value: unknown) => setValue(field.key, value === '' && !field.required ? undefined : value)"
          >
            <el-option v-for="(option, index) in options(field.schema)" :key="index" :label="String(option)" :value="option" />
          </el-select>
          <el-switch
            v-else-if="field.widget === 'boolean'"
            :model-value="modelValue[field.key] === true"
            @update:model-value="(value: string | number | boolean) => setValue(field.key, value)"
          />
          <el-input-number
            v-else-if="field.widget === 'number'"
            :model-value="typeof modelValue[field.key] === 'number' ? modelValue[field.key] as number : undefined"
            :min="numeric(field.schema, 'minimum')"
            :max="numeric(field.schema, 'maximum')"
            :step="field.schema.type === 'integer' ? 1 : 0.1"
            :precision="field.schema.type === 'integer' ? 0 : undefined"
            @update:model-value="(value: number | undefined) => setValue(field.key, value)"
          />
          <el-input
            v-else-if="field.widget === 'string'"
            :model-value="typeof modelValue[field.key] === 'string' ? modelValue[field.key] as string : ''"
            :type="field.schema.format === 'password' || field.schema.writeOnly === true ? 'password' : 'text'"
            :show-password="field.schema.format === 'password' || field.schema.writeOnly === true"
            :placeholder="typeof field.schema.description === 'string' ? field.schema.description : field.key"
            @update:model-value="(value: string) => setValue(field.key, value)"
          />
          <el-input
            v-else
            :model-value="jsonText[field.key] ?? ''"
            type="textarea"
            :rows="5"
            spellcheck="false"
            class="json-input"
            placeholder="以 JSON 编辑数组、对象或复杂字段"
            @update:model-value="(value: string) => setJson(field.key, value)"
          />
          <div v-if="field.description" class="field-help">{{ field.description }}</div>
        </el-form-item>
      </el-collapse-item>
    </el-collapse>
  </el-form>
</template>

<style scoped>
.plugin-config-form :deep(.el-select) { width: 100%; }
.field-help { width: 100%; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; margin-top: 3px; }
.json-input :deep(textarea) { font-family: var(--font-mono); font-size: 12px; }
.array-editor { width: 100%; display: flex; flex-direction: column; gap: 8px; }
.array-row { padding: 8px 10px; border: 1px solid var(--el-border-color-lighter); border-radius: 6px; background: var(--el-fill-color-blank); }
.array-row-head { display: flex; align-items: center; justify-content: space-between; font-size: 12px; font-weight: 600; margin-bottom: 6px; }
.array-row-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; }
.array-sub-field { display: flex; flex-direction: column; gap: 3px; }
.sub-label { font-size: 11px; color: var(--el-text-color-secondary); }
.advanced-collapse { margin-top: 4px; }
.advanced-collapse :deep(.el-collapse-item__header) { font-size: 12px; color: var(--el-text-color-secondary); }
.array-advanced { margin-top: 6px; font-size: 12px; }
.array-advanced summary { color: var(--el-text-color-secondary); cursor: pointer; margin-bottom: 4px; }
</style>
