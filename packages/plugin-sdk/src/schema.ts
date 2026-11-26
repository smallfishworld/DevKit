import type { PluginConfigSchema, VisibleWhenRule } from './types'

const supported = new Set([
  'type', 'title', 'description', 'default', 'enum', 'properties', 'required',
  'additionalProperties', 'items', 'minimum', 'maximum', 'minLength', 'maxLength',
  'minItems', 'maxItems', 'pattern', '$schema', 'x-visibleWhen', 'x-advanced'
])
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor'])

/** Reject patterns with nested repetition, backreferences or assertions before RegExp.test. */
export function safeConfigPattern(pattern: string): boolean {
  if (pattern.length > 128 || /\\[1-9]|\(\?/.test(pattern)) return false
  if (/\([^()]*[+*{][^()]*\)[+*?{]/.test(pattern)) return false
  if (/\([^()]*\|[^()]*\)[+*?{]/.test(pattern)) return false
  if (/[+*?}][+*?{]/.test(pattern)) return false
  return true
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

function fail(path: string, message: string): never {
  throw new Error(path + ': ' + message)
}

function validateVisibleWhen(rule: unknown, path: string): void {
  if (!isRecord(rule)) fail(path, 'x-visibleWhen 须为对象')
  const keys = Object.keys(rule)
  for (const key of keys) {
    if (!['field', 'equals', 'notEquals', 'in'].includes(key)) fail(path, 'x-visibleWhen 不支持关键字 ' + key)
  }
  if (typeof rule.field !== 'string' || !rule.field.trim() || forbiddenKeys.has(rule.field)) {
    fail(path, 'x-visibleWhen.field 须为有效字段名')
  }
  const hasCondition = Object.hasOwn(rule, 'equals') || Object.hasOwn(rule, 'notEquals') || Object.hasOwn(rule, 'in')
  if (!hasCondition) fail(path, 'x-visibleWhen 须包含 equals、notEquals 或 in')
  if (Object.hasOwn(rule, 'in') && (!Array.isArray(rule.in) || rule.in.length === 0 || rule.in.length > 50)) {
    fail(path, 'x-visibleWhen.in 须为 1 至 50 项数组')
  }
}

export function isFieldVisible(schema: PluginConfigSchema | Record<string, unknown>, context: Record<string, unknown>): boolean {
  const rule = schema['x-visibleWhen'] as VisibleWhenRule | undefined
  if (!rule || typeof rule !== 'object') return true
  const actual = context[rule.field]
  if (Object.hasOwn(rule, 'equals') && JSON.stringify(actual) !== JSON.stringify(rule.equals)) return false
  if (Object.hasOwn(rule, 'notEquals') && JSON.stringify(actual) === JSON.stringify(rule.notEquals)) return false
  if (Array.isArray(rule.in) && !rule.in.some((item) => JSON.stringify(item) === JSON.stringify(actual))) return false
  return true
}

/** Deliberately bounded JSON Schema subset shared with the generated settings UI. */
export function validateSchema(value: unknown, path = 'configSchema', depth = 0): asserts value is PluginConfigSchema {
  if (!isRecord(value) || depth > 12) fail(path, '须为有效且深度不超过12的schema对象')
  for (const key of Object.keys(value)) if (!supported.has(key)) fail(path, '不支持schema关键字 ' + key)
  if (value.type !== undefined && !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(String(value.type))) {
    fail(path, '不支持type')
  }
  for (const name of ['title', 'description', 'pattern']) {
    if (value[name] !== undefined && typeof value[name] !== 'string') fail(path, name + '须为字符串')
  }
  if (typeof value.pattern === 'string') {
    if (!safeConfigPattern(value.pattern)) fail(path, 'pattern含不安全或不支持的复杂正则')
    try { new RegExp(value.pattern) } catch { fail(path, 'pattern不是有效正则') }
  }
  if (value['x-visibleWhen'] !== undefined) validateVisibleWhen(value['x-visibleWhen'], path + '.x-visibleWhen')
  if (value['x-advanced'] !== undefined && typeof value['x-advanced'] !== 'boolean') fail(path, 'x-advanced 须为布尔值')
  if (value.enum !== undefined && (!Array.isArray(value.enum) || !value.enum.length || value.enum.length > 100)) {
    fail(path, 'enum须为1至100项数组')
  }
  for (const name of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (value[name] !== undefined && (typeof value[name] !== 'number' || !Number.isFinite(value[name]))) {
      fail(path, name + '须为有限数字')
    }
  }
  for (const [low, high] of [['minimum', 'maximum'], ['minLength', 'maxLength'], ['minItems', 'maxItems']]) {
    if (typeof value[low] === 'number' && typeof value[high] === 'number' && value[low] > value[high]) {
      fail(path, low + '不能大于' + high)
    }
  }
  if (value.properties !== undefined) {
    if (!isRecord(value.properties) || Object.keys(value.properties).length > 100) {
      fail(path, 'properties须为至多100字段的对象')
    }
    for (const [key, child] of Object.entries(value.properties)) {
      if (forbiddenKeys.has(key)) fail(path, '保留字段名')
      validateSchema(child, path + '.' + key, depth + 1)
    }
  }
  if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some((key) => typeof key !== 'string' || forbiddenKeys.has(key)))) {
    fail(path, 'required须为字段名数组')
  }
  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== 'boolean') {
    fail(path, 'additionalProperties须为boolean')
  }
  if (value.items !== undefined) validateSchema(value.items, path + '[]', depth + 1)
}

export function validateConfig(value: unknown, schema: PluginConfigSchema, path = 'config', depth = 0): void {
  if (depth > 16) fail(path, '配置嵌套过深')
  if (schema.enum && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    fail(path, '不在允许的选项内')
  }
  const type = schema.type
  if (type === 'object' && !isRecord(value)) fail(path, '须为对象')
  if (type === 'array' && !Array.isArray(value)) fail(path, '须为数组')
  if (type === 'string' && typeof value !== 'string') fail(path, '须为字符串')
  if ((type === 'number' || type === 'integer') && (typeof value !== 'number' || !Number.isFinite(value))) fail(path, '须为有限数字')
  if (type === 'integer' && !Number.isInteger(value)) fail(path, '须为整数')
  if (type === 'boolean' && typeof value !== 'boolean') fail(path, '须为boolean')
  if (type === 'null' && value !== null) fail(path, '须为null')
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) fail(path, '长度不足')
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail(path, '长度超限')
    if (schema.pattern) {
      if (!safeConfigPattern(schema.pattern) || value.length > 4096) fail(path, '正则匹配输入过长或pattern不安全')
      if (!new RegExp(schema.pattern).test(value)) fail(path, '格式不匹配')
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail(path, '小于最小值')
    if (schema.maximum !== undefined && value > schema.maximum) fail(path, '大于最大值')
  }
  if (Array.isArray(value)) {
    if (value.length > 10000 || (schema.maxItems !== undefined && value.length > schema.maxItems)) fail(path, '数组长度超限')
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(path, '数组长度不足')
    if (schema.items) value.forEach((item, index) => validateConfig(item, schema.items!, path + '[' + index + ']', depth + 1))
  }
  if (isRecord(value)) {
    for (const required of schema.required ?? []) {
      const childSchema = schema.properties?.[required]
      if (childSchema && !isFieldVisible(childSchema, value)) continue
      if (!Object.hasOwn(value, required)) fail(path, '缺少 ' + required)
    }
    for (const [key, item] of Object.entries(value)) {
      if (forbiddenKeys.has(key)) fail(path, '保留字段名')
      const child = schema.properties?.[key]
      if (child) {
        if (!isFieldVisible(child, value)) continue
        validateConfig(item, child, path + '.' + key, depth + 1)
      } else if (schema.additionalProperties === false) {
        fail(path, '未知字段 ' + key)
      }
    }
  }
}

export function applyDefaults(value: Record<string, unknown>, schema: PluginConfigSchema): Record<string, unknown> {
  const output = JSON.parse(JSON.stringify(value)) as Record<string, unknown>
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    if (!Object.hasOwn(output, key) && child.default !== undefined) {
      output[key] = JSON.parse(JSON.stringify(child.default))
    }
    if (isRecord(output[key]) && child.type === 'object') {
      output[key] = applyDefaults(output[key] as Record<string, unknown>, child)
    } else if (Array.isArray(output[key]) && child.type === 'array' && child.items?.type === 'object') {
      output[key] = (output[key] as unknown[]).map((entry) =>
        isRecord(entry) ? applyDefaults(entry, child.items!) : entry
      )
    }
  }
  validateConfig(output, schema)
  return output
}
