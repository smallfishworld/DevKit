const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const {
  compareVersions, normalizeSourceUrl, parseSourceCatalog, sourceItems,
  packageSources, parseChecksums, fetchSourceCatalog, downloadSourceBundle,
  MAX_SOURCE_CATALOG_BYTES
} = require('../src/main/services/plugins/source')

const sha = (text) => createHash('sha256').update(text).digest('hex')
const packagePath = 'dist/sample-reply/1.0.0/sample.reply-1.0.0.devkit-plugin.json'
const entry = {
  slug: 'sample-reply',
  id: 'sample.reply',
  name: '应答插件',
  version: '1.0.0',
  apiVersion: 1,
  description: '示例',
  path: 'plugins/sample-reply',
  readme: 'plugins/sample-reply/README.md',
  packagePath,
  installDirectory: 'dist/sample-reply/1.0.0/package'
}
const catalog = {
  schemaVersion: 1,
  apiVersion: 1,
  plugins: [entry]
}

async function main() {
  assert.equal(normalizeSourceUrl('acme/plugins'),
    'https://raw.githubusercontent.com/acme/plugins/HEAD/catalog.json')
  assert.equal(normalizeSourceUrl('acme/plugins.git'),
    'https://raw.githubusercontent.com/acme/plugins/HEAD/catalog.json')
  assert.equal(normalizeSourceUrl('https://github.com/acme/plugins'),
    'https://raw.githubusercontent.com/acme/plugins/HEAD/catalog.json')
  assert.equal(normalizeSourceUrl('https://github.com/acme/plugins/tree/main'),
    'https://raw.githubusercontent.com/acme/plugins/main/catalog.json')
  assert.equal(normalizeSourceUrl('https://github.com/acme/plugins/blob/main/list/catalog.json'),
    'https://raw.githubusercontent.com/acme/plugins/main/list/catalog.json')
  assert.equal(normalizeSourceUrl('https://raw.githubusercontent.com/acme/plugins/main/catalog.json'),
    'https://raw.githubusercontent.com/acme/plugins/main/catalog.json')
  assert.equal(normalizeSourceUrl('https://acme.github.io/plugins'),
    'https://acme.github.io/plugins/catalog.json')
  assert.equal(normalizeSourceUrl('https://example.invalid/plugins/'),
    'https://example.invalid/plugins/catalog.json')
  assert.equal(normalizeSourceUrl('http://127.0.0.1:8123/catalog.json'), 'http://127.0.0.1:8123/catalog.json')
  assert.throws(() => normalizeSourceUrl('http://example.invalid/catalog.json'), /HTTPS/)
  assert.throws(() => normalizeSourceUrl('https://user:pass@example.invalid/catalog.json'), /凭据/)
  assert.throws(() => normalizeSourceUrl('https://example.invalid/catalog.json#x'), /凭据或片段/)
  assert.throws(() => normalizeSourceUrl('https://github.com/acme'), /缺少仓库名/)
  assert.throws(() => normalizeSourceUrl('not a url'), /无效/)

  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  assert.ok(compareVersions('1.0.1', '1.0.0') > 0)
  assert.ok(compareVersions('1.0.0-beta.2', '1.0.0-beta.10') < 0)
  assert.ok(compareVersions('1.0.0-beta', '1.0.0') < 0)
  assert.ok(compareVersions('1.0.0-alpha', '1.0.0-beta') < 0)
  assert.ok(compareVersions('1.0.0-2', '1.0.0-beta') < 0)
  assert.throws(() => compareVersions('1.0', '1.0.0'), /版本号无效/)

  const parsed = parseSourceCatalog(catalog)
  assert.equal(parsed.plugins[0].id, 'sample.reply')
  assert.equal(parsed.plugins[0].packagePath, packagePath)
  assert.equal(parseSourceCatalog({ ...catalog, plugins: [{ ...entry, description: '' }] }).plugins[0].description, undefined)
  assert.equal(parseSourceCatalog({
    ...catalog, plugins: [{ ...entry, sha256: 'A'.repeat(64) }]
  }).plugins[0].sha256, 'a'.repeat(64))
  assert.equal(parseSourceCatalog({
    ...catalog, plugins: [{ ...entry, packageUrl: 'https://example.invalid/p.json' }]
  }).plugins[0].packageUrl, 'https://example.invalid/p.json')
  assert.throws(() => parseSourceCatalog({ ...catalog, schemaVersion: 2 }), /schemaVersion 1/)
  assert.throws(() => parseSourceCatalog({ ...catalog, apiVersion: 2 }), /API 版本不支持/)
  assert.throws(() => parseSourceCatalog({ ...catalog, plugins: [entry, entry] }), /ID 重复/)
  assert.throws(() => parseSourceCatalog({
    ...catalog, plugins: [entry, { ...entry, id: 'sample.other' }]
  }), /目录名重复/)
  assert.throws(() => parseSourceCatalog({ ...catalog, plugins: [{ ...entry, slug: 'Bad Slug' }] }), /目录名无效/)
  assert.throws(() => parseSourceCatalog({ ...catalog, plugins: [{ ...entry, id: 'Bad ID' }] }), /ID 无效/)
  assert.throws(() => parseSourceCatalog({ ...catalog, plugins: [{ ...entry, apiVersion: 2 }] }), /apiVersion/)
  assert.throws(() => parseSourceCatalog({ ...catalog, plugins: [{ ...entry, version: '1.0' }] }), /语义版本号/)
  assert.throws(() => parseSourceCatalog({ ...catalog, plugins: [{ ...entry, packagePath: '../x.json' }] }), /路径段/)
  assert.throws(() => parseSourceCatalog({ ...catalog, plugins: [{ ...entry, packagePath: 'dist\\x.json' }] }), /相对路径/)
  assert.throws(() => parseSourceCatalog({ ...catalog, plugins: [{ ...entry, packagePath: 'dist/x.txt' }] }), /\.json/)
  assert.throws(() => parseSourceCatalog({ ...catalog, plugins: [{ ...entry, packageUrl: 'http://example.invalid/p.json' }] }), /HTTPS/)
  assert.throws(() => parseSourceCatalog({ ...catalog, plugins: [{ ...entry, sha256: 'xyz' }] }), /sha256/)
  assert.throws(() => parseSourceCatalog({ ...catalog, plugins: new Array(101).fill(entry) }), /100/)

  const items = sourceItems(parsed, new Map([['sample.reply', '1.0.0']]))
  assert.deepEqual(items.map(item => [item.id, item.version, item.installedVersion, item.updateAvailable]),
    [['sample.reply', '1.0.0', '1.0.0', false]])
  const older = parseSourceCatalog({
    ...catalog, plugins: [{ ...entry, version: '0.9.0' }]
  })
  assert.equal(sourceItems(older, new Map([['sample.reply', '1.0.0']]))[0].updateAvailable, false)
  const missing = sourceItems(parsed, new Map())
  assert.equal(missing[0].installedVersion, undefined)
  assert.equal(missing[0].updateAvailable, true)

  const rawCatalog = 'https://raw.githubusercontent.com/acme/plugins/HEAD/catalog.json'
  const sources = packageSources(rawCatalog, parsed.plugins[0])
  assert.equal(sources.length, 2)
  const tag = 'sample-reply%2Fv1.0.0'
  assert.equal(sources[0].url,
    `https://github.com/acme/plugins/releases/download/${tag}/sample.reply-1.0.0.devkit-plugin.json`)
  assert.equal(sources[0].checksumsUrl, `https://github.com/acme/plugins/releases/download/${tag}/SHA256SUMS`)
  assert.equal(sources[1].url,
    'https://raw.githubusercontent.com/acme/plugins/HEAD/dist/sample-reply/1.0.0/sample.reply-1.0.0.devkit-plugin.json')
  assert.equal(sources[1].checksumsUrl,
    'https://raw.githubusercontent.com/acme/plugins/HEAD/dist/sample-reply/1.0.0/SHA256SUMS')
  const hosted = packageSources('https://example.invalid/plugins/catalog.json', parsed.plugins[0])
  assert.equal(hosted.length, 1)
  assert.equal(hosted[0].url, 'https://example.invalid/plugins/dist/sample-reply/1.0.0/sample.reply-1.0.0.devkit-plugin.json')
  const explicit = packageSources(rawCatalog, {
    ...parsed.plugins[0], packageUrl: 'https://example.invalid/bundles/p.json', sha256: 'a'.repeat(64)
  })
  assert.deepEqual(explicit, [{
    url: 'https://example.invalid/bundles/p.json',
    checksumsUrl: 'https://example.invalid/bundles/SHA256SUMS',
    sha256: 'a'.repeat(64)
  }])

  assert.equal(parseChecksums(`${'b'.repeat(64)}  other.json\n${'a'.repeat(64)}  sample.reply-1.0.0.devkit-plugin.json\n`,
    'sample.reply-1.0.0.devkit-plugin.json'), 'a'.repeat(64))
  assert.equal(parseChecksums(`${'c'.repeat(64)} *sample.reply-1.0.0.devkit-plugin.json`,
    'sample.reply-1.0.0.devkit-plugin.json'), 'c'.repeat(64))
  assert.throws(() => parseChecksums(`${'a'.repeat(64)}  other.json`, 'sample.json'), /缺少/)
  assert.throws(() => parseChecksums('not a checksum', 'sample.json'), /缺少/)

  const calls = []
  const fetched = await fetchSourceCatalog('https://example.invalid/catalog.json', async (url, init) => {
    calls.push([url, init])
    return new Response(JSON.stringify(catalog), { status: 200 })
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'https://example.invalid/catalog.json')
  assert.equal(calls[0][1].redirect, 'follow')
  assert.equal(fetched.plugins[0].id, 'sample.reply')

  await assert.rejects(() => fetchSourceCatalog('https://example.invalid/x', async () =>
    new Response('nope', { status: 404 })), /HTTP 404/)
  await assert.rejects(() => fetchSourceCatalog('https://example.invalid/x', async () =>
    new Response('not json', { status: 200 })), /不是有效 JSON/)
  await assert.rejects(() => fetchSourceCatalog('https://example.invalid/x', async () =>
    new Response('x'.repeat(MAX_SOURCE_CATALOG_BYTES + 1), { status: 200 })), /超过大小上限/)
  await assert.rejects(() => fetchSourceCatalog('https://example.invalid/x', async () => {
    throw new Error('getaddrinfo ENOTFOUND')
  }), /无法访问插件源/)

  const bundle = JSON.stringify({ manifest: { id: 'sample.reply' }, files: {} })
  const downloaded = await downloadSourceBundle([{
    url: 'https://example.invalid/p.json', checksumsUrl: 'https://example.invalid/SHA256SUMS', sha256: sha(bundle)
  }], async () => new Response(bundle, { status: 200 }))
  assert.equal(downloaded.toString('utf8'), bundle)
  await assert.rejects(() => downloadSourceBundle([{
    url: 'https://example.invalid/p.json', checksumsUrl: 'https://example.invalid/SHA256SUMS', sha256: 'd'.repeat(64)
  }], async () => new Response(bundle, { status: 200 })), /SHA-256 不匹配/)

  const sums = `${sha(bundle)}  responder.json\n`
  const order = []
  const fromSums = await downloadSourceBundle([{
    url: 'https://example.invalid/dist/responder.json',
    checksumsUrl: 'https://example.invalid/dist/SHA256SUMS'
  }], async (url) => {
    order.push(url)
    if (url.endsWith('/SHA256SUMS')) return new Response(sums, { status: 200 })
    return new Response(bundle, { status: 200 })
  })
  assert.equal(fromSums.toString('utf8'), bundle)
  assert.deepEqual(order, ['https://example.invalid/dist/SHA256SUMS', 'https://example.invalid/dist/responder.json'])

  const fallbackCalls = []
  const fallback = await downloadSourceBundle([
    { url: 'https://example.invalid/release.json', checksumsUrl: 'https://example.invalid/rel/SHA256SUMS', sha256: sha(bundle) },
    { url: 'https://example.invalid/dist/rel.json', checksumsUrl: 'https://example.invalid/dist/SHA256SUMS', sha256: sha(bundle) }
  ], async (url) => {
    fallbackCalls.push(url)
    if (url.includes('/release.json')) return new Response('missing', { status: 404 })
    return new Response(bundle, { status: 200 })
  })
  assert.equal(fallback.toString('utf8'), bundle)
  assert.deepEqual(fallbackCalls, ['https://example.invalid/release.json', 'https://example.invalid/dist/rel.json'])

  await assert.rejects(() => downloadSourceBundle([{
    url: 'https://example.invalid/p.json', checksumsUrl: 'https://example.invalid/SHA256SUMS', sha256: sha(bundle)
  }], async () => new Response('', { status: 404 })), /尚未发布/)
  const noFallback = []
  await assert.rejects(() => downloadSourceBundle([
    { url: 'https://example.invalid/release.json', checksumsUrl: 'https://example.invalid/SHA256SUMS', sha256: sha(bundle) },
    { url: 'https://example.invalid/dist/rel.json', checksumsUrl: 'https://example.invalid/dist/SHA256SUMS', sha256: sha(bundle) }
  ], async (url) => {
    noFallback.push(url)
    return new Response('', { status: 500 })
  }), /HTTP 500/)
  assert.deepEqual(noFallback, ['https://example.invalid/release.json'])

  console.log('  PASS Plugin source: catalog schema, GitHub Release resolution, version order, installed comparison, size limit and SHA-256')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
