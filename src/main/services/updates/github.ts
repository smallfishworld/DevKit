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
/**
 * tag 页里的版本提取：`releases/latest` 跳转后的页面（canonical / og:url 均带 /releases/tag/<tag>）。
 * Electron 的 net.fetch 以 redirect:'manual' 请求时拿不到 302 的 Location（直接取消跳转），
 * 只能 follow 到 tag 页再从 HTML 里解析；版本段后禁止再出现字母数字连字符，避免把
 * `v0.12.0-beta.1` 截成 `v0.12.0`。
 */
const TAG_IN_PAGE = /releases\/tag\/(v?(?:0|[1-9]\d{0,14})\.(?:0|[1-9]\d{0,14})\.(?:0|[1-9]\d{0,14}))(?=[^0-9A-Za-z._-]|$)/
/** 发布正文容器（GitHub 渲染发布说明的位置） */
const BODY_CONTENT_ANCHOR = 'data-test-selector="body-content"'
/** 说明里「下载」小节标题行：与 API 路径按 `## 下载` 截断同义 */
const DOWNLOAD_HEADING = /^[ \t]*下载[ \t]*$/m

/** 极简 HTML → 纯文本：去掉标签间空白、块级元素换行、列表加圆点、去标签、解码实体、逐行收边 */
function htmlToText(html: string): string {
  return html
    .replace(/>\s+</g, '><')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/(p|ul|ol|h[1-6]|div|tr|blockquote|pre|table)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 从已拉取的最新发布页 HTML 提取发布说明纯文本，让回退通道展示真实更新内容而不是占位文案。
 * 正文容器为 `data-test-selector="body-content"` 的 markdown-body div，按 div 深度找配对闭合；
 * 与 API 路径一致，截到「下载」小节为止。结构变化时返回 undefined，由调用方落到占位文案。
 */
export function releaseNotesFromTagPage(html: string): string | undefined {
  const anchor = html.indexOf(BODY_CONTENT_ANCHOR)
  if (anchor < 0) return undefined
  const start = html.lastIndexOf('<div', anchor)
  if (start < 0) return undefined
  const divTag = /<\/?div\b[^>]*>/g
  divTag.lastIndex = start
  let depth = 0
  let end = -1
  for (let match: RegExpExecArray | null; (match = divTag.exec(html));) {
    depth += match[0][1] === '/' ? -1 : 1
    if (depth === 0) {
      end = match.index + match[0].length
      break
    }
  }
  if (end < 0) return undefined
  const text = htmlToText(html.slice(start, end))
  if (text.length < 8) return undefined
  const download = text.search(DOWNLOAD_HEADING)
  return (download >= 0 ? text.slice(0, download) : text).trim() || undefined
}

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
   * API 被限时的零配额回退通道（全程 github.com 网页端点，无 API 配额；跳转一律 follow）：
   * 1. `releases/latest` follow 到最新稳定版 tag 页，从页面里的 `/releases/tag/<tag>` 解析版本；
   * 2. 包大小取自发布直链响应的 Content-Length；
   * 3. SHA-256 取自随包上传的 `<包名>.sha256` 边车附件（CI 发布时生成）。
   * 拿不到页面、包大小或边车哈希时返回 undefined，调用方提示手动下载。
   */
  async fallbackLatest(current: string, format?: PackageFormat): Promise<ReleaseResult | undefined> {
    const response = await this.fetch(RELEASE_LATEST, {
      headers: { 'User-Agent': `DevKit/${current}` }, redirect: 'follow', signal: AbortSignal.timeout(12_000)
    })
    if (!response.ok) {
      await response.body?.cancel()
      return undefined
    }
    // 同一份页面既解析版本号也提取发布说明（零额外请求）；提取失败落到占位文案
    const html = await response.text()
    const tag = TAG_IN_PAGE.exec(html)?.[1]
    const version = tag?.replace(/^v/, '')
    if (!version || !VERSION.test(version)) return undefined
    const notes = releaseNotesFromTagPage(html) ?? FALLBACK_NOTES
    if (!isNewerVersion(version, current)) return { status: 'current' }
    const normalizedTag = `v${version}`
    if (!format) {
      return { status: 'available', update: { version, tag: normalizedTag, notes, bytes: 0, hash: '' } }
    }
    const assetUrl = `${RELEASE_HOME}/download/${normalizedTag}/${packageName(version, format)}`
    const bytes = await this.probeContentLength(assetUrl)
    if (!bytes) return undefined
    const sidecar = await this.fetchAsset(`${assetUrl}.sha256`, AbortSignal.timeout(12_000))
    const text = sidecar.ok ? (await sidecar.text()).slice(0, 2048) : ''
    const hash = /^([a-f\d]{64})/i.exec(text)?.[1]
    if (!hash) return undefined
    const update = readPendingUpdate({ version, tag: normalizedTag, notes, bytes, hash }, current)
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

  /**
   * GET 发布资产（直链会跳到 GitHub CDN，跟随跳转；入口 URL 只能由本模块用校验过的
   * 版本号拼出，下载完成后另有字节与哈希双重校验兜底）。
   */
  private async fetchAsset(url: string, signal: AbortSignal): Promise<Response> {
    const target = new URL(url)
    if (target.protocol !== 'https:' || target.username || target.password || target.port ||
        target.hostname !== 'github.com') {
      throw new Error('GitHub 返回了无效的更新包地址。')
    }
    return this.fetch(url, { redirect: 'follow', signal })
  }
}
