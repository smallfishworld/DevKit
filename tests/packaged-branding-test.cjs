'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const asar = require('@electron/asar')
const { Data, NtExecutable, NtExecutableResource, Resource } = require('resedit')
const { readBranding, checkPeIcon, checkUnpacked, checkRelease } = require('../scripts/check-packaged-branding.cjs')

const root = path.resolve(__dirname, '..')
const branding = readBranding(root)
const arrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-branding-test-'))
  // Defender 或索引器会短暂握住刚写完的文件，删目录要带重试（实测握住可超过 2 秒）
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 30, retryDelay: 300 }))
  return directory
}
function icons() {
  return Data.IconFile.from(branding.ico).icons.map((icon) => icon.data)
}
function pe(groupId = 1, edit = () => {}) {
  const executable = NtExecutable.createEmpty()
  const resources = NtExecutableResource.from(executable)
  Resource.IconGroupEntry.replaceIconsForResource(resources.entries, groupId, 1033, icons())
  edit(resources.entries)
  resources.outputResource(executable)
  return Buffer.from(executable.generate())
}
function writePe(t, bytes) {
  const filename = path.join(temporary(t), 'DevKit.exe')
  fs.writeFileSync(filename, bytes)
  return filename
}
async function bundle(directory, options = {}) {
  const source = directory + '-source'
  const assets = path.join(source, 'resources/branding')
  fs.mkdirSync(assets, { recursive: true })
  const { ico = branding.ico, png = branding.png, executable = pe() } = options
  if (ico !== null) fs.writeFileSync(path.join(assets, 'devkit.ico'), ico)
  if (png !== null) fs.writeFileSync(path.join(assets, 'app-256.png'), png)
  fs.mkdirSync(path.join(directory, 'resources'), { recursive: true })
  fs.writeFileSync(path.join(directory, 'DevKit.exe'), executable)
  await asar.createPackage(source, path.join(directory, 'resources/app.asar'))
  return directory
}

// Small stored ZIP fixtures exercise the real ZIP reader without requiring a platform CLI.
function zip(entries) {
  const local = []
  const central = []
  let offset = 0
  for (const [filename, bytes] of entries) {
    const name = Buffer.from(filename)
    let crc = 0xffffffff
    for (const byte of bytes) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    crc = (crc ^ 0xffffffff) >>> 0
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50)
    header.writeUInt16LE(20, 4)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(bytes.length, 18)
    header.writeUInt32LE(bytes.length, 22)
    header.writeUInt16LE(name.length, 26)
    local.push(header, name, bytes)
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50)
    record.writeUInt16LE(20, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(bytes.length, 20)
    record.writeUInt32LE(bytes.length, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt32LE(offset, 42)
    central.push(record, name)
    offset += header.length + name.length + bytes.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}
async function release(t, options = {}) {
  const directory = temporary(t)
  await bundle(path.join(directory, 'win-unpacked'))
  fs.writeFileSync(path.join(directory, 'DevKit-portable.exe'), options.portable || pe(103))
  const zipped = await bundle(path.join(directory, 'zip-fixture'), options.zip)
  const entries = ['DevKit.exe', 'resources/app.asar'].map((name) =>
    [name, fs.readFileSync(path.join(zipped, ...name.split('/')))])
  if (options.editZip) options.editZip(entries)
  fs.writeFileSync(path.join(directory, 'DevKit-win-x64.zip'), zip(entries))
  return directory
}
function corruptFrame(entries) {
  const entry = entries.find((item) => item.type === 3)
  new Uint8Array(entry.bin)[100] ^= 1
}
function padFrame(entries, value = 0) {
  const entry = entries.find((item) => item.type === 3)
  entry.bin = arrayBuffer(Buffer.concat([Buffer.from(entry.bin), Buffer.alloc(16, value)]))
}

test('reads matching real PE resources and both runtime assets from ASAR', async (t) => {
  const directory = await bundle(path.join(temporary(t), 'app'))
  assert.equal(checkUnpacked(directory, branding).length, 2)
})

test('rejects a matching icon placed only in an unrelated group', (t) => {
  assert.throws(() => checkPeIcon(writePe(t, pe(103)), branding, 1), /missing RT_GROUP_ICON #1/)
})

test('rejects a different first Shell icon even when the requested group matches', (t) => {
  const bytes = pe(103, (entries) => Resource.IconGroupEntry.replaceIconsForResource(entries, 1, 1033, icons()))
  assert.throws(() => checkPeIcon(writePe(t, bytes), branding, 103), /unexpected first icon group/)
})

test('rejects changed image bytes and incorrect frame dimensions', (t) => {
  assert.throws(() => checkPeIcon(writePe(t, pe(1, corruptFrame)), branding, 1), /icon frames differ/)
  const wrongDimensions = pe(1, (entries) => new Uint8Array(entries.find((entry) => entry.type === 14).bin)[6]++)
  assert.throws(() => checkPeIcon(writePe(t, wrongDimensions), branding, 1), /icon frames differ/)
})

test('rejects missing RT_ICON and declared sizes beyond the resource', (t) => {
  const missing = pe(1, (entries) => entries.splice(entries.findIndex((entry) => entry.type === 3), 1))
  assert.throws(() => checkPeIcon(writePe(t, missing), branding, 1), /missing or duplicate RT_ICON/)
  const invalidSize = pe(1, (entries) => new DataView(entries.find((entry) => entry.type === 14).bin).setUint32(14, 0x7fffffff, true))
  assert.throws(() => checkPeIcon(writePe(t, invalidSize), branding, 1), /invalid RT_ICON dataSize/)
})

test('accepts NSIS zero padding outside the declared image but rejects non-zero padding', (t) => {
  assert.match(checkPeIcon(writePe(t, pe(103, padFrame)), branding, 103), /group #103/)
  assert.throws(() => checkPeIcon(writePe(t, pe(103, (entries) => padFrame(entries, 1))), branding, 103), /non-zero RT_ICON padding/)
})

test('does not allow NSIS padding rules to hide excess inner EXE bytes', (t) => {
  assert.throws(() => checkPeIcon(writePe(t, pe(1, padFrame)), branding, 1), /unexpected RT_ICON padding/)
})

test('rejects missing or stale runtime ICO even when the PE is correct', async (t) => {
  const directory = temporary(t)
  const missing = await bundle(path.join(directory, 'missing'), { ico: null })
  assert.throws(() => checkUnpacked(missing, branding), /devkit.ico.*not found/)
  const stale = await bundle(path.join(directory, 'stale'), { ico: Buffer.from('old ICO') })
  assert.throws(() => checkUnpacked(stale, branding), /runtime devkit.ico differs/)
})

test('rejects stale runtime PNG', async (t) => {
  const directory = await bundle(path.join(temporary(t), 'app'), { png: Buffer.from('old PNG') })
  assert.throws(() => checkUnpacked(directory, branding), /runtime app-256.png differs/)
})

test('release validation reads the actual portable and ZIP payloads', async (t) => {
  const result = await checkRelease(await release(t), branding)
  assert.equal(result.length, 5)
  assert.ok(result.some((line) => line.startsWith('portable:') && line.includes('group #103')))
  assert.equal(result.filter((line) => line.startsWith('ZIP:')).length, 2)
})

test('rejects stale portable icon despite correct unpacked and ZIP assets', async (t) => {
  const directory = await release(t, { portable: pe(103, corruptFrame) })
  await assert.rejects(checkRelease(directory, branding), /portable.exe: icon frames differ/)
})

test('rejects stale ZIP executable despite correct unpacked and portable assets', async (t) => {
  const directory = await release(t, { zip: { executable: pe(1, corruptFrame) } })
  await assert.rejects(checkRelease(directory, branding), /DevKit.exe: icon frames differ/)
})

test('rejects a stale ZIP ASAR even when unpacked runtime assets are correct', async (t) => {
  const directory = await release(t, { zip: { ico: Buffer.from('old ZIP icon') } })
  await assert.rejects(checkRelease(directory, branding), /runtime devkit.ico differs/)
})

test('rejects missing and duplicate ZIP payload entries', async (t) => {
  for (const editZip of [(entries) => entries.pop(), (entries) => entries.push(entries[0])]) {
    const directory = await release(t, { editZip })
    await assert.rejects(checkRelease(directory, branding), /expected exactly one/)
  }
})

test('CLI returns nonzero on an invalid packaged directory', (t) => {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/check-packaged-branding.cjs'), temporary(t)], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Packaged branding verification failed:/)
})
