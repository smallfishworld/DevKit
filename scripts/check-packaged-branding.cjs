'use strict'

// Usage: node scripts/check-packaged-branding.cjs [unpacked-directory]
//        node scripts/check-packaged-branding.cjs --release [release-directory]
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { pipeline } = require('node:stream/promises')
const { Data, NtExecutable, NtExecutableResource, Resource } = require('resedit')
const asar = require('@electron/asar')

function frameBytes(item) {
  return Buffer.from(item.isRaw() ? item.bin : item.generate())
}
function frameSignature(metadata, bytes) {
  return JSON.stringify([
    metadata.width || 256, metadata.height || 256, metadata.planes,
    metadata.bitCount, bytes.length, createHash('sha256').update(bytes).digest('hex')
  ])
}

function readBranding(root) {
  const ico = fs.readFileSync(path.join(root, 'resources/branding/devkit.ico'))
  const png = fs.readFileSync(path.join(root, 'resources/branding/app-256.png'))
  const icons = Data.IconFile.from(ico).icons
  assert.ok(icons.length > 0, 'Source ICO contains no frames')
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  assert.ok(icons.some((icon) => frameBytes(icon.data).subarray(0, 8).equals(pngSignature)),
    'Source ICO contains no PNG frame')
  return { ico, png, frames: icons.map((icon) => frameSignature(icon, frameBytes(icon.data))).sort() }
}

function checkPeIcon(exePath, branding, groupId) {
  // ignoreCert permits read-only inspection of signed releases; this never writes the PE.
  const executable = NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true })
  const resources = NtExecutableResource.from(executable)
  const allGroups = Resource.IconGroupEntry.fromEntries(resources.entries)
  const groups = allGroups.filter((group) => group.id === groupId)
  assert.ok(groups.length > 0, exePath + ' is missing RT_GROUP_ICON #' + groupId)
  // Shell icon index 0 must be the application group, not a different stale/default icon.
  assert.equal(allGroups[0].id, groupId, exePath + ' has an unexpected first icon group')
  for (const group of groups) {
    const frames = group.icons.map((icon) => {
      const entries = resources.entries.filter((entry) =>
        entry.type === 3 && entry.lang === group.lang && entry.id === icon.iconID)
      assert.equal(entries.length, 1, exePath + ': RT_GROUP_ICON references a missing or duplicate RT_ICON')
      const bytes = Buffer.from(entries[0].bin)
      assert.ok(icon.dataSize > 0 && icon.dataSize <= bytes.length, exePath + ': invalid RT_ICON dataSize')
      // NSIS reserves room for uninstaller icons. Only zero padding outside the declared image is valid.
      if (groupId === 103) {
        assert.ok(bytes.subarray(icon.dataSize).every((byte) => byte === 0), exePath + ': non-zero RT_ICON padding')
      } else {
        assert.equal(bytes.length, icon.dataSize, exePath + ': unexpected RT_ICON padding')
      }
      return frameSignature(icon, bytes.subarray(0, icon.dataSize))
    }).sort()
    assert.deepEqual(frames, branding.frames, exePath + ': icon frames differ from resources/branding/devkit.ico')
  }
  return path.basename(exePath) + ' embeds ' + branding.frames.length + ' matching icon frames (group #' + groupId + ')'
}

function checkUnpacked(directory, branding) {
  const result = [checkPeIcon(path.join(directory, 'DevKit.exe'), branding, 1)]
  const archivePath = path.join(directory, 'resources/app.asar')
  for (const [filename, expected] of [['app-256.png', branding.png], ['devkit.ico', branding.ico]]) {
    // asar 3.x traverses archive paths using the host separator, including on Windows.
    const packaged = asar.extractFile(archivePath, path.join('resources', 'branding', filename))
    assert.ok(Buffer.from(packaged).equals(expected), archivePath + ': runtime ' + filename + ' differs from source')
  }
  result.push('app.asar contains the matching runtime PNG and ICO')
  return result
}

async function checkRelease(directory, branding, version) {
  const result = checkUnpacked(path.join(directory, 'win-unpacked'), branding).map((line) => 'unpacked: ' + line)
  const portable = path.join(directory, 'DevKit-' + version + '-portable.exe')
  // electron-builder writes group #1 in Electron; NSIS uses IDI_ICON2 (#103) in the launcher.
  result.push('portable: ' + checkPeIcon(portable, branding, 103))
  const zipPath = path.join(directory, 'DevKit-' + version + '-win-x64.zip')
  const archive = await require('unzipper').Open.file(zipPath)
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-branding-'))
  try {
    for (const filename of ['DevKit.exe', 'resources/app.asar']) {
      const entries = archive.files.filter((entry) => entry.path === filename && entry.type === 'File')
      assert.equal(entries.length, 1, zipPath + ': expected exactly one ' + filename)
      const target = path.join(temporary, ...filename.split('/'))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      await pipeline(entries[0].stream(), fs.createWriteStream(target, { flags: 'wx' }))
    }
    result.push(...checkUnpacked(temporary, branding).map((line) => 'ZIP: ' + line))
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
  return result
}

async function main(args) {
  const root = path.resolve(__dirname, '..')
  const usage = 'Usage: node scripts/check-packaged-branding.cjs [unpacked-directory] | --release [release-directory]'
  const release = args[0] === '--release'
  if (args.length > (release ? 2 : 1) || (!release && args[0]?.startsWith('-'))) throw new Error(usage)
  const branding = readBranding(root)
  const result = release
    ? await checkRelease(path.resolve(args[1] || path.join(root, 'release')), branding, require('../package.json').version)
    : checkUnpacked(path.resolve(args[0] || path.join(root, 'release/win-unpacked')), branding)
  for (const line of result) console.log('PASS packaged branding: ' + line)
}

module.exports = { readBranding, checkPeIcon, checkUnpacked, checkRelease }

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error('Packaged branding verification failed:', error.message)
    process.exitCode = 1
  })
}
