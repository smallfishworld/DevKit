const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { mkdtemp, readFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { test } = require('node:test')
const {
  GitHubReleases, isNewerVersion, packageName, parseRelease, readPendingUpdate
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
  const remote = 'https://release-assets.githubusercontent.com/fixture'
  try {
    const fetch = async (url, init) => {
      assert.equal(init.redirect, 'manual')
      if (url === remote) return new Response(data)
      assert.equal(url, 'https://github.com/smallfishworld/DevKit/releases/download/v0.12.0/DevKit-0.12.0-win-x64.zip')
      return new Response(null, { status: 302, headers: { location: remote } })
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
    const unsafe = new GitHubReleases(async () =>
      new Response(null, { status: 302, headers: { location: 'https://example.test/not-github' } }))
    await assert.rejects(unsafe.download(update, 'zip', join(temp, 'unsafe.part'), () => {}), /无效/)
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('update entry exposes notices for a newer version and verified download', () => {
  assert.match(updateNotice({ phase: 'available', release: update }), /新版本 v0\.12\.0/)
  assert.match(updateNotice({ phase: 'ready', release: update }), /已下载/)
  assert.equal(updateNotice({ phase: 'idle' }), '')
})

test('read-only release check works without Windows package format', () => {
  const result = parseRelease({ ...release, assets: [] }, '0.9.0')
  assert.equal(result.status, 'available')
  assert.equal(result.update.version, '0.12.0')
  assert.equal(result.update.notes, '## 更新内容\n\n- Windows 修复')
  assert.equal(result.update.bytes, 0)
  assert.equal(parseRelease({ ...release, assets: [] }, '0.12.0').status, 'current')
})
