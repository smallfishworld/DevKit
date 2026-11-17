import { createHash } from 'node:crypto'
import type { PluginCatalog, PluginCatalogEntry, PluginSourceItem } from '../../../shared/plugins'
import { MAX_PACKAGE_BYTES } from './store'

/**
 * 插件源：DevKit-Plugins 仓库根目录的 catalog.json。
 * 安装包优先取同版本 GitHub Release 资产（标签 <slug>/v<version>），
 * 否则按 packagePath 相对索引地址下载；两种方式都要求 SHA-256 校验。
 * 索引与插件包都可能来自作者之外的托管方，是否信任仍由用户安装前确认。
 */
const ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/
const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?$/
const SHA256 = /^[a-f0-9]{64}$/i
const OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
export const SOURCE_CATALOG_FILE = 'catalog.json'
export const MAX_SOURCE_CATALOG_BYTES = 1024 * 1024
const MAX_CHECKSUMS_BYTES = 64 * 1024
export type SourceFetch = (url: string, init?: RequestInit) => Promise<Response>

/** 一个可按顺序尝试的插件包位置；sha256 缺省时读取 checksumsUrl。 */
export interface PluginPackageSource {
  url: string
  checksumsUrl: string
  sha256?: string
}

interface ParsedVersion { core: [number, number, number]; pre?: string[] }

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('应为 JSON 对象')
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) {
    throw new Error(`${label}无效`)
  }
  return value.trim()
}

function optionalText(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return text(value, label, max)
}

function parseVersion(value: string): ParsedVersion | undefined {
  const match = VERSION.exec(value)
  if (!match) return undefined
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    ...(match[4] ? { pre: match[4].split('.') } : {})
  }
}

function isLoopback(url: URL): boolean {
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '::1')
}

function httpsUrl(value: unknown, label: string): string {
  const raw = text(value, label, 2048)
  let url: URL
  try { url = new URL(raw) } catch { throw new Error(`${label}无效`) }
  if (url.protocol !== 'https:' && !isLoopback(url)) throw new Error(`${label}必须使用 HTTPS`)
  if (url.username || url.password || url.hash) throw new Error(`${label}不能包含凭据或片段`)
  return url.href
}

/** catalog 中的 packagePath 必须是可跨平台安装的相对 POSIX 路径。 */
function packagePath(value: unknown, label: string): string {
  const raw = text(value, label, 240)
  if (raw.includes('\\') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    throw new Error(`${label}须为相对路径`)
  }
  const parts = raw.split('/')
  if (parts.length > 13) throw new Error(`${label}目录嵌套过深`)
  for (const part of parts) {
    if (!SEGMENT.test(part) || part.endsWith('.') || RESERVED.test(part) ||
        ['node_modules', '__proto__', 'prototype', 'constructor'].includes(part)) {
      throw new Error(`${label}包含不支持的路径段：${part}`)
    }
  }
  if (!parts[parts.length - 1].endsWith('.json')) throw new Error(`${label}须指向 .json 插件包`)
  return raw
}

/** 接受 owner/repo、GitHub 仓库/文件链接或完整索引地址，统一为 catalog.json 的下载地址。 */
export function normalizeSourceUrl(value: string): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) throw new Error('插件源地址不能为空')
  if (raw.length > 2048) throw new Error('插件源地址过长')
  if (OWNER_REPO.test(raw)) {
    const [owner, repo] = raw.split('/')
    return `${rawBase(owner, repo.replace(/\.git$/i, ''))}/HEAD/${SOURCE_CATALOG_FILE}`
  }
  let url: URL
  try { url = new URL(raw) } catch {
    throw new Error('插件源地址无效；可填写 owner/repo、GitHub 仓库链接或 catalog.json 地址')
  }
  if (url.protocol !== 'https:' && !isLoopback(url)) throw new Error('插件源必须使用 HTTPS 地址')
  if (url.username || url.password || url.hash) throw new Error('插件源地址不能包含凭据或片段')
  if (url.hostname === 'github.com') {
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
    if (parts.length < 2) throw new Error('GitHub 插件源地址缺少仓库名')
    const [owner, repo] = parts
    const rest = parts.slice(2)
    const base = rawBase(owner, repo.replace(/\.git$/i, ''))
    if (!rest.length) return `${base}/HEAD/${SOURCE_CATALOG_FILE}`
    if (rest[0] === 'tree' && rest.length > 1) return `${base}/${rest.slice(1).join('/')}/${SOURCE_CATALOG_FILE}`
    if (rest[0] === 'blob' && rest.length > 2) return `${base}/${rest.slice(1).join('/')}`
    throw new Error('GitHub 链接应指向仓库根目录、目录或 catalog.json')
  }
  if (url.pathname.endsWith('/')) {
    url.pathname += SOURCE_CATALOG_FILE
  } else if (url.hostname.endsWith('.github.io') && !/\.json$/i.test(url.pathname)) {
    url.pathname += '/' + SOURCE_CATALOG_FILE
  }
  return url.href
}

function rawBase(owner: string, repo: string): string {
  return `https://raw.githubusercontent.com/${owner}/${repo}`
}

/** 从 raw.githubusercontent.com 索引地址识别仓库，用于推导单插件 Release 资产地址。 */
function githubRepo(url: string): { owner: string; repo: string } | undefined {
  let parsed: URL
  try { parsed = new URL(url) } catch { return undefined }
  if (parsed.hostname !== 'raw.githubusercontent.com') return undefined
  const parts = parsed.pathname.replace(/^\/+/, '').split('/')
  if (parts.length < 4) return undefined
  return { owner: parts[0], repo: parts[1].replace(/\.git$/i, '') }
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) throw new Error('版本号无效')
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] - right.core[i]
  }
  if (!left.pre && !right.pre) return 0
  if (!left.pre) return 1
  if (!right.pre) return -1
  const length = Math.max(left.pre.length, right.pre.length)
  for (let i = 0; i < length; i++) {
    const x = left.pre[i]
    const y = right.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const nx = /^[0-9]+$/.test(x)
    const ny = /^[0-9]+$/.test(y)
    if (nx && ny) return Number(x) - Number(y)
    if (nx) return -1
    if (ny) return 1
    return x < y ? -1 : 1
  }
  return 0
}

function parseEntry(value: unknown, index: number): PluginCatalogEntry {
  const item = record(value)
  const label = `plugins[${index}]`
  const slug = text(item.slug, `${label}.slug`, 64)
  if (!SLUG.test(slug)) throw new Error(`插件目录名无效：${slug}`)
  const id = text(item.id, `${label}.id`, 96)
  if (!ID.test(id)) throw new Error(`插件 ID 无效：${id}`)
  if (item.apiVersion !== 1) throw new Error(`${id} 的 apiVersion 不受支持；当前仅支持 1`)
  const version = text(item.version, `${id}.version`, 64)
  if (!parseVersion(version)) throw new Error(`${id} 的版本号须为语义版本号`)
  const description = optionalText(item.description, `${id}.description`, 2048)
  const path = packagePath(item.packagePath, `${id}.packagePath`)
  const packageUrl = item.packageUrl === undefined ? undefined : httpsUrl(item.packageUrl, `${id}.packageUrl`)
  let sha: string | undefined
  if (item.sha256 !== undefined) {
    sha = text(item.sha256, `${id}.sha256`, 64).toLowerCase()
    if (!SHA256.test(sha)) throw new Error(`${id} 的 sha256 须为 64 位十六进制`)
  }
  return {
    slug,
    id,
    name: text(item.name, `${label}.name`, 128),
    version,
    apiVersion: 1,
    ...(description === undefined ? {} : { description }),
    packagePath: path,
    ...(packageUrl === undefined ? {} : { packageUrl }),
    ...(sha === undefined ? {} : { sha256: sha })
  }
}

export function parseSourceCatalog(value: unknown): PluginCatalog {
  const root = record(value)
  if (root.schemaVersion !== 1) throw new Error('插件目录版本不支持；当前仅支持 schemaVersion 1')
  if (root.apiVersion !== 1) throw new Error('插件目录 API 版本不支持；当前仅支持 1')
  if (!Array.isArray(root.plugins) || root.plugins.length > 100) {
    throw new Error('插件目录须包含至多 100 个插件')
  }
  const ids = new Set<string>()
  const slugs = new Set<string>()
  const plugins = root.plugins.map((raw: unknown, index: number) => {
    const entry = parseEntry(raw, index)
    if (ids.has(entry.id)) throw new Error('插件目录中的插件 ID 重复：' + entry.id)
    if (slugs.has(entry.slug)) throw new Error('插件目录中的插件目录名重复：' + entry.slug)
    ids.add(entry.id)
    slugs.add(entry.slug)
    return entry
  })
  return { schemaVersion: 1, apiVersion: 1, plugins }
}

/** 将目录与已安装版本合并成界面列表；目录版本较旧时不算可更新。 */
export function sourceItems(
  catalog: PluginCatalog, installed: ReadonlyMap<string, string>
): PluginSourceItem[] {
  return catalog.plugins.map((entry) => {
    const installedVersion = installed.get(entry.id)
    return {
      id: entry.id,
      name: entry.name,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      version: entry.version,
      ...(installedVersion === undefined ? {} : { installedVersion }),
      updateAvailable: installedVersion === undefined || compareVersions(entry.version, installedVersion) > 0
    }
  })
}

function filenameOf(url: string): string {
  const name = new URL(url).pathname.split('/').pop() ?? ''
  try { return decodeURIComponent(name) } catch { return name }
}

function checksumsUrl(url: string): string {
  return new URL('SHA256SUMS', url).href
}

/**
 * 同一插件版本的下载候选：GitHub raw 索引优先尝试单插件 Release 资产，
 * 再回退到 packagePath（适用于已提交 dist/ 或 GitHub Pages 发布）。
 */
export function packageSources(catalogUrl: string, entry: PluginCatalogEntry): PluginPackageSource[] {
  const filename = entry.packagePath.split('/').pop() ?? ''
  const withHash = (url: string): PluginPackageSource => ({
    url,
    checksumsUrl: checksumsUrl(url),
    ...(entry.sha256 === undefined ? {} : { sha256: entry.sha256 })
  })
  if (entry.packageUrl) return [withHash(entry.packageUrl)]
  const sources: PluginPackageSource[] = []
  const repo = githubRepo(catalogUrl)
  if (repo) {
    const tag = `${entry.slug}/v${entry.version}`
    sources.push(withHash(
      `https://github.com/${repo.owner}/${repo.repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(filename)}`
    ))
  }
  const relative = new URL(entry.packagePath, catalogUrl).href
  if (!sources.some((source) => source.url === relative)) sources.push(withHash(relative))
  return sources
}

export function parseChecksums(value: string, filename: string): string {
  for (const line of value.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+?)\s*$/i.exec(line.trim())
    if (match && match[2] === filename) return match[1].toLowerCase()
  }
  throw new Error(`SHA256SUMS 中缺少 ${filename} 的校验值`)
}

async function readLimited(response: Response, max: number, label: string): Promise<Buffer> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error(`${label}没有返回内容`)
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > max) throw new Error(`${label}超过大小上限`)
      chunks.push(Buffer.from(value))
    }
  } finally { void reader.cancel().catch(() => {}) }
  return Buffer.concat(chunks)
}

class SourceRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

async function request(
  url: string, timeoutMs: number, fetchImpl: SourceFetch, label: string
): Promise<Response> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      redirect: 'follow',
      headers: { Accept: 'application/json, text/plain, */*', 'Cache-Control': 'no-cache', 'User-Agent': 'DevKit' },
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (error) {
    if ((error as Error).name === 'TimeoutError') throw new Error(`访问${label}超时，请检查网络`)
    throw new Error(`无法访问${label}，请检查网络或地址`)
  }
  if (!response.ok) throw new SourceRequestError(`${label}请求失败（HTTP ${response.status}）`, response.status)
  return response
}

export async function fetchSourceCatalog(
  url: string, fetchImpl: SourceFetch = fetch
): Promise<PluginCatalog> {
  const response = await request(url, 10_000, fetchImpl, '插件源')
  const bytes = await readLimited(response, MAX_SOURCE_CATALOG_BYTES, '插件源目录')
  let value: unknown
  try { value = JSON.parse(new TextDecoder().decode(bytes)) } catch { throw new Error('插件源目录不是有效 JSON') }
  return parseSourceCatalog(value)
}

async function downloadOne(source: PluginPackageSource, fetchImpl: SourceFetch): Promise<Buffer> {
  const filename = filenameOf(source.url)
  let expected = source.sha256
  if (expected === undefined) {
    const response = await request(source.checksumsUrl, 10_000, fetchImpl, '插件包校验文件')
    const bytes = await readLimited(response, MAX_CHECKSUMS_BYTES, '插件包校验文件')
    expected = parseChecksums(bytes.toString('utf8'), filename)
  }
  const response = await request(source.url, 30_000, fetchImpl, '插件包')
  const bytes = await readLimited(response, MAX_PACKAGE_BYTES, '插件包')
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== expected.toLowerCase()) throw new Error('插件包校验失败（SHA-256 不匹配），已取消安装')
  return bytes
}

/** 依次尝试候选位置；只有 404 会回退，网络错误或校验失败立即终止。 */
export async function downloadSourceBundle(
  sources: PluginPackageSource[], fetchImpl: SourceFetch = fetch
): Promise<Buffer> {
  if (!sources.length) throw new Error('插件目录没有可用的安装包地址')
  for (const source of sources) {
    try {
      return await downloadOne(source, fetchImpl)
    } catch (error) {
      if (!(error instanceof SourceRequestError) || error.status !== 404) throw error
    }
  }
  throw new Error('插件包尚未发布（HTTP 404）：请确认仓库已发布该版本的 Release 资产，或已提交 dist/ 构建产物')
}
