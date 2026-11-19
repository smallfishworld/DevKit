/** Pure helpers for the schema editor. The host remains the authoritative validator. */
import { isFieldVisible } from '../../../../packages/plugin-sdk/src/schema'

export interface ConfigField {
  key: string
  title: string
  description: string
  schema: Record<string, unknown>
  required: boolean
  widget: 'string' | 'number' | 'boolean' | 'enum' | 'array' | 'json'
  itemFields?: ConfigField[]
}

export function isConfigObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function configFields(schema: unknown): ConfigField[] {
  if (!isConfigObject(schema) || !isConfigObject(schema.properties)) return []
  const required = Array.isArray(schema.required) ? schema.required : []
  return Object.entries(schema.properties)
    .filter(([key]) => !['__proto__', 'constructor', 'prototype'].includes(key))
    .map(([key, value]) => {
      const field = isConfigObject(value) ? value : {}
      const primitiveEnum = Array.isArray(field.enum) && field.enum.every((item) =>
        typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
      )
      const isObjectArray = field.type === 'array' && isConfigObject(field.items) &&
        field.items.type === 'object' && isConfigObject(field.items.properties)
      const widget: ConfigField['widget'] = primitiveEnum
        ? 'enum'
        : field.type === 'boolean'
          ? 'boolean'
          : field.type === 'integer' || field.type === 'number'
            ? 'number'
            : field.type === 'string'
              ? 'string'
              : isObjectArray
                ? 'array'
                : 'json'
      return {
        key,
        title: typeof field.title === 'string' ? field.title : key,
        description: typeof field.description === 'string' ? field.description : '',
        schema: field,
        required: required.includes(key),
        widget,
        ...(isObjectArray ? { itemFields: configFields(field.items) } : {})
      }
    })
}

export function visibleConfigFields(schema: unknown, values: Record<string, unknown>): ConfigField[] {
  return configFields(schema).filter((field) => isFieldVisible(field.schema, values))
}

export function defaultPluginConfig(schema: unknown): Record<string, unknown> {
  if (!isConfigObject(schema)) return {}
  const result: Record<string, unknown> = isConfigObject(schema.default)
    ? JSON.parse(JSON.stringify(schema.default))
    : {}
  for (const field of configFields(schema)) {
    if (result[field.key] === undefined && field.schema.default !== undefined) {
      result[field.key] = JSON.parse(JSON.stringify(field.schema.default))
    }
  }
  return result
}

export function parseConfigJson(text: string): { config?: Record<string, unknown>; error?: string } {
  try {
    const value: unknown = JSON.parse(text)
    if (!isConfigObject(value)) return { error: '配置必须是 JSON 对象，不能是数组或空值' }
    return { config: value }
  } catch (error) {
    return { error: `JSON 语法错误：${error instanceof Error ? error.message : String(error)}` }
  }
}

export { isFieldVisible }
