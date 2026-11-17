<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { configFields } from './plugin-config-form'

const props = defineProps<{ modelValue: Record<string, unknown>; schema: unknown }>()
const emit = defineEmits<{
  (event: 'update:modelValue', value: Record<string, unknown>): void
  (event: 'validity', valid: boolean): void
}>()
const fields = computed(() => configFields(props.schema))
const jsonText = reactive<Record<string, string>>({})
const errors = reactive<Record<string, string>>({})

watch(() => props.modelValue, (config) => {
  for (const field of fields.value) {
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
    <el-form-item v-for="field in fields" :key="field.key" :label="field.title" :required="field.required" :error="errors[field.key]">
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
  </el-form>
</template>

<style scoped>
.plugin-config-form :deep(.el-select) { width: 100%; }
.field-help { width: 100%; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; margin-top: 3px; }
.json-input :deep(textarea) { font-family: var(--font-mono); font-size: 12px; }
</style>
