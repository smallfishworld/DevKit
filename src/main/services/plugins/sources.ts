import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { OFFICIAL_PLUGIN_SOURCE } from '../../../shared/plugins'
import type { PluginSource, PluginSourceEntry, StreamTransport } from '../../../shared/plugins'
import { SEMVER_PATTERN, satisfiesMinVersion } from '../../../../packages/plugin-sdk/src/manifest'

const ALLOWED_TRANSPORTS: readonly StreamTransport[] = ['serial', 'ssh', 'net', 'pty']

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('扩展索引格式无效')
  return value as Record<string, unknown>
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('扩展源字段无效')
  return value.trim()
}

function httpsUrl(value: unknown, base?: string): string {
  const url = new URL(text(value, 2048), base)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('请输入不含凭据或片段的 HTTPS 地址')
  }
  return url.href
}

export function parseSourceIndex(input: unknown, indexUrl: string): PluginSourceEntry[] {
  const index = object(input)
  if (index.version !== 2 || !Array.isArray(index.plugins) || index.plugins.length > 128) {
    throw new Error('需要版本 2 的扩展索引，最多 128 个插件')
  }
  const ids = new Set<string>()
  return index.plugins.map((value) => {
    const item = object(value)
    const id = text(item.id, 96)
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(id) || ids.has(id)) throw new Error('插件 ID 无效或重复')
    ids.add(id)
    const sha256 = text(item.sha256, 64).toLowerCase()
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('插件缺少有效的 SHA-256')
    const version = text(item.version, 64)
    if (item.apiVersion !== undefined && item.apiVersion !== 2) throw new Error('扩展索引条目仅支持 apiVersion 2')
    let minHostVersion: string | undefined
    if (item.minHostVersion !== undefined) {
      minHostVersion = text(item.minHostVersion, 64)
      if (!SEMVER_PATTERN.test(minHostVersion)) throw new Error('minHostVersion 须为语义版本号')
    }
    let transports: StreamTransport[] | undefined
    if (item.transports !== undefined) {
      if (!Array.isArray(item.transports) || item.transports.some((t) => typeof t !== 'string' || !ALLOWED_TRANSPORTS.includes(t as StreamTransport))) {
        throw new Error('transports 字段无效')
      }
      transports = [...new Set(item.transports as StreamTransport[])]
    }
    const deprecated = item.deprecated !== undefined ? text(item.deprecated, 256) : undefined
    const yanked = item.yanked === true ? true : undefined
    return {
      id,
      version,
      sha256,
      apiVersion: 2,
      name: text(item.name, 128),
      url: httpsUrl(item.url, indexUrl),
      ...(transports ? { transports } : {}),
      ...(minHostVersion ? { minHostVersion } : {}),
      ...(deprecated ? { deprecated } : {}),
      ...(yanked ? { yanked } : {})
    }
  })
}

export async function fetchBounded(url: string, maxBytes: number): Promise<Buffer> {
  const signal = AbortSignal.timeout(12_000)
  let address = httpsUrl(url)
  const request = () => fetch(address, {
    redirect: 'manual', signal, headers: { accept: 'application/json' }
  })
  let response = await request()
  for (let hop = 0; [301, 302, 303, 307, 308].includes(response.status); hop++) {
    const target = response.headers.get('location')
    await response.body?.cancel()
    if (hop >= 3 || !target) throw new Error('扩展源重定向无效或次数过多')
    address = httpsUrl(target, address)
    response = await request()
  }
  if (!response.ok || !response.body) throw new Error(`扩展源请求失败（HTTP ${response.status}）`)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new Error('扩展源响应超过大小限制')
      chunks.push(Buffer.from(value))
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks)
}

export class PluginSources {
  private readonly path: string

  constructor(
    private readonly root: string,
    private readonly download = fetchBounded,
    private readonly hostVersion = '0.1.10'
  ) {
    this.path = join(root, 'plugin-sources.json')
  }

  async list(): Promise<PluginSource[]> {
    let rows: unknown = []
    try {
      rows = JSON.parse(await fs.readFile(this.path, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (!Array.isArray(rows) || rows.length > 17) throw new Error('扩展源配置格式无效')
    const saved = rows.map((value) => {
      const row = object(value)
      const url = httpsUrl(row.url)
      return {
        id: text(row.id, 96), name: text(row.name, 128), url, enabled: row.enabled === true,
        refreshedAt: typeof row.refreshedAt === 'number' ? row.refreshedAt : undefined,
        entries: parseSourceIndex({ version: 2, plugins: row.entries }, url)
      }
    })
    const existingOfficial = saved.find((row) => row.url === OFFICIAL_PLUGIN_SOURCE.url)
    const official: PluginSource = {
      enabled: true, entries: [], ...existingOfficial, ...OFFICIAL_PLUGIN_SOURCE, official: true
    }
    return [
      official,
      ...saved.filter((row) => row.url !== official.url && row.id !== official.id)
    ]
  }

  private async save(sources: PluginSource[]): Promise<PluginSource[]> {
    await fs.mkdir(this.root, { recursive: true })
    const staging = this.path + '.' + randomUUID()
    try {
      await fs.writeFile(staging, JSON.stringify(sources, null, 2), { flag: 'wx' })
      await fs.rename(staging, this.path)
    } finally {
      await fs.unlink(staging).catch(() => {})
    }
    return sources
  }

  async add(name: unknown, value: unknown): Promise<PluginSource[]> {
    const url = httpsUrl(value)
    const sources = await this.list()
    if (sources.filter((source) => !source.official).length >= 16) throw new Error('最多添加 16 个自定义扩展源')
    if (sources.some((source) => source.url === url)) throw new Error('扩展源已添加')
    return this.save([...sources, { id: randomUUID(), name: text(name, 128), url, enabled: true, entries: [] }])
  }

  async update(id: string, enabled?: boolean): Promise<PluginSource[]> {
    const sources = await this.list()
    const source = sources.find((row) => row.id === id)
    if (!source) throw new Error('扩展源不存在')
    if (source.official && enabled === undefined) throw new Error('官方扩展源可停用')
    return this.save(enabled === undefined
      ? sources.filter((source) => source.id !== id)
      : sources.map((source) => source.id === id ? { ...source, enabled } : source))
  }

  async refresh(id: string): Promise<PluginSource[]> {
    const sources = await this.list()
    const source = sources.find((entry) => entry.id === id && entry.enabled)
    if (!source) throw new Error('请先启用扩展源')
    const bytes = await this.download(source.url, 512 * 1024)
    source.entries = parseSourceIndex(JSON.parse(bytes.toString('utf8')), source.url)
    source.refreshedAt = Date.now()
    return this.save(sources)
  }

  async package(sourceId: string, pluginId: string, sha: string, maxBytes: number): Promise<Buffer> {
    const source = (await this.list()).find((row) => row.enabled && row.id === sourceId)
    const entry = source?.entries.find((item) => item.id === pluginId && item.sha256 === sha)
    if (!entry) throw new Error('下载条目已变化，请刷新后重新选择')
    if (entry.yanked) throw new Error('该插件版本已被撤回（yanked），禁止安装')
    if (entry.minHostVersion && !satisfiesMinVersion(this.hostVersion, entry.minHostVersion)) {
      throw new Error(`该插件要求 DevKit >= ${entry.minHostVersion}（当前 ${this.hostVersion}）`)
    }
    const bytes = await this.download(entry.url, maxBytes)
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('插件 SHA-256 校验失败')
    const manifest = object(object(JSON.parse(bytes.toString('utf8'))).manifest)
    if (manifest.id !== entry.id || manifest.version !== entry.version) throw new Error('插件包与索引的标识或版本不符')
    return bytes
  }
}
