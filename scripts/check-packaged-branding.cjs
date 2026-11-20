'use strict'

// Usage: node scripts/check-packaged-branding.cjs [unpacked-directory]
// Read the actual packaged PE/ASAR; renderer appearance cannot prove either asset was packaged.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { Data, NtExecutable, NtExecutableResource, Resource } = require('resedit')
const asar = require('@electron/asar')

function frameBytes(item) {
  return Buffer.from(item.isRaw() ? item.bin : item.generate())
}
function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

try {
  if (process.argv.length > 3) throw new Error('Usage: node scripts/check-packaged-branding.cjs [unpacked-directory]')
  const root = path.resolve(__dirname, '..')
  const unpacked = path.resolve(process.argv[2] || path.join(root, 'release/win-unpacked'))
  const iconPath = path.join(root, 'resources/branding/devkit.ico')
  const pngPath = path.join(root, 'resources/branding/app-256.png')
  const exePath = path.join(unpacked, 'DevKit.exe')
  const archivePath = path.join(unpacked, 'resources/app.asar')
  const source = Data.IconFile.from(fs.readFileSync(iconPath))
  const expected = source.icons.map((item) => frameBytes(item.data))
  assert.ok(expected.length > 0, 'Source ICO contains no frames')
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  assert.ok(expected.some((frame) => frame.subarray(0, 8).equals(pngSignature)), 'Source ICO contains no PNG frame')
  const expectedHashes = expected.map(digest).sort()

  // ignoreCert permits read-only inspection of signed releases; this script never writes the PE.
  const executable = NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true })
  const resources = NtExecutableResource.from(executable)
  // electron-builder 26 writes the application icon to RT_GROUP_ICON #1.
  const groups = Resource.IconGroupEntry.fromEntries(resources.entries).filter((group) => group.id === 1)
  assert.ok(groups.length > 0, 'Packaged DevKit.exe is missing RT_GROUP_ICON #1')
  for (const group of groups) {
    const frames = group.getIconItemsFromEntries(resources.entries)
    assert.equal(frames.length, group.icons.length, 'RT_GROUP_ICON references a missing RT_ICON')
    assert.deepEqual(frames.map((item) => digest(frameBytes(item))).sort(), expectedHashes,
      'Packaged DevKit.exe icon frames differ from resources/branding/devkit.ico')
  }

  const packagedPng = asar.extractFile(archivePath, 'resources/branding/app-256.png')
  assert.ok(Buffer.from(packagedPng).equals(fs.readFileSync(pngPath)),
    'app.asar runtime icon differs from resources/branding/app-256.png')
  const sizes = groups[0].icons.map((item) => (item.width || 256) + 'x' + (item.height || 256)).join(', ')
  console.log('PASS packaged branding: DevKit.exe embeds ' + expected.length + ' matching icon frames (' + sizes + ')')
  console.log('PASS packaged branding: app.asar contains the matching runtime PNG')
} catch (error) {
  console.error('Packaged branding verification failed:', error.message)
  process.exitCode = 1
}
