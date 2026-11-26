const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { mkdtemp, readFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { test } = require('node:test')
const {
  DEFAULT_MIRRORS, GitHubReleases, RateLimitError, isNewerVersion, mirrorUrl, packageName, parseRelease,
  rankDownloadSources, readPendingUpdate, sanitizeMirrors
} = require('../src/main/services/updates/github')
const {
  applyFailureMessage, createSpeedEstimator, downloadPercent, downloadSourceLabel, formatMegabytes, formatSpeed,
  leftoverNotice, parseLeftover, preflightRefusal, updateNotice
} = require('../src/shared/app-updates')

const data = Buffer.from('fixture Windows update')
const hash = createHash('sha256').update(data).digest('hex')
// 发布包文件名不带版本号（解压出来的目录名才不会随版本变）；版本只出现在发布 tag 的路径里
const entry = 'https://github.com/smallfishworld/DevKit/releases/download/v0.12.0/DevKit-win-x64.zip'
/** 测试用短时序：测速窗口 30ms，无数据上限 500ms */
const quick = { probeMs: 30, probeBytes: 8 * 1024 * 1024, idleMs: 500 }
// 2 MiB 的确定性数据：够大，才能在测速窗口里分出「快」与「慢」
const big = Buffer.alloc(2 * 1024 * 1024)
for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) % 251
const bigHash = createHash('sha256').update(big).digest('hex')
const bigUpdate = { version: '0.12.0', tag: 'v0.12.0', notes: '', bytes: big.length, hash: bigHash }

/** 把一段数据变成响应；给 range 时按区间回 206 */
function serve(buffer, { status = 200, range } = {}) {
  const body = range ? buffer.slice(range.from, range.to + 1) : buffer
  const headers = range
    ? { 'content-length': String(body.byteLength), 'content-range': `bytes ${range.from}-${range.to}/${buffer.length}` }
    : { 'content-length': String(buffer.byteLength) }
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(body.slice(0, 64 * 1024))
      if (body.byteLength > 64 * 1024) controller.enqueue(body.slice(64 * 1024))
      controller.close()
    }
  }), { status, headers })
}

/** 先正常给到 upto 字节，下一次读取时连接被重置（声明的是整包大小） */
function brokenAfter(buffer, upto) {
  let sent = false
  return new Response(new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true
        controller.enqueue(buffer.slice(0, upto))
        return
      }
      controller.error(new TypeError('net::ERR_CONNECTION_RESET'))
    }
  }), { headers: { 'content-length': String(buffer.byteLength) } })
}

/** 慢链路：吐 1 KiB 后再没有数据（测速窗口内只读得到这么多） */
function stalled(buffer) {
  return new Response(new ReadableStream({
    start(controller) { controller.enqueue(buffer.slice(0, 1024)) }
  }), { headers: { 'content-length': String(buffer.length) } })
}
const fixtures = ['portable', 'zip'].map((format) => ({
  name: packageName(format), size: data.length, digest: 'sha256:' + hash, state: 'uploaded'
}))
const release = {
  tag_name: 'v0.12.0', draft: false, prerelease: false,
  body: '## 更新内容\n\n- Windows 修复\n\n## 下载\n便携版与 ZIP',
  assets: [{ name: 'DevKit-latest.exe', digest: 'sha256:' + hash, size: 100 }, ...fixtures]
}
const update = parseRelease(release, '0.9.0', 'zip').update

test('strict stable version precedence and exact platform attachment', () => {
  assert.equal(isNewerVersion('0.10.0', '0.9.0'), true)
  assert.equal(isNewerVersion('1.0.0', '0.99.99'), true)
  for (const version of ['0.9.0', '0.8.12', '0.10.0-beta.1', '00.10.0', '0.10']) {
    assert.equal(isNewerVersion(version, '0.9.0'), false, version)
  }
  for (const format of ['portable', 'zip']) {
    const result = parseRelease(release, '0.9.0', format)
    assert.equal(result.status, 'available')
    assert.equal(result.update.hash, hash)
    assert.equal(result.update.notes, '## 更新内容\n\n- Windows 修复')
  }
  assert.equal(parseRelease({ ...release, assets: fixtures.slice(0, 1) }, '0.9.0', 'zip').status, 'publishing')
  assert.equal(parseRelease({ ...release, assets: [{ ...fixtures[1], state: 'starter' }] }, '0.9.0', 'zip').status, 'publishing')
  assert.equal(parseRelease({ ...release, assets: [{ ...fixtures[1], digest: null }] }, '0.9.0', 'zip').status, 'publishing')
  assert.equal(parseRelease({ ...release, prerelease: true }, '0.9.0', 'zip').status, 'current')
  assert.equal(parseRelease({ ...release, draft: true }, '0.9.0', 'zip').status, 'current')
})

test('cached metadata rejects downgrade, unbounded sizes and path-like tags', () => {
  assert.deepEqual(readPendingUpdate(update, '0.9.0'), update)
  assert.equal(readPendingUpdate(update, '0.12.0'), undefined)
  assert.equal(readPendingUpdate({ ...update, bytes: Infinity }, '0.9.0'), undefined)
  assert.equal(readPendingUpdate({ ...update, tag: 'v0.12.0/../../abc' }, '0.9.0'), undefined)
})

test('conditional GitHub checks, partially published release and rate limit', async () => {
  let requests = 0
  const fetch = async (url, init) => {
    assert.equal(url, 'https://api.github.com/repos/smallfishworld/DevKit/releases/latest')
    requests++
    if (requests === 1) {
      return Response.json({ ...release, assets: [] }, { headers: { etag: '"published"' } })
    }
    assert.equal(init.headers['If-None-Match'], requests === 2 ? '"published"' : '"uploaded"')
    if (requests === 2) return Response.json(release, { headers: { etag: '"uploaded"' } })
    if (requests === 3) return new Response(null, { status: 304 })
    return new Response(null, { status: 429, headers: { 'retry-after': '120' } })
  }
  const client = new GitHubReleases(fetch)
  assert.equal((await client.latest('0.9.0', 'zip')).status, 'publishing')
  assert.deepEqual(await client.latest('0.9.0', 'zip'), { status: 'available', update })
  assert.deepEqual(await client.latest('0.9.0', 'zip'), { status: 'available', update })
  await assert.rejects(client.latest('0.9.0', 'zip'), /限/)
  await assert.rejects(client.latest('0.9.0', 'zip'), /限/)
  assert.equal(requests, 4)
})

test('asset download follows the GitHub CDN and verifies all bytes', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'devkit-update-unit-'))
  // Electron 的 net.fetch 跟随跳转（manual 跳转会直接取消），注入的 fetch 只见到入口 URL，
  // 直接返回跳转后的 CDN 最终响应；关闭镜像，单测只看官方直连这一条路
  const noMirrors = { mirrors: [] }
  try {
    const fetch = async (url, init) => {
      assert.equal(init.redirect, 'follow')
      assert.equal(url, entry)
      return new Response(data)
    }
    const client = new GitHubReleases(fetch, quick)
    const target = join(temp, 'valid.part')
    const progress = []
    await client.download(update, 'zip', target, (received) => progress.push(received), noMirrors)
    assert.deepEqual(await readFile(target), data)
    assert.deepEqual(progress, [data.length])
    await assert.rejects(client.download({ ...update, hash: '0'.repeat(64) }, 'zip', join(temp, 'hash.part'), () => {}, noMirrors), /校验/)
    await assert.rejects(client.download({ ...update, bytes: data.length + 1 }, 'zip', join(temp, 'short.part'), () => {}, noMirrors), /校验/)
    await assert.rejects(client.download({ ...update, bytes: data.length - 1 }, 'zip', join(temp, 'long.part'), () => {}, noMirrors), /大小/)
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('mirror prefixes are validated and custom lists sanitized', () => {
  assert.equal(mirrorUrl('https://gh-proxy.com', entry), `https://gh-proxy.com/${entry}`)
  assert.equal(mirrorUrl('  https://ghfast.top/ ', entry), `https://ghfast.top/${entry}`)
  for (const bad of ['http://gh-proxy.com/', 'https://user:pw@gh-proxy.com/', 'https://gh-proxy.com/?x=1', 'https://gh-proxy.com/#x', 'gh-proxy.com', '']) {
    assert.equal(mirrorUrl(bad, entry), undefined, bad)
  }
  for (const prefix of DEFAULT_MIRRORS) {
    assert.match(mirrorUrl(prefix, entry), /^https:\/\/[a-z0-9.-]+\/https:\/\/github\.com\//)
  }
  assert.deepEqual(sanitizeMirrors([' https://a.dev/ ', 'https://a.dev/', 42, '', null, 'https://b.dev']), ['https://a.dev/', 'https://b.dev'])
  assert.deepEqual(sanitizeMirrors('https://a.dev'), [])
})

test('sources: a fast official link stays alone, a slow one defers to clearly faster mirrors', () => {
  const MIB = 1048576
  const fast = (mib) => ({ bytes: mib * MIB, seconds: 1 })
  assert.deepEqual(
    rankDownloadSources({ url: entry, probe: fast(48) }, [{ url: 'https://a/', label: 'a', probe: fast(64) }]),
    [{ url: entry }]
  )
  // 直连 0.24 MB/s：够快且明显更快的镜像按速度排在前面，只快一点点的、挂掉的都不用，官方兜底
  assert.deepEqual(
    rankDownloadSources({ url: entry, probe: { bytes: 240_000, seconds: 1 } }, [
      { url: 'https://barely/', label: 'barely', probe: { bytes: 300_000, seconds: 1 } },
      { url: 'https://dead/', label: 'dead', probe: { bytes: 0, seconds: 9, error: 'timeout' } },
      { url: 'https://mid/', label: 'mid', probe: fast(3.5) },
      { url: 'https://best/', label: 'best', probe: fast(8.6) }
    ]),
    [{ url: 'https://best/', label: 'best' }, { url: 'https://mid/', label: 'mid' }, { url: entry }]
  )
  // 直连直接失败、镜像也全挂：只剩官方，让正常下载路径去报那个错
  const down = { bytes: 0, seconds: 2, error: 'ECONNRESET' }
  assert.deepEqual(
    rankDownloadSources({ url: entry, probe: down }, [{ url: 'https://dead/', label: 'dead', probe: down }]),
    [{ url: entry }]
  )
})

test('download uses the fastest mirror only when the official link is slow', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'devkit-update-mirror-'))
  const proxy = `https://gh-proxy.com/${entry}`
  const fastTop = `https://ghfast.top/${entry}`
  try {
    // 官方够快：只联系官方（测速一次、正式下载一次），任何镜像都不碰
    const directCalls = []
    const direct = new GitHubReleases(async (url) => {
      directCalls.push(url)
      return serve(big)
    }, quick)
    await direct.download(bigUpdate, 'zip', join(temp, 'direct.part'), () => {})
    assert.deepEqual(directCalls, [entry, entry])
    assert.deepEqual(await readFile(join(temp, 'direct.part')), big)

    // 官方慢：并行探测镜像，选最快的那个，官方留作兜底
    const calls = []
    let probed = false
    const sources = []
    const client = new GitHubReleases(async (url) => {
      calls.push(url)
      if (url === entry) {
        if (!probed) {
          probed = true
          return stalled(big)
        }
        return serve(big)
      }
      if (url === proxy) return serve(big)
      if (url === fastTop) return stalled(big)
      throw new Error('unexpected fetch ' + url)
    }, quick)
    const target = join(temp, 'mirror.part')
    const progress = []
    await client.download(bigUpdate, 'zip', target, (received) => progress.push(received), {
      onSource: (label) => sources.push(label)
    })
    assert.deepEqual(await readFile(target), big)
    assert.deepEqual(sources, ['gh-proxy.com'])
    assert.equal(calls[0], entry)
    assert.deepEqual([...calls.slice(1, 3)].sort(), [fastTop, proxy].sort())
    assert.deepEqual(calls.slice(3), [proxy])
    assert.ok(progress.length >= 1)
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('an interrupted transfer resumes from the bytes already on disk', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'devkit-update-resume-'))
  try {
    let probed = false
    const ranges = []
    const client = new GitHubReleases(async (url, init) => {
      assert.equal(url, entry)
      const range = init?.headers?.Range
      if (range) {
        // 服务端支持区间：从断点处给到结尾
        ranges.push(range)
        const from = Number(/^bytes=(\d+)-$/.exec(range)[1])
        return serve(big, { status: 206, range: { from, to: big.length - 1 } })
      }
      // 测速给全量（判定够快），首次正式下载在 1 MiB 处被重置
      if (!probed) {
        probed = true
        return serve(big)
      }
      return brokenAfter(big, 1024 * 1024)
    }, quick)
    const target = join(temp, 'resume.part')
    await client.download(bigUpdate, 'zip', target, () => {}, { mirrors: [] })
    assert.deepEqual(await readFile(target), big)
    assert.deepEqual(ranges, ['bytes=1048576-'])
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('a server that ignores Range restarts the download instead of appending', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'devkit-update-restart-'))
  try {
    let probed = false
    let ranged = false
    const client = new GitHubReleases(async (url, init) => {
      // 带 Range 的重试拿到的是 200 整包：截掉半截文件从头重写
      if (init?.headers?.Range) {
        ranged = true
        return serve(big)
      }
      if (!probed) {
        probed = true
        return serve(big)
      }
      return brokenAfter(big, 1024 * 1024)
    }, quick)
    const target = join(temp, 'restart.part')
    await client.download(bigUpdate, 'zip', target, () => {}, { mirrors: [] })
    assert.deepEqual(await readFile(target), big)
    assert.equal(ranged, true)
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('a mirror serving tampered bytes is rejected by the hash and the official copy is used', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'devkit-update-tamper-'))
  try {
    const tampered = Buffer.from(big)
    tampered[tampered.length - 1] ^= 0xff
    let probed = false
    const sources = []
    const client = new GitHubReleases(async (url) => {
      if (url === `https://gh-proxy.com/${entry}`) return serve(tampered)
      if (!probed) {
        probed = true
        return stalled(big)
      }
      return serve(big)
    }, quick)
    const target = join(temp, 'tampered.part')
    await client.download(bigUpdate, 'zip', target, () => {}, {
      mirrors: ['https://gh-proxy.com/'],
      onSource: (label) => sources.push(label)
    })
    assert.deepEqual(await readFile(target), big)
    assert.deepEqual(sources, ['gh-proxy.com', undefined])
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('every source is tried in turn and the last failure is reported', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'devkit-update-failure-'))
  try {
    const client = new GitHubReleases(async () => new Response(null, { status: 404 }), quick)
    await assert.rejects(
      client.download(bigUpdate, 'zip', join(temp, 'missing.part'), () => {}, { mirrors: ['https://gh-proxy.com/'] }),
      /HTTP 404/
    )
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('download progress and speed are formatted for the header and the dialog', () => {
  let now = 0
  const speed = createSpeedEstimator(() => now)
  assert.equal(speed(0), undefined)
  now = 1000
  assert.equal(speed(3000), 3000)
  now = 2000
  assert.ok(Math.abs(speed(9000) - 4200) < 1e-6) // 3000×0.6 + 6000×0.4
  now = 2100
  assert.ok(Math.abs(speed(20000) - 4200) < 1e-6) // 间隔不足 500ms：不更新
  now = 3000
  assert.ok(Math.abs(speed(100) - 4200) < 1e-6) // 换源重来、字节回退：丢弃该样本
  now = 4000
  assert.ok(Math.abs(speed(1100) - 2920) < 1e-6) // 从 100 起重新计数：4200×0.6 + 1000×0.4

  assert.equal(formatSpeed(8.6 * 1048576), '8.6 MB/s')
  assert.equal(formatSpeed(312 * 1024), '312 KB/s')
  assert.equal(formatSpeed(10), '1 KB/s')
  assert.equal(formatMegabytes(172_203_115), '164.2 MB')
  assert.equal(downloadPercent(86_101_558, 172_203_115), 50)
  assert.equal(downloadPercent(172_203_115 + 5, 172_203_115), 100)
  assert.equal(downloadPercent(500, 0), undefined)
  assert.equal(downloadSourceLabel(undefined), '')
  assert.equal(downloadSourceLabel('gh-proxy.com'), '经镜像 gh-proxy.com 加速')
  assert.equal(updateNotice({ phase: 'downloading', release: update, received: 10, speed: 8.6 * 1048576 }), '正在下载更新… 45%（8.6 MB/s）')
  assert.equal(updateNotice({ phase: 'downloading', release: update, received: 10 }), '正在下载更新… 45%')
})

test('update entry exposes notices for a newer version and verified download', () => {
  assert.match(updateNotice({ phase: 'available', release: update }), /新版本 v0\.12\.0/)
  assert.match(updateNotice({ phase: 'ready', release: update }), /已下载/)
  assert.equal(updateNotice({ phase: 'idle' }), '')
})

test('rate-limited API falls back to the quota-free release page channel', async () => {
  const api = 'https://api.github.com/repos/smallfishworld/DevKit/releases/latest'
  const page = 'https://github.com/smallfishworld/DevKit/releases/latest'
  const downloadUrl = 'https://github.com/smallfishworld/DevKit/releases/download/v0.12.0/DevKit-win-x64.zip'
  // release/latest 跳转后的 tag 页（仿 GitHub 结构）：head 里 canonical/og:url 带 tag，
  // 正文是 data-test-selector="body-content" 的 markdown-body div（含嵌套 div 与实体），其后是 Assets 区
  // body: 'normal'=完整页面 / 'empty'=正文容器为空 / 'none'=没有正文容器（结构变化）
  const tagPage = (tag, body = 'normal') => {
    const content = body === 'normal'
      ? '<h1>DevKit v0.12.0</h1> <h2>工作台</h2> <ul> <li><strong>新增分屏</strong>：标题 &quot;A | B&quot;、单个关闭按钮</li> <li>分隔条默认严格均分</li> </ul> <div class="Box mt-3"> <p>内嵌说明块</p> </div> <h2>下载</h2> <table><tr><td>DevKit-portable.exe</td></tr></table>'
      : ''
    const section = body === 'none'
      ? `<h2 class="sr-only">Assets</h2>`
      : `<div data-pjax="true" data-test-selector="body-content" data-view-component="true" class="markdown-body">${content}</div><h2 class="sr-only">Assets</h2>`
    return `<html><head><link rel="canonical" href="https://github.com/smallfishworld/DevKit/releases/tag/${tag}">` +
      `<meta property="og:url" content="https://github.com/smallfishworld/DevKit/releases/tag/${tag}"></head>` +
      `<body><include-fragment>${section}</include-fragment></body></html>`
  }
  // sidecar: undefined=正常边车 / null=404（旧版本发布）/ 其他字符串=损坏内容
  const makeStub = ({ sidecar, tag, body } = {}) => async (url, init) => {
    if (url === api) return new Response(null, { status: 403, headers: { 'x-ratelimit-reset': '1795485219' } })
    if (url === page) {
      assert.equal(init.redirect, 'follow')
      return new Response(tagPage(tag ?? 'v0.12.0', body), { headers: { 'content-type': 'text/html' } })
    }
    assert.equal(init.redirect, 'follow')
    if (url === downloadUrl) return new Response(data, { headers: { 'content-length': String(data.length) } })
    if (url === downloadUrl + '.sha256') {
      if (sidecar === null) return new Response(null, { status: 404 })
      return new Response(sidecar ?? `${hash}  DevKit-win-x64.zip\n`)
    }
    throw new Error('unexpected fetch ' + url)
  }

  const client = new GitHubReleases(makeStub())
  // API 限流 → 类型化错误（触发调用方回退）
  await assert.rejects(client.latest('0.9.0', 'zip'), RateLimitError)
  const fallback = await client.fallbackLatest('0.9.0', 'zip')
  assert.equal(fallback.status, 'available')
  assert.equal(fallback.update.version, '0.12.0')
  assert.equal(fallback.update.tag, 'v0.12.0')
  assert.equal(fallback.update.hash, hash)
  assert.equal(fallback.update.bytes, data.length)
  // 发布说明从 tag 页正文提取：真实内容 + 实体解码 + 列表圆点，截到「下载」小节，不含占位文案
  assert.equal(fallback.update.notes, 'DevKit v0.12.0\n工作台\n\n• 新增分屏：标题 "A | B"、单个关闭按钮\n• 分隔条默认严格均分\n内嵌说明块')
  // 无分发格式时与 API 只读路径同形（bytes/hash 置空），说明同样取真实内容
  const loose = await client.fallbackLatest('0.9.0')
  assert.deepEqual(loose, {
    status: 'available',
    update: { version: '0.12.0', tag: 'v0.12.0', notes: fallback.update.notes, bytes: 0, hash: '' }
  })
  // 回退解析出的元数据可直接驱动校验下载（无感更新闭环）
  const temp = await mkdtemp(join(tmpdir(), 'devkit-update-fallback-'))
  try {
    const target = join(temp, 'fallback.part')
    await client.download(fallback.update, 'zip', target, () => {}, { mirrors: [] })
    assert.deepEqual(await readFile(target), data)
  } finally {
    await rm(temp, { force: true, recursive: true })
  }

  // 非更新 tag / 未 newer / 无边车 / 边车损坏 → 回退放弃
  const wrongTag = new GitHubReleases(makeStub({ tag: 'v0.12.0-beta.1' }))
  assert.equal(await wrongTag.fallbackLatest('0.9.0', 'zip'), undefined)
  assert.equal((await client.fallbackLatest('0.12.0', 'zip')).status, 'current')
  const noSidecar = new GitHubReleases(makeStub({ sidecar: null }))
  assert.equal(await noSidecar.fallbackLatest('0.9.0', 'zip'), undefined)
  const badSidecar = new GitHubReleases(makeStub({ sidecar: 'not-a-hash' }))
  assert.equal(await badSidecar.fallbackLatest('0.9.0', 'zip'), undefined)
  // 页面结构变化（无正文容器）或正文为空：更新信息照常可用，说明落到占位文案
  for (const body of ['none', 'empty']) {
    const broken = new GitHubReleases(makeStub({ body }))
    const result = await broken.fallbackLatest('0.9.0')
    assert.equal(result.status, 'available')
    assert.equal(result.update.notes, 'GitHub API 暂时限流，本次更新信息通过发布页回退通道获取。')
  }
})

test('read-only release check works without Windows package format', () => {
  const result = parseRelease({ ...release, assets: [] }, '0.9.0')
  assert.equal(result.status, 'available')
  assert.equal(result.update.version, '0.12.0')
  assert.equal(result.update.notes, '## 更新内容\n\n- Windows 修复')
  assert.equal(result.update.bytes, 0)
  assert.equal(parseRelease({ ...release, assets: [] }, '0.12.0').status, 'current')
})

test('release packages are named without the version', () => {
  // 解压工具按包名建目录：名字里带版本，每升级一次目录名就变一次
  assert.deepEqual(['portable', 'zip'].map((format) => packageName(format)), ['DevKit-portable.exe', 'DevKit-win-x64.zip'])
  const versioned = { ...release, assets: release.assets.map((asset) => ({ ...asset, name: asset.name.replace('DevKit-', 'DevKit-0.12.0-') })) }
  assert.equal(parseRelease(versioned, '0.9.0', 'zip').status, 'publishing')
})

test('the preflight says what keeps the installation from being updated in place', () => {
  assert.equal(preflightRefusal('locked', '项目资料/, a.txt'),
    '程序目录里有文件正被其他程序占用（项目资料/, a.txt），无法原路径更新。请关闭相关窗口或程序后重试，或将更新包另存并解压到新目录。')
  assert.equal(preflightRefusal('collision', 'NEW.txt'),
    '程序目录里有与新版本同名的文件（NEW.txt），无法原路径更新。请先将它们移出程序目录后重试，或将更新包另存并解压到新目录。')
  assert.equal(preflightRefusal('directory', '符号链接: linked'),
    '程序目录与 DevKit 安装清单不符（符号链接: linked），无法原路径更新。请将更新包另存并解压到新目录。')
  assert.equal(preflightRefusal('directory', ''),
    '程序目录无法核对（可能没有读取权限），无法原路径更新。请将更新包另存并解压到新目录。')
  assert.equal(preflightRefusal('failed', ''), undefined)
  assert.match(preflightRefusal('locked', 'a.txt', 'en'), /^Files in the application folder/)
  // 每种拒绝都以「程序目录」开头（主进程据此认定这是给用户看的原因），并且都给出另存这条路
  for (const reason of ['directory', 'collision', 'locked']) {
    assert.match(preflightRefusal(reason, ''), /^程序目录.*另存/)
  }
})

test('a restart that could not finish says why once the helper knows', () => {
  assert.equal(applyFailureMessage(''), '上次更新未完成。可重试或另存更新包。')
  assert.equal(applyFailureMessage('locked'),
    '上次更新未完成：程序目录被其他程序占用。关闭相关窗口或程序后可重试，或另存更新包。')
  assert.match(applyFailureMessage('locked', 'en'), /^The last update did not finish/)
})

test('user files an update could not put back are read from the helper marker', () => {
  const backup = String.raw`D:\software\.devkit-backup-0123456789abcdef0123456789abcdef`
  assert.deepEqual(parseLeftover(`${backup}\r\n项目资料/\r\nnotes.txt\r\n`), {
    directory: backup, entries: ['项目资料/', 'notes.txt']
  })
  // 没有目录行，或没有任何没放回的条目：没什么可提示的
  for (const marker of ['', '\r\n\r\n', backup, backup + '\r\n \r\n']) assert.equal(parseLeftover(marker), undefined)

  const notice = leftoverNotice({ directory: backup, entries: ['项目资料/'] })
  const englishNotice = leftoverNotice({ directory: backup, entries: ['data/'] }, 'en')
  assert.equal(englishNotice.buttons[0], 'Open backup folder')
  assert.deepEqual(notice.buttons, ['打开备份目录', '确定'])
  assert.ok(notice.detail.includes(backup + '\n\n项目资料/'))
  const many = leftoverNotice({ directory: backup, entries: Array.from({ length: 12 }, (_, index) => 'file' + index) })
  assert.equal(many.detail.split('\n').filter((line) => line.startsWith('file')).length, 8)
  assert.ok(many.detail.endsWith('…另有 4 项'))
})
