const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { mkdtemp, readFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { test } = require('node:test')
const {
  GitHubReleases, RateLimitError, isNewerVersion, packageName, parseRelease, readPendingUpdate
} = require('../src/main/services/updates/github')
const { updateNotice } = require('../src/shared/app-updates')

const data = Buffer.from('fixture Windows update')
const hash = createHash('sha256').update(data).digest('hex')
const fixtures = ['portable', 'zip'].map((format) => ({
  name: packageName('0.12.0', format), size: data.length, digest: 'sha256:' + hash, state: 'uploaded'
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
  // 直接返回跳转后的 CDN 最终响应
  const entry = 'https://github.com/smallfishworld/DevKit/releases/download/v0.12.0/DevKit-0.12.0-win-x64.zip'
  try {
    const fetch = async (url, init) => {
      assert.equal(init.redirect, 'follow')
      assert.equal(url, entry)
      return new Response(data)
    }
    const client = new GitHubReleases(fetch)
    const target = join(temp, 'valid.part')
    const progress = []
    await client.download(update, 'zip', target, (received) => progress.push(received))
    assert.deepEqual(await readFile(target), data)
    assert.deepEqual(progress, [data.length])
    await assert.rejects(client.download({ ...update, hash: '0'.repeat(64) }, 'zip', join(temp, 'hash.part'), () => {}), /校验/)
    await assert.rejects(client.download({ ...update, bytes: data.length + 1 }, 'zip', join(temp, 'short.part'), () => {}), /校验/)
    await assert.rejects(client.download({ ...update, bytes: data.length - 1 }, 'zip', join(temp, 'long.part'), () => {}), /大小/)
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('update entry exposes notices for a newer version and verified download', () => {
  assert.match(updateNotice({ phase: 'available', release: update }), /新版本 v0\.12\.0/)
  assert.match(updateNotice({ phase: 'ready', release: update }), /已下载/)
  assert.equal(updateNotice({ phase: 'idle' }), '')
})

test('rate-limited API falls back to the quota-free release page channel', async () => {
  const api = 'https://api.github.com/repos/smallfishworld/DevKit/releases/latest'
  const page = 'https://github.com/smallfishworld/DevKit/releases/latest'
  const downloadUrl = 'https://github.com/smallfishworld/DevKit/releases/download/v0.12.0/DevKit-0.12.0-win-x64.zip'
  // release/latest 跳转后的 tag 页（仿 GitHub 结构）：head 里 canonical/og:url 带 tag，
  // 正文是 data-test-selector="body-content" 的 markdown-body div（含嵌套 div 与实体），其后是 Assets 区
  // body: 'normal'=完整页面 / 'empty'=正文容器为空 / 'none'=没有正文容器（结构变化）
  const tagPage = (tag, body = 'normal') => {
    const content = body === 'normal'
      ? '<h1>DevKit v0.12.0</h1> <h2>工作台</h2> <ul> <li><strong>新增分屏</strong>：标题 &quot;A | B&quot;、单个关闭按钮</li> <li>分隔条默认严格均分</li> </ul> <div class="Box mt-3"> <p>内嵌说明块</p> </div> <h2>下载</h2> <table><tr><td>DevKit-0.12.0-portable.exe</td></tr></table>'
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
      return new Response(sidecar ?? `${hash}  DevKit-0.12.0-win-x64.zip\n`)
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
    await client.download(fallback.update, 'zip', target, () => {})
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
