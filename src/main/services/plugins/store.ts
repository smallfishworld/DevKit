import { promises as fs } from 'node:fs'
import { join, resolve, relative, isAbsolute, dirname, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PluginDescriptor, PluginManifest, PluginInstance } from '../../../shared/plugins'
import { validateSchema } from './schema'

const ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/
const ACTION = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const INSTANCE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/
export const MAX_PACKAGE_BYTES = 4 * 1024 * 1024
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('须为JSON对象')
  return value as Record<string, unknown>
}
function short(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) throw new Error(label + '无效')
  return value
}
export function parseJson(text: string): unknown {
  return JSON.parse(text, (key, value: unknown) => {
    if (['__proto__','constructor','prototype'].includes(key)) throw new Error('JSON包含保留字段名')
    return value
  })
}
export function safePackagePath(root: string, name: string): string {
  if (!name || isAbsolute(name)) throw new Error('插件文件路径无效')
  for (const part of name.split('/')) {
    if (!part || /[\\:*?"<>|\x00-\x1f]|[. ]$/.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)) {
      throw new Error('插件文件路径无效')
    }
  }
  const target = resolve(root, name)
  if (relative(root, target).startsWith('..') || isAbsolute(relative(root, target))) throw new Error('插件文件不在包目录内')
  return target
}
export function parseManifest(value: unknown): PluginManifest {
  const m = record(value)
  const id = short(m.id, '插件ID', 96)
  if (!ID.test(id)) throw new Error('插件ID须使用命名空间，如 company.device-tools')
  const version = short(m.version, 'version', 64)
  if (!VERSION.test(version)) throw new Error('version须为语义版本号')
  if (m.apiVersion !== 1) throw new Error('插件API版本不兼容；当前仅支持1')
  const entry = short(m.entry, 'entry', 200)
  safePackagePath('/plugin-root', entry)
  if (!['.js','.cjs','.mjs'].includes(extname(entry))) throw new Error('entry须为预编译JavaScript文件')
  validateSchema(m.configSchema)
  if (m.configSchema.type !== 'object') throw new Error('configSchema顶层须为object')
  if (!Array.isArray(m.actions) || m.actions.length > 32) throw new Error('actions须为至多32项数组')
  const seen = new Set<string>()
  const actions = m.actions.map((raw) => {
    const action = record(raw)
    const actionId = short(action.id, 'action.id', 64)
    if (!ACTION.test(actionId) || seen.has(actionId)) throw new Error('动作ID无效或重复')
    seen.add(actionId)
    return { id: actionId, label: short(action.label, 'action.label', 128), ...(action.description === undefined ? {} : { description: short(action.description, 'action.description', 1024) }) }
  })
  if (typeof m.autoRespond !== 'boolean') throw new Error('autoRespond须为boolean')
  const allowed = ['serial.read','serial.write']
  if (!Array.isArray(m.capabilities) || m.capabilities.some((item) => typeof item !== 'string' || !allowed.includes(item))) throw new Error('不支持的capabilities；目前支持serial.read和serial.write')
  if (m.autoRespond && !m.capabilities.includes('serial.read')) throw new Error('自动应答须声明serial.read')
  return {
    id, name: short(m.name, 'name', 128), version, apiVersion: 1, entry,
    ...(m.description === undefined ? {} : { description: short(m.description, 'description', 2048) }),
    configSchema: m.configSchema, actions, autoRespond: m.autoRespond,
    capabilities: [...new Set(m.capabilities as string[])]
  }
}
interface StoreState { version: 1; instances: PluginInstance[]; legacyImported: boolean }
export class PluginStore {
  readonly directory: string
  private statePath: string
  constructor(readonly root: string) {
    this.directory = join(root, 'plugins', 'installed')
    this.statePath = join(root, 'plugins', 'instances.json')
  }
  async readState(): Promise<StoreState> {
    let text: string
    try { text = await fs.readFile(this.statePath, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, instances: [], legacyImported: false }; throw error }
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('插件实例配置文件过大')
    const state = record(parseJson(text))
    if (state.version !== 1 || !Array.isArray(state.instances) || state.instances.length > 128) throw new Error('插件配置版本或格式不支持')
    const ids = new Set<string>()
    const instances = state.instances.map((raw): PluginInstance => {
      const item = record(raw)
      const id = short(item.id, 'instance.id', 128)
      if (!INSTANCE_ID.test(id) || ids.has(id)) throw new Error('插件实例ID无效或重复')
      ids.add(id)
      if (item.configVersion !== 1 || typeof item.enabled !== 'boolean' || typeof item.autoEnabled !== 'boolean') throw new Error('插件实例版本或开关无效')
      return { id, pluginId: short(item.pluginId, 'pluginId', 96), label: short(item.label, 'label', 128), config: record(item.config), enabled: item.enabled, autoEnabled: item.autoEnabled, configVersion: 1 }
    })
    return { version: 1, instances, legacyImported: state.legacyImported === true }
  }
  async writeState(instances: PluginInstance[], legacyImported: boolean): Promise<void> {
    await fs.mkdir(dirname(this.statePath), { recursive: true })
    const temp = this.statePath + '.' + randomUUID() + '.tmp'
    const text = JSON.stringify({ version: 1, instances, legacyImported }, null, 2) + '\n'
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('插件实例配置总大小超过2MiB')
    try { await fs.writeFile(temp, text, { mode: 0o600 }); await fs.rename(temp, this.statePath) }
    finally { await fs.rm(temp, { force: true }).catch(() => {}) }
  }
  async listInstalled(): Promise<PluginDescriptor[]> {
    await fs.mkdir(this.directory, { recursive: true })
    const entries = await fs.readdir(this.directory, { withFileTypes: true })
    const output: PluginDescriptor[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const path = join(this.directory, entry.name)
      const manifest = parseManifest(parseJson(await fs.readFile(join(path, 'manifest.json'), 'utf8')))
      if (manifest.id !== entry.name) throw new Error('插件目录ID与manifest不一致：' + entry.name)
      const stat = await fs.lstat(safePackagePath(path, manifest.entry))
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('插件入口不存在或不是普通文件')
      output.push({ ...manifest, builtin: false, path })
    }
    return output
  }
  /** Import a self-contained directory or JSON bundle; packages are trusted local code. */
  async install(source: string, blockedIds: Set<string>): Promise<PluginDescriptor> {
    await fs.mkdir(this.directory, { recursive: true })
    const stage = join(this.directory, '.install-' + randomUUID())
    await fs.mkdir(stage)
    try {
      const sourceStat = await fs.lstat(source)
      if (sourceStat.isSymbolicLink()) throw new Error('不接受符号链接插件包')
      let total = 0
      let count = 0
      let directories = 0
      const copyDirectory = async (from: string, sub = ''): Promise<void> => {
        for (const item of await fs.readdir(from, { withFileTypes: true })) {
          if (['.git','node_modules'].includes(item.name)) continue
          const name = sub ? sub + '/' + item.name : item.name
          const to = safePackagePath(stage, name)
          if (item.isSymbolicLink()) throw new Error('插件包不能含符号链接')
          if (item.isDirectory()) { if (++directories > 64 || name.split('/').length > 12) throw new Error('插件包目录过多或嵌套过深'); await fs.mkdir(to); await copyDirectory(join(from, item.name), name) }
          else if (item.isFile()) {
            const stat = await fs.stat(join(from, item.name))
            total += stat.size; count++
            if (total > MAX_PACKAGE_BYTES || count > 128) throw new Error('插件包超过4MiB或128个文件')
            await fs.copyFile(join(from, item.name), to)
          } else throw new Error('插件包仅支持普通文件')
        }
      }
      if (sourceStat.isDirectory()) {
        const stageInsideSource = relative(resolve(source), stage)
        if (!stageInsideSource.startsWith('..') && !isAbsolute(stageInsideSource)) throw new Error('请选择具体插件目录，不能导入插件存储父目录')
        await copyDirectory(source)
      }
      else if (sourceStat.isFile() && extname(source).toLowerCase() === '.json') {
        if (sourceStat.size > MAX_PACKAGE_BYTES) throw new Error('JSON插件包超过4MiB')
        const bundle = record(parseJson(await fs.readFile(source, 'utf8')))
        const files = record(bundle.files)
        if (Object.keys(files).length > 127) throw new Error('插件包文件过多')
        const paths = new Set(['manifest.json'])
        for (const [name, contents] of Object.entries(files)) {
          const key = name.toLowerCase()
          if (paths.has(key)) throw new Error('插件包包含重复文件路径')
          paths.add(key)
          if (typeof contents !== 'string') throw new Error('JSON包的files值须为文本')
          const target = safePackagePath(stage, name)
          total += Buffer.byteLength(contents)
          if (total > MAX_PACKAGE_BYTES) throw new Error('插件包内容超过4MiB')
          await fs.mkdir(dirname(target), { recursive: true })
          await fs.writeFile(target, contents)
        }
        await fs.writeFile(join(stage, 'manifest.json'), JSON.stringify(bundle.manifest, null, 2))
      } else throw new Error('请选择插件目录或JSON插件包（不支持ZIP）')
      const manifest = parseManifest(parseJson(await fs.readFile(join(stage, 'manifest.json'), 'utf8')))
      if (blockedIds.has(manifest.id)) throw new Error('内置插件或正在使用的插件不能覆盖；请先解除实例绑定')
      const entry = await fs.lstat(safePackagePath(stage, manifest.entry))
      if (!entry.isFile()) throw new Error('插件入口不存在')
      const target = join(this.directory, manifest.id)
      const backup = join(this.directory, '.backup-' + randomUUID())
      let backed = false
      try {
        try { await fs.rename(target, backup); backed = true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        await fs.rename(stage, target)
      } catch (error) {
        if (backed) await fs.rename(backup, target)
        throw error
      }
      if (backed) await fs.rm(backup, { recursive: true, force: true })
      return { ...manifest, builtin: false, path: target }
    } finally { await fs.rm(stage, { recursive: true, force: true }).catch(() => {}) }
  }
  async remove(id: string): Promise<void> {
    if (!ID.test(id)) throw new Error('插件ID无效')
    await fs.rm(join(this.directory, id), { recursive: true, force: true })
  }
}
