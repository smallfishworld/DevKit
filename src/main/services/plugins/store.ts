import { promises as fs } from 'node:fs'
import { join, relative, resolve, isAbsolute, dirname, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PluginDescriptor, PluginInstallSource, PluginInstance } from '../../../shared/plugins'
import {
  PLUGIN_ID_PATTERN,
  PLUGIN_INSTANCE_ID_PATTERN,
  parseJson,
  parseManifest,
  safePackagePath
} from '../../../../packages/plugin-sdk/src/manifest'

export { parseJson, parseManifest, safePackagePath }
export const MAX_PACKAGE_BYTES = 4 * 1024 * 1024
const INSTALL_METADATA = '.devkit-install-source.json'

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('须为JSON对象')
  return value as Record<string, unknown>
}
function short(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) {
    throw new Error(label + '无效')
  }
  return value
}

function parseInstallSource(value: unknown): PluginInstallSource {  const source = record(value)
  const name = short(source.name, '安装来源名称', 128)
  const url = new URL(short(source.url, '安装来源地址', 2048))
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('安装来源地址无效')
  return { name, url: url.href }
}

interface StoreState { version: 2; instances: PluginInstance[] }

/** Windows 上刚写完的目录可能仍被杀毒软件占用，rename 会偶发 EPERM/EBUSY；短暂退避后重试。 */
async function renameWithRetry(from: string, to: string, attempts = 5): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= attempts - 1 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)))
    }
  }
}

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
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 2, instances: [] }
      throw error
    }
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('插件实例配置文件过大')
    const state = record(parseJson(text))
    if (state.version !== 2 || !Array.isArray(state.instances) || state.instances.length > 128) {
      throw new Error('插件配置版本或格式不支持（需要 v2）')
    }
    const ids = new Set<string>()
    const instances = state.instances.map((raw): PluginInstance => {
      const item = record(raw)
      const id = short(item.id, 'instance.id', 128)
      if (!PLUGIN_INSTANCE_ID_PATTERN.test(id) || ids.has(id)) throw new Error('插件实例ID无效或重复')
      ids.add(id)
      if (item.configVersion !== 2 || typeof item.enabled !== 'boolean' || typeof item.autoEnabled !== 'boolean') {
        throw new Error('插件实例版本或开关无效')
      }
      return {
        id,
        pluginId: short(item.pluginId, 'pluginId', 96),
        label: short(item.label, 'label', 128),
        config: record(item.config),
        enabled: item.enabled,
        autoEnabled: item.autoEnabled,
        configVersion: 2
      }
    })
    return { version: 2, instances }
  }

  async writeState(instances: PluginInstance[]): Promise<void> {
    await fs.mkdir(dirname(this.statePath), { recursive: true })
    const temp = this.statePath + '.' + randomUUID() + '.tmp'
    // 旧版本在此写入的 legacyImported 不再存在；读取时忽略未知字段，升级后无需迁移。
    const text = JSON.stringify({ version: 2, instances }, null, 2) + '\n'
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
      let installSource: PluginInstallSource | undefined
      try {
        const metadataPath = join(path, INSTALL_METADATA)
        const metadataStat = await fs.lstat(metadataPath)
        if (!metadataStat.isFile() || metadataStat.isSymbolicLink() || metadataStat.size > 4096) throw new Error('安装来源元数据无效')
        installSource = parseInstallSource(parseJson(await fs.readFile(metadataPath, 'utf8')))
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      output.push({ ...manifest, builtin: false, path, ...(installSource ? { installSource } : {}) })
    }
    return output
  }

  /** Import a self-contained directory or JSON bundle; packages are trusted local code. */
  async install(source: string, blockedIds: Set<string>, provenance?: PluginInstallSource): Promise<PluginDescriptor> {
    const installSource = provenance ? parseInstallSource(provenance) : undefined
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
          if (['.git', 'node_modules'].includes(item.name)) continue
          const name = sub ? sub + '/' + item.name : item.name
          if (name.toLowerCase() === INSTALL_METADATA) throw new Error('插件包包含宿主保留文件')
          const to = safePackagePath(stage, name)
          if (item.isSymbolicLink()) throw new Error('插件包不能含符号链接')
          if (item.isDirectory()) {
            if (++directories > 64 || name.split('/').length > 12) throw new Error('插件包目录过多或嵌套过深')
            await fs.mkdir(to)
            await copyDirectory(join(from, item.name), name)
          } else if (item.isFile()) {
            const stat = await fs.stat(join(from, item.name))
            total += stat.size
            count++
            if (total > MAX_PACKAGE_BYTES || count > 128) throw new Error('插件包超过4MiB或128个文件')
            await fs.copyFile(join(from, item.name), to)
          } else throw new Error('插件包仅支持普通文件')
        }
      }
      if (sourceStat.isDirectory()) {
        const stageInsideSource = relative(resolve(source), stage)
        if (!stageInsideSource.startsWith('..') && !isAbsolute(stageInsideSource)) {
          throw new Error('请选择具体插件目录，不能导入插件存储父目录')
        }
        await copyDirectory(source)
      } else if (sourceStat.isFile() && extname(source).toLowerCase() === '.json') {
        if (sourceStat.size > MAX_PACKAGE_BYTES) throw new Error('JSON插件包超过4MiB')
        const bundle = record(parseJson(await fs.readFile(source, 'utf8')))
        const files = record(bundle.files)
        if (Object.keys(files).length > 127) throw new Error('插件包文件过多')
        const paths = new Set(['manifest.json'])
        for (const [name, contents] of Object.entries(files)) {
          const key = name.toLowerCase()
          if (key === INSTALL_METADATA) throw new Error('插件包包含宿主保留文件')
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
      if (installSource) await fs.writeFile(join(stage, INSTALL_METADATA), JSON.stringify(installSource) + '\n', { flag: 'wx' })
      const target = join(this.directory, manifest.id)
      const backup = join(this.directory, '.backup-' + randomUUID())
      let backed = false
      try {
        try { await renameWithRetry(target, backup); backed = true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        await renameWithRetry(stage, target)
      } catch (error) {
        if (backed) await fs.rename(backup, target)
        throw error
      }
      if (backed) await fs.rm(backup, { recursive: true, force: true })
      return { ...manifest, builtin: false, path: target, ...(installSource ? { installSource } : {}) }
    } finally { await fs.rm(stage, { recursive: true, force: true }).catch(() => {}) }
  }

  async remove(id: string): Promise<void> {
    if (!PLUGIN_ID_PATTERN.test(id)) throw new Error('插件ID无效')
    await fs.rm(join(this.directory, id), { recursive: true, force: true })
  }
}
