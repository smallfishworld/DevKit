import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import type { UpdateRelease } from '../../../shared/app-updates'

const REPOSITORY = 'smallfishworld/DevKit'
export const RELEASE_HOME = `https://github.com/${REPOSITORY}/releases`
const RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`
const VERSION = /^(0|[1-9]\d{0,14})\.(0|[1-9]\d{0,14})\.(0|[1-9]\d{0,14})$/
const SHA256 = /^[a-f\d]{64}$/
const MAX_PACKAGE = 2 * 1024 * 1024 * 1024

export type PackageFormat = 'portable' | 'zip'
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>
export type ReleaseResult = { status: 'current' | 'publishing' } | { status: 'available'; update: UpdatePackage }

export interface UpdatePackage extends UpdateRelease {
  tag: string
  hash: string
}

const RELEASE_LATEST = `${RELEASE_HOME}/latest`
const TAG_PATH = /\/releases\/tag\/([^/?#]+)/

/** API 匿名配额耗尽时，更新信息改走发布页回退通道（github.com 网页端点无 API 配额限制） */
const FALLBACK_NOTES = 'GitHub API 暂时限流，本次更新信息通过发布页回退通道获取。'

/** API 403/429 或退避期内抛出；调用方以此触发发布页回退通道 */
export class RateLimitError extends Error {
  constructor() {
    super('GitHub 请求受限，请稍后再检查。')
    this.name = 'RateLimitError'
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

export function isNewerVersion(candidate: string, current: string): boolean {
  if (!VERSION.test(candidate) || !VERSION.test(current)) return false
  const actual = current.split('.').map(Number)
  const proposed = candidate.split('.').map(Number)
  const firstDifference = proposed.findIndex((part, index) => part !== actual[index])
  return firstDifference >= 0 && proposed[firstDifference] > actual[firstDifference]
}

export function packageName(version: string, format: PackageFormat): string {
  return format === 'portable' ? `DevKit-${version}-portable.exe` : `DevKit-${version}-win-x64.zip`
}

export function readPendingUpdate(value: unknown, current: string): UpdatePackage | undefined {
  const { version, notes, bytes, tag, hash } = record(value)
  if (typeof version !== 'string' || !isNewerVersion(version, current) ||
      (tag !== version && tag !== `v${version}`) || typeof hash !== 'string' || !SHA256.test(hash) ||
      typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_PACKAGE ||
      typeof notes !== 'string') return undefined
  return { version, notes: notes.slice(0, 24_000), bytes, tag, hash }
}

export function parseRelease(value: unknown, current: string, format?: PackageFormat): ReleaseResult {
  const { draft, prerelease, tag_name: tag, assets, body } = record(value)
  if (typeof tag !== 'string' || draft !== false || prerelease !== false || !Array.isArray(assets)) {
    if (typeof tag === 'string' && (draft === true || prerelease === true)) return { status: 'current' }
    throw new Error('GitHub 返回了无法识别的发布信息。')
  }
  const version = tag.replace(/^v/, '')
  if (!isNewerVersion(version, current)) return { status: 'current' }
  const notes = typeof body === 'string' ? body.split(/^## 下载\s*$/m, 1)[0].trim().slice(0, 24_000) : ''
  if (!format) {
    if (tag !== version && tag !== `v${version}`) throw new Error('GitHub 返回了无法识别的发布信息。')
    return { status: 'available', update: { version, tag, notes, bytes: 0, hash: '' } }
  }
  const asset = assets.map(record).find((entry) => entry.name === packageName(version, format) && entry.state === 'uploaded')
  const update = readPendingUpdate({
    version, tag, notes,
    bytes: asset?.size,
    hash: typeof asset?.digest === 'string' && asset.digest.startsWith('sha256:') ? asset.digest.slice(7) : undefined
  }, current)
  return update ? { status: 'available', update } : { status: 'publishing' }
}

export class GitHubReleases {
  private cached?: { etag: string | null; body: unknown }
  private retryAfter = 0

  constructor(private readonly fetch: Fetch) {}

  async latest(current: string, format?: PackageFormat): Promise<ReleaseResult> {
    if (Date.now() < this.retryAfter) throw new RateLimitError()
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': `DevKit/${current}`
    }
    if (this.cached?.etag) headers['If-None-Match'] = this.cached.etag
    const response = await this.fetch(RELEASE_API, {
      headers, redirect: 'error', signal: AbortSignal.timeout(12_000)
    })
    if (response.status === 304 && this.cached) return parseRelease(this.cached.body, current, format)
    if (response.status === 404) return { status: 'current' }
    if (response.status === 403 || response.status === 429) {
      const retry = Number(response.headers.get('retry-after'))
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000
      this.retryAfter = Math.max(Date.now() + Math.max(retry || 0, 60) * 1000, reset || 0)
      throw new RateLimitError()
    }
    if (!response.ok) throw new Error(`GitHub 检查失败（HTTP ${response.status}）。`)
    const body: unknown = await response.json()
    const result = parseRelease(body, current, format)
    this.cached = { etag: response.headers.get('etag'), body }
    return result
  }

  /**
   * API 被限时的零配额回退通道：
   * 1. `releases/latest` 的 302 跳转 Location 解析最新稳定版 tag（github.com 网页端点，无 API 配额）；
   * 2. 包大小取自发布直链响应的 Content-Length；
   * 3. SHA-256 取自随包上传的 `<包名>.sha256` 边车附件（CI 发布时生成）。
   * 旧版本发布没有边车、或拿不到包大小时返回 undefined，调用方提示手动下载。
   */
  async fallbackLatest(current: string, format?: PackageFormat): Promise<ReleaseResult | undefined> {
    const response = await this.fetch(RELEASE_LATEST, {
      headers: { 'User-Agent': `DevKit/${current}` }, redirect: 'manual', signal: AbortSignal.timeout(12_000)
    })
    const to = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null
    await response.body?.cancel()
    // 无跳转（仓库还没有稳定发布）→ 视为已是最新；其余异常一律放弃回退
    if (!to) return response.ok ? { status: 'current' } : undefined
    const target = new URL(to, RELEASE_LATEST)
    if (target.protocol !== 'https:' || target.hostname !== 'github.com') return undefined
    const tag = TAG_PATH.exec(target.pathname)?.[1]
    const version = tag ? decodeURIComponent(tag).replace(/^v/, '') : ''
    if (!tag || !VERSION.test(version)) return undefined
    if (!isNewerVersion(version, current)) return { status: 'current' }
    const normalizedTag = `v${version}`
    if (!format) {
      return { status: 'available', update: { version, tag: normalizedTag, notes: FALLBACK_NOTES, bytes: 0, hash: '' } }
    }
    const assetUrl = `${RELEASE_HOME}/download/${normalizedTag}/${packageName(version, format)}`
    const bytes = await this.probeContentLength(assetUrl)
    if (!bytes) return undefined
    const sidecar = await this.fetchAsset(`${assetUrl}.sha256`, AbortSignal.timeout(12_000))
    const text = sidecar.ok ? (await sidecar.text()).slice(0, 2048) : ''
    const hash = /^([a-f\d]{64})/i.exec(text)?.[1]
    if (!hash) return undefined
    const update = readPendingUpdate({ version, tag: normalizedTag, notes: FALLBACK_NOTES, bytes, hash }, current)
    return update ? { status: 'available', update } : undefined
  }

  /** GET 发布直链只取 Content-Length（不消费正文），应用内下载时按字节与哈希双重校验 */
  private async probeContentLength(url: string): Promise<number | undefined> {
    const response = await this.fetchAsset(url, AbortSignal.timeout(12_000))
    const size = Number(response.headers.get('content-length'))
    void response.body?.cancel()
    return Number.isSafeInteger(size) && size > 0 ? size : undefined
  }

  async download(
    update: UpdatePackage,
    format: PackageFormat,
    destination: string,
    progress: (received: number) => void
  ): Promise<void> {
    const url = `${RELEASE_HOME}/download/${update.tag}/${packageName(update.version, format)}`
    const abort = new AbortController()
    let deadline = setTimeout(() => abort.abort(), 30_000)
    const refreshDeadline = (): void => {
      clearTimeout(deadline)
      deadline = setTimeout(() => abort.abort(), 30_000)
    }
    try {
      const response = await this.fetchAsset(url, abort.signal)
      if (!response.ok || !response.body) throw new Error(`更新包下载失败（HTTP ${response.status}）。`)
      let received = 0
      let progressAt = 0
      const hash = createHash('sha256')
      await pipeline(response.body, async function* (source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          refreshDeadline()
          received += chunk.byteLength
          if (received > update.bytes) throw new Error('更新包大小与发布信息不符。')
          hash.update(chunk)
          const now = Date.now()
          if (now - progressAt >= 125) {
            progressAt = now
            progress(received)
          }
          yield chunk
        }
      }, createWriteStream(destination, { flags: 'wx' }), { signal: abort.signal })
      if (received !== update.bytes || hash.digest('hex') !== update.hash) throw new Error('更新包完整性校验失败。')
    } finally {
      clearTimeout(deadline)
      abort.abort()
    }
  }

  private async fetchAsset(url: string, signal: AbortSignal): Promise<Response> {
    let next = new URL(url)
    for (let redirects = 0; redirects <= 4; redirects++) {
      if (next.protocol !== 'https:' || next.username || next.password || next.port ||
          !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(next.hostname)) {
        throw new Error('GitHub 返回了无效的更新包地址。')
      }
      const response = await this.fetch(next.href, { redirect: 'manual', signal })
      if (![301, 302, 303, 307, 308].includes(response.status)) return response
      const target = response.headers.get('location')
      await response.body?.cancel()
      if (!target) break
      next = new URL(target, next)
    }
    throw new Error('GitHub 更新包跳转失败。')
  }
}
