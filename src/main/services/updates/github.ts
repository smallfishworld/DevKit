import { createHash, type Hash } from 'node:crypto'
import { open, type FileHandle } from 'node:fs/promises'
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

// ---------- 下载源 ----------

/**
 * 内置的 GitHub 发布包加速镜像：把官方直链整个接在镜像前缀后面。
 * 到 GitHub CDN 的链路常常整条被限速——多开连接实测不会更快（8 段、16 段并行合计与单连接相当），
 * 所以提速靠换源而不靠分段。公共镜像稳定性差（2026-11 实测 11 个里 7 个不可用），
 * 因此只做「官方直连慢时的备选」，并允许用配置 `updates.mirrors` 整体替换。
 */
export const DEFAULT_MIRRORS = ['https://gh-proxy.com/', 'https://ghfast.top/']
/** 官方直连达到这个速度就不去麻烦镜像（最大的包约 80 秒下完） */
export const DIRECT_ENOUGH_BPS = 2 * 1024 * 1024
/** 镜像至少比直连快一倍、且不低于这个速度，才值得把流量交给第三方 */
export const MIN_MIRROR_BPS = 512 * 1024
/** 测速窗口；窗口内读满 probeBytes 即可提前下结论，避免在快链路上白扔流量 */
const PROBE_MS = 4000
const PROBE_BYTES = 8 * 1024 * 1024
/** 测速阶段等响应头的宽限（有的镜像先回 200 再迟迟不吐数据，有的干脆不响应） */
const PROBE_HEAD_GRACE_MS = 6000
/** 首字节之前、以及两个数据块之间，超过这个时长没有数据视为卡死 */
const IDLE_MS = 30_000
/** 同一来源的最多尝试次数：中途断开就从已写入的位置续传 */
const MAX_ATTEMPTS = 4
/** 自己抛出的下载错误：重试同一来源没有意义，直接换下一个来源 */
const FATAL_TRANSFER = /^(更新包|GitHub)/

/** 连接正常结束但字节数不够（对端截断）：先按已写入的位置续传，续不满就是完整性校验失败 */
class ShortTransfer extends Error {
  constructor() {
    super('更新包完整性校验失败。')
  }
}

export interface DownloadOptions {
  /** 镜像前缀列表；缺省用内置镜像，给空数组表示不用镜像 */
  mirrors?: string[]
  /** 选定下载源时回调：官方直连为 undefined，镜像为主机名 */
  onSource?: (source: string | undefined) => void
}

export interface SourceProbe {
  bytes: number
  seconds: number
  /** 探测失败的原因：网络错误、HTTP 错误或大小与发布信息不符 */
  error?: string
}

/** 镜像前缀 → 实际下载地址（官方直链整个接在后面）。只接受不带凭据、查询串和片段的 https 前缀 */
export function mirrorUrl(prefix: string, target: string): string | undefined {
  let url: URL
  try {
    url = new URL(prefix.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) return undefined
  return url.href.endsWith('/') ? url.href + target : url.href + '/' + target
}

/** 配置里的镜像列表 → 合法前缀（去重，最多 8 个） */
export function sanitizeMirrors(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const items = value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
  return [...new Set(items)].slice(0, 8)
}

function probeRate(probe: SourceProbe): number {
  // 耗时下限 1ms：极快的来源可能在同一毫秒内读完，不能因此把速率算成 0 而排除掉
  return probe.error ? 0 : probe.bytes / Math.max(probe.seconds, 0.001)
}

/**
 * 下载源顺序。官方直连够快 → 只用官方，不联系任何第三方；
 * 否则把「可用且明显快于直连」的镜像按速度排在前面，官方留作最后的兜底。
 */
export function rankDownloadSources(
  official: { url: string; probe: SourceProbe },
  mirrors: Array<{ url: string; label: string; probe: SourceProbe }>
): Array<{ url: string; label?: string }> {
  const direct = probeRate(official.probe)
  if (!official.probe.error && direct >= DIRECT_ENOUGH_BPS) return [{ url: official.url }]
  const faster = mirrors
    .filter((mirror) => probeRate(mirror.probe) >= Math.max(MIN_MIRROR_BPS, direct * 2))
    .sort((a, b) => probeRate(b.probe) - probeRate(a.probe))
    .map((mirror) => ({ url: mirror.url, label: mirror.label }))
  return [...faster, { url: official.url }]
}

/** 带 content-length 的响应必须与发布信息对得上（续传时加上已下载的偏移） */
function lengthMismatch(header: string | null, expectedBytes: number, offset: number): string | undefined {
  const length = Number(header)
  return header && Number.isSafeInteger(length) && length > 0 && offset + length !== expectedBytes
    ? '更新包大小与发布信息不符。'
    : undefined
}

/** 把一块数据完整写到指定偏移（fs 可能只写一部分） */
async function writeAt(handle: FileHandle, chunk: Uint8Array, position: number): Promise<void> {
  let written = 0
  while (written < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, written, chunk.byteLength - written, position + written)
    if (bytesWritten <= 0) throw new Error('更新包写入失败。')
    written += bytesWritten
  }
}

/**
 * 逐块读取响应体。每次读取都与「多久没有新数据」赛跑，不指望 fetch 对 abort 的响应是否及时：
 * 更新服务一旦卡在读取上，忙标志就永远不复位，用户连重试都做不了。
 * 返回读取为何结束：eof=对端正常结束，stopped=调用方说够了，idle=超时没等到数据。
 */
async function readBody(
  body: ReadableStream<Uint8Array>,
  idleMs: () => number,
  onChunk: (chunk: Uint8Array) => Promise<void> | void,
  enough?: () => boolean
): Promise<'eof' | 'stopped' | 'idle'> {
  const reader = body.getReader()
  let timer: NodeJS.Timeout | undefined
  try {
    for (;;) {
      const wait = idleMs()
      if (wait <= 0) return 'idle'
      const chunk = await new Promise<{ done: boolean; value?: Uint8Array } | null>((resolve, reject) => {
        timer = setTimeout(() => resolve(null), wait)
        reader.read().then(resolve, reject)
      })
      clearTimeout(timer)
      if (chunk === null) return 'idle'
      if (chunk.done || !chunk.value) return 'eof'
      await onChunk(chunk.value)
      if (enough?.()) return 'stopped'
    }
  } finally {
    clearTimeout(timer)
    await reader.cancel().catch(() => {})
  }
}

/** 赛跑用的超时哨兵：到时 resolves null；用完 cancel，免得定时器拖住进程 */
function sentinel(ms: number): { promise: Promise<null>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined
  const promise = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
    timer.unref?.()
  })
  return { promise, cancel: () => clearTimeout(timer) }
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

  constructor(
    private readonly fetch: Fetch,
    /** 测速窗口、提前量与无数据超时；测试注入短时长 */
    private readonly timing = { probeMs: PROBE_MS, probeBytes: PROBE_BYTES, idleMs: IDLE_MS }
  ) {}

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

  /**
   * 下载更新包到 destination，完成后按字节与 SHA-256 双重校验（所以经任何第三方镜像都篡改不了结果）。
   * 选源见 rankDownloadSources；同一来源中途断开时从已写入的位置续传，
   * 续不下去或内容不符就换下一个来源从头再来。
   */
  async download(
    update: UpdatePackage,
    format: PackageFormat,
    destination: string,
    progress: (received: number) => void,
    options: DownloadOptions = {}
  ): Promise<void> {
    const official = `${RELEASE_HOME}/download/${update.tag}/${packageName(update.version, format)}`
    const direct = await this.probe(official, update.bytes)
    const mirrors: Array<{ url: string; label: string; probe: SourceProbe }> = []
    // 官方直连够快就不去探测镜像：不联系任何第三方，也不白等测速窗口
    if (direct.error || probeRate(direct) < DIRECT_ENOUGH_BPS) {
      const targets = [...new Set((options.mirrors ?? DEFAULT_MIRRORS).map((prefix) => mirrorUrl(prefix, official)))]
        .filter((url): url is string => url !== undefined)
      await Promise.all(targets.map(async (url) => {
        mirrors.push({ url, label: new URL(url).hostname, probe: await this.probe(url, update.bytes) })
      }))
    }
    let failure: unknown
    for (const [index, source] of rankDownloadSources({ url: official, probe: direct }, mirrors).entries()) {
      options.onSource?.(source.label)
      if (index > 0) progress(0)
      try {
        await this.saveFrom(source.url, update, destination, progress)
        return
      } catch (error) {
        failure = error
      }
    }
    throw failure
  }

  /** 读一小段时间估算吞吐（读完即弃，不落盘）；带 content-length 的响应顺带核对大小 */
  private async probe(url: string, expectedBytes: number): Promise<SourceProbe> {
    const controller = new AbortController()
    // 只约束「连响应头都不给」；给了头之后慢吞吐的由读取窗口收尾
    const headers = sentinel(this.timing.probeMs + PROBE_HEAD_GRACE_MS)
    const started = Date.now()
    const seconds = (): number => (Date.now() - started) / 1000
    try {
      const response = await Promise.race([
        headers.promise,
        this.fetch(url, { redirect: 'follow', signal: controller.signal })
      ])
      if (response === null) return { bytes: 0, seconds: seconds(), error: 'no response' }
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        return { bytes: 0, seconds: seconds(), error: `HTTP ${response.status}` }
      }
      const mismatch = lengthMismatch(response.headers.get('content-length'), expectedBytes, 0)
      if (mismatch) {
        await response.body.cancel()
        return { bytes: 0, seconds: seconds(), error: mismatch }
      }
      let bytes = 0
      // 两次数据之间的等待以窗口剩余时间为限：先回响应头再迟迟不吐数据的镜像拖不满整个宽限期
      await readBody(
        response.body,
        () => this.timing.probeMs - (Date.now() - started),
        (chunk) => {
          bytes += chunk.byteLength
        },
        () => bytes >= this.timing.probeBytes
      )
      return { bytes, seconds: seconds() }
    } catch (error) {
      return { bytes: 0, seconds: seconds(), error: error instanceof Error ? error.message : String(error) }
    } finally {
      headers.cancel()
      controller.abort()
    }
  }

  /** 从单个来源写到文件：中途断开就从这里续传，续不下去再交给调用方换源 */
  private async saveFrom(
    url: string,
    update: UpdatePackage,
    destination: string,
    progress: (received: number) => void
  ): Promise<void> {
    const state = { received: 0, hash: createHash('sha256') }
    const handle = await open(destination, 'w')
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          await this.transfer(url, update, handle, state, progress)
          break
        } catch (error) {
          // 自己抛出的错误（大小不符、HTTP 失败、写盘失败）重试没有意义；网络中断、提前结束才续传
          const fatal = error instanceof Error && !(error instanceof ShortTransfer) && FATAL_TRANSFER.test(error.message)
          if (attempt >= MAX_ATTEMPTS || fatal) throw error
        }
      }
    } finally {
      await handle.close()
    }
    if (state.received !== update.bytes || state.hash.digest('hex') !== update.hash) {
      throw new Error('更新包完整性校验失败。')
    }
  }

  /** 单次传输：从 state.received 处续传（服务端无视区间时从头重来），边写文件边同步哈希 */
  private async transfer(
    url: string,
    update: UpdatePackage,
    handle: FileHandle,
    state: { received: number; hash: Hash },
    progress: (received: number) => void
  ): Promise<void> {
    const controller = new AbortController()
    // 首字节之前同样受「多久没有数据」限制
    const headers = sentinel(this.timing.idleMs)
    const response = await Promise.race([
      headers.promise,
      this.fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        ...(state.received > 0 ? { headers: { Range: `bytes=${state.received}-` } } : {})
      })
    ]).finally(headers.cancel)
    try {
      if (response === null) throw new Error('连接超时')
      const resuming = state.received > 0
      const range = /^bytes (\d+)-\d+\/(\d+)$/.exec(response.headers.get('content-range') ?? '')
      if (resuming && response.status === 206 && range && response.body) {
        if (Number(range[1]) !== state.received || Number(range[2]) !== update.bytes) {
          await response.body.cancel()
          throw new Error('更新包大小与发布信息不符。')
        }
      } else {
        // 服务端不支持区间、回了整包：只能从头再来
        if (resuming) {
          await handle.truncate(0)
          state.received = 0
          state.hash = createHash('sha256')
        }
        if (!response.ok || !response.body) {
          await response.body?.cancel()
          throw new Error(`更新包下载失败（HTTP ${response.status}）。`)
        }
        const mismatch = lengthMismatch(response.headers.get('content-length'), update.bytes, state.received)
        if (mismatch) {
          await response.body.cancel()
          throw new Error(mismatch)
        }
      }
      let position = state.received
      let progressAt = 0
      const outcome = await readBody(response.body, () => this.timing.idleMs, async (value) => {
        state.received += value.byteLength
        if (state.received > update.bytes) throw new Error('更新包大小与发布信息不符。')
        state.hash.update(value)
        await writeAt(handle, value, position)
        position += value.byteLength
        const now = Date.now()
        if (now - progressAt >= 125) {
          progressAt = now
          progress(state.received)
        }
      }, () => state.received >= update.bytes)
      // 卡死或提前结束都不是定论：交给上层从已写入的位置续传
      if (state.received !== update.bytes) throw outcome === 'idle' ? new Error('传输超时') : new ShortTransfer()
    } finally {
      controller.abort()
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
