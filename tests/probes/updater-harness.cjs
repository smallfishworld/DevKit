'use strict'

// Drives the real DevKitUpdater.exe (compiled from resources/updater) against throwaway directories with a
// stand-in DevKit.exe, so the rules for the installation directory can be checked without packaging the app:
//   node tests/probes/updater-harness.cjs
// The packaged end-to-end flow (real Electron, real packages) stays with tests/probes/windows-updates.cjs.
const assert = require('node:assert/strict')
const { execFileSync, spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { mkdir, mkdtemp, readFile, realpath, rm, rmdir, symlink, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { basename, dirname, join, resolve } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')

const root = resolve(__dirname, '../..')
const next = '9.9.9'
const inventoryFile = 'resources/devkit-update-files.txt'
/** What a user typically leaves next to the program: a shortcut, a folder of their own, a file inside ours. */
const extras = {
  'DevKit.exe - 快捷方式.lnk': 'shortcut to DevKit.exe',
  'desktop.ini': '[.ShellClassInfo]\nIconResource=DevKit.exe,0',
  '项目资料/notes.txt': 'keep me',
  '项目资料/sub/a.txt': 'keep me too',
  'resources/mine.txt': 'dropped into a program folder'
}

async function until(label, read, timeout = 60_000) {
  for (const end = Date.now() + timeout; ; await delay(25)) {
    const value = await read()
    if (value) return value
    if (Date.now() > end) throw new Error('Timed out waiting for ' + label)
  }
}

async function write(file, content) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
}

function compile(source, output, flags) {
  const framework = join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319')
  execFileSync(join(framework, 'csc.exe'), ['/nologo', '/warnaserror+', '/platform:x64', ...flags, '/out:' + output, source], {
    stdio: ['ignore', 'ignore', 'inherit']
  })
}

function tools() {
  const directory = mkdtempSync(join(tmpdir(), 'dk-updater-tools-'))
  const framework = join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319')
  compile(join(root, 'resources/updater/DevKitUpdater.cs'), join(directory, 'DevKitUpdater.exe'),
    ['/target:winexe', '/optimize+', '/reference:' + join(framework, 'System.IO.Compression.dll')])
  copyFileSync(join(root, 'resources/updater/DevKitUpdater.exe.config'), join(directory, 'DevKitUpdater.exe.config'))
  compile(join(__dirname, 'updater-fake-app.cs'), join(directory, 'FakeDevKit.exe'), ['/target:exe'])
  return directory
}

/** The stand-in carries its build in a marker appended to the image. */
const build = (tag) => Buffer.concat([
  readFileSync(join(toolsDirectory, 'FakeDevKit.exe')), Buffer.from('\nDEVKIT-FAKE:' + tag + '\n')
])
const buildOf = (file) => /DEVKIT-FAKE:(\S+)/.exec(readFileSync(file).toString('latin1'))?.[1]

/** Same shape as scripts/package-updater.cjs: files as "a/b", directories as "a/b/", the inventory itself left out. */
function inventory(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix + entry.name
    if (relative === inventoryFile) return []
    return entry.isDirectory()
      ? [relative + '/', ...inventory(join(directory, entry.name), relative + '/')]
      : [relative]
  })
}

async function fixture(name) {
  const area = await mkdtemp(join(tmpdir(), 'dk-updater-'))
  const portableExe = join(area, 'DevKit 便携版.exe')
  const caseDir = join(area, name.replace(/[^\w]+/g, '-') + ' 场景')
  const install = join(caseDir, 'DevKit 工具')
  const profile = join(caseDir, 'profile')
  const control = join(caseDir, 'control')
  const cache = join(caseDir, 'cache')
  for (const directory of [caseDir, profile, control, cache]) mkdirSync(directory)
  const state = { executable: '', children: [] }

  const files = (tag) => ({
    'DevKit.exe': build(tag),
    'chrome_100_percent.pak': 'pak',
    'locales/en-US.pak': 'en',
    'locales/zh-CN.pak': 'zh',
    'resources/app.asar': tag + ' application archive',
    'resources/DevKitUpdater.exe': 'updater binary',
    'resources/DevKitUpdater.exe.config': '<configuration />',
    [inventoryFile]: ''
  })

  return {
    area, caseDir, installDir: install, profile, control, cache, portableExe, state,
    get executable() { return state.executable },
    /** An installed version; without = files the user lost beforehand. */
    async install(tag, { portable = false, without = [] } = {}) {
      if (portable) {
        await write(portableExe, build(tag))
        state.executable = portableExe
        return
      }
      const content = { 'LICENSE.electron.txt': 'license of the previous version', ...files(tag) }
      for (const name of without) delete content[name]
      for (const [name, data] of Object.entries(content)) {
        if (name !== inventoryFile) await write(join(install, name), data)
      }
      content[inventoryFile] = inventory(install).sort().join('\n') + '\n'
      await write(join(install, inventoryFile), content[inventoryFile])
      state.executable = join(install, 'DevKit.exe')
    },
    /** The package of the version to install: it drops a file and a license, adds NEW.txt. */
    async package(tag, { portable = false } = {}) {
      if (portable) {
        const file = join(area, 'next.exe')
        await write(file, build(tag))
        return { archive: file, hash: digest(file) }
      }
      const directory = join(area, 'next')
      const content = { ...files(tag), 'NEW.txt': 'added by the new version', 'locales/ja.pak': 'ja' }
      for (const [name, data] of Object.entries(content)) {
        if (name !== inventoryFile) await write(join(directory, name), data)
      }
      await write(join(directory, inventoryFile), inventory(directory).sort().join('\n') + '\n')
      const archive = join(area, 'next.zip')
      // Same layout as the released ZIP: the program files at the top level, no enclosing folder
      // The Windows bundled bsdtar; a tar earlier on PATH (Git Bash ships GNU tar) would ignore the ZIP suffix
      execFileSync(join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-a', '-cf', archive, '-C', directory, ...readdirSync(directory)], {
        stdio: 'inherit', timeout: 30_000
      })
      return { archive, hash: digest(archive) }
    },
    /** The running application the helper has to wait for. */
    async launch() {
      const child = spawn(state.executable, ['--run', control], { stdio: 'ignore' })
      child.on('error', (error) => console.error(error))
      state.children.push(child)
      return child
    },
    async hold(path, { directory = false } = {}) {
      const own = join(area, 'holder')
      mkdirSync(own, { recursive: true })
      const child = spawn(join(toolsDirectory, 'FakeDevKit.exe'), ['--hold', own, path, ...(directory ? ['--dir'] : [])], { stdio: 'ignore' })
      child.on('error', (error) => console.error(error))
      state.children.push(child)
      await until('the hold on ' + path, () => existsSync(join(own, 'held')), 5000)
      return async () => {
        writeFileSync(join(own, 'release'), '')
        if (child.exitCode === null) await new Promise((done) => child.once('exit', done))
      }
    },
    /** Plays the main process: authorize once the preflight passes, then let the application quit. */
    async update({ format = 'zip', archive, hash, afterReady }) {
      const handoff = await mkdtemp(join(cache, 'apply-'))
      copyFileSync(join(toolsDirectory, 'DevKitUpdater.exe'), join(handoff, 'DevKitUpdater.exe'))
      copyFileSync(join(toolsDirectory, 'DevKitUpdater.exe.config'), join(handoff, 'DevKitUpdater.exe.config'))
      const running = state.children[0]
      const child = spawn(join(handoff, 'DevKitUpdater.exe'), [
        format, state.executable, await realpath(archive), hash, next,
        String(running.pid), String(format === 'portable' ? running.pid : 0), handoff, profile
      ], { cwd: handoff, stdio: 'ignore' })
      const exited = new Promise((done, reject) => {
        child.once('error', reject)
        child.once('exit', done)
      })
      const signal = async (name) => (await readFile(join(handoff, name), 'utf8').catch(() => '')).trim()
      const ready = await until('the preflight result', async () => (await signal('ready')) || (child.exitCode !== null ? 'exited' : ''))
      const detail = ready === 'ok' ? '' : await signal('directory-detail')
      if (ready !== 'ok') writeFileSync(join(handoff, 'cancel'), '')
      await afterReady?.({ ready, detail, running })
      if (ready === 'ok') writeFileSync(join(handoff, 'apply'), '')
      writeFileSync(join(control, 'exit'), '')
      let timer
      const code = await Promise.race([
        exited,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The helper did not exit: ' + name)), 90_000) })
      ]).finally(() => clearTimeout(timer))
      return { code, ready, detail, handoff, signal }
    },
    async marker(name) {
      return (await readFile(join(cache, name), 'utf8').catch(() => '')).trim()
    },
    /** The helper starts the previous version again after giving up: wait for it to tell which build it is. */
    async relaunchedBuild() {
      await until('the relaunch', () => existsSync(join(profile, 'relaunched')), 15_000)
      return readFile(join(profile, 'relaunched'), 'utf8')
    },
    strays() {
      return readdirSync(caseDir).filter((entry) => entry.startsWith('.devkit-'))
    },
    async dispose() {
      for (const name of ['exit', 'release']) writeFileSync(join(control, name), '')
      await write(join(profile, 'exit'), '')
      await delay(300)
      for (const child of state.children) if (child.exitCode === null) child.kill()
      // The versions the helper started are not our children; they leave on their own once told to.
      await rm(area, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 })
    }
  }
}

function digest(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

async function withExtras(f, added = {}) {
  for (const [name, content] of Object.entries({ ...extras, ...added })) await write(join(f.installDir, name), content)
}

/** Every user file is back where it was, with what it held; skip what a scenario deliberately leaves behind. */
async function assertExtras(f, skip = []) {
  for (const [name, content] of Object.entries(extras)) {
    if (skip.includes(name)) continue
    assert.equal(await readFile(join(f.installDir, name), 'utf8'), content, name + ' should come through the update unchanged')
  }
}

function assertInstalled(f, tag) {
  assert.equal(buildOf(f.executable), tag)
}

async function keepsUserFiles(f) {
  await f.install('old')
  await withExtras(f)
  const pack = await f.package('new')
  await f.launch()
  const run = await f.update(pack)
  assert.equal(run.ready, 'ok')
  assert.equal(run.code, 0, 'a shortcut and a user folder must not block the update')
  assertInstalled(f, 'new')
  assert.equal(await readFile(join(f.installDir, 'resources/app.asar'), 'utf8'), 'new application archive')
  assert.ok(existsSync(join(f.installDir, 'NEW.txt')))
  assert.equal(existsSync(join(f.installDir, 'LICENSE.electron.txt')), false, 'a file the new version dropped is gone')
  await assertExtras(f)
  assert.deepEqual(f.strays(), [], 'the backup is removed once the new version runs')
  assert.equal(await f.marker('apply-error'), '')
  assert.equal(await f.marker('apply-leftover'), '')
}

async function repairsInstall(f) {
  await f.install('old', { without: ['locales/zh-CN.pak', 'LICENSE.electron.txt'] })
  await withExtras(f)
  const pack = await f.package('new')
  await f.launch()
  const run = await f.update(pack)
  assert.equal(run.ready, 'ok')
  assert.equal(run.code, 0)
  assert.equal(await readFile(join(f.installDir, 'locales/zh-CN.pak'), 'utf8'), 'zh')
  await assertExtras(f)
  assert.deepEqual(f.strays(), [])
}

async function refusesCollision(f) {
  await f.install('old')
  await withExtras(f, { 'NEW.txt': 'the user owns this name' })
  const pack = await f.package('new')
  await f.launch()
  const run = await f.update({ ...pack, afterReady: ({ running }) => assert.equal(running.exitCode, null, 'DevKit must still be running') })
  assert.equal(run.ready, 'collision')
  assert.equal(run.detail, 'NEW.txt')
  assert.equal(run.code, 1)
  assertInstalled(f, 'old')
  assert.equal(await readFile(join(f.installDir, 'NEW.txt'), 'utf8'), 'the user owns this name')
  assert.equal(existsSync(join(run.handoff, 'cancel')), true)
  assert.equal(existsSync(join(run.handoff, 'started')), false)
  assert.deepEqual(f.strays(), [], 'a refused update leaves nothing behind')
}

/** The directory cannot be vouched for as an installation of this program: say so and leave it alone. */
async function refusesDamaged(f, damage, detail) {
  await f.install('old')
  await damage(f)
  const pack = await f.package('new')
  await f.launch()
  const run = await f.update({ ...pack, afterReady: ({ running }) => assert.equal(running.exitCode, null, 'DevKit must still be running') })
  assert.equal(run.ready, 'directory')
  assert.equal(run.detail, detail)
  assert.equal(run.code, 1)
  assertInstalled(f, 'old')
  assert.deepEqual(f.strays(), [])
}

async function refusesLink(f) {
  await f.install('old')
  await withExtras(f)
  const elsewhere = join(f.caseDir, 'elsewhere')
  await write(join(elsewhere, 'precious.txt'), 'must not be touched')
  const link = join(f.installDir, 'linked')
  await symlink(elsewhere, link, 'junction')
  try {
    await refusesDamaged(f, () => {}, '符号链接: linked')
  } finally {
    // Only the link goes; what it points at is none of the updater's business
    await rmdir(link)
  }
  assert.equal(await readFile(join(elsewhere, 'precious.txt'), 'utf8'), 'must not be touched')
}

async function refusesHeld(f, hold, expected) {
  await f.install('old')
  await withExtras(f)
  const pack = await f.package('new')
  await f.launch()
  const release = await hold(f)
  try {
    const run = await f.update({ ...pack, afterReady: ({ running }) => assert.equal(running.exitCode, null, 'DevKit must still be running') })
    assert.equal(run.ready, 'locked')
    assert.equal(run.detail, expected)
    assert.equal(run.code, 1)
    assertInstalled(f, 'old')
    assert.deepEqual(f.strays(), [])
  } finally {
    await release()
  }
}

/** Node opens with every share flag, which is exactly what an open request cannot reveal. */
const heldByReader = (file) => async (f) => {
  const handle = openSync(join(f.installDir, file), 'r')
  return () => closeSync(handle)
}
const heldByEditor = (file) => async (f) => f.hold(join(f.installDir, file))
const heldByExplorer = (directory) => async (f) => f.hold(join(f.installDir, directory), { directory: true })

async function toleratesMomentaryHold(f) {
  await f.install('old')
  await withExtras(f)
  const pack = await f.package('new')
  await f.launch()
  const release = await heldByReader('项目资料/notes.txt')(f)
  const released = delay(500).then(release)
  const run = await f.update(pack)
  assert.equal(run.ready, 'ok')
  assert.equal(run.code, 0)
  assertInstalled(f, 'new')
  await assertExtras(f)
  assert.deepEqual(f.strays(), [])
  await released
}

async function reportsLateLock(f) {
  await f.install('old')
  await withExtras(f)
  const pack = await f.package('new')
  await f.launch()
  let handle
  const run = await f.update({
    ...pack,
    // Taken only after the preflight had a look: the swap then finds the directory in use
    afterReady: () => { handle = openSync(join(f.installDir, '项目资料/notes.txt'), 'r') }
  })
  closeSync(handle)
  assert.equal(run.code, 1)
  assert.equal(await f.marker('apply-error') !== '', true)
  assert.equal(await f.marker('apply-detail'), 'locked', 'the next start can say why the update did not happen')
  assertInstalled(f, 'old')
  assert.ok(existsSync(join(f.installDir, 'LICENSE.electron.txt')))
  assert.equal(existsSync(join(f.installDir, 'NEW.txt')), false)
  await assertExtras(f)
  assert.deepEqual(f.strays(), [])
  assert.equal(await f.relaunchedBuild(), 'old')
}

async function rollsBackWithExtras(f) {
  await f.install('old')
  await withExtras(f)
  const pack = await f.package('new')
  await f.launch()
  await write(join(f.profile, 'startup'), 'fail')
  const run = await f.update(pack)
  assert.equal(run.ready, 'ok')
  assert.equal(run.code, 1)
  assert.equal(await f.marker('apply-error') !== '', true)
  assert.equal(await f.marker('apply-detail'), '')
  assertInstalled(f, 'old')
  assert.ok(existsSync(join(f.installDir, 'LICENSE.electron.txt')))
  await assertExtras(f)
  assert.deepEqual(f.strays(), [])
  assert.equal(await f.relaunchedBuild(), 'old')
}

async function keepsLeftover(f) {
  await f.install('old')
  await withExtras(f)
  const pack = await f.package('new')
  await f.launch()
  const run = await f.update({
    ...pack,
    // The new version turns out to ship a folder of the same name after all: the user's folder cannot return
    afterReady: async () => {
      const stage = f.strays().find((entry) => entry.startsWith('.devkit-stage-'))
      assert.ok(stage, 'the new version is staged next to the installation')
      await write(join(f.caseDir, stage, '项目资料', 'late.txt'), 'shipped by the new version')
    }
  })
  assert.equal(run.ready, 'ok')
  assert.equal(run.code, 0, 'the update itself is not at risk')
  assertInstalled(f, 'new')
  assert.equal(await readFile(join(f.installDir, '项目资料', 'late.txt'), 'utf8'), 'shipped by the new version')
  await assertExtras(f, ['项目资料/notes.txt', '项目资料/sub/a.txt'])
  const [backup, ...kept] = (await f.marker('apply-leftover')).split(/\r?\n/)
  assert.match(basename(backup), /^\.devkit-backup-[a-f0-9]{32}$/)
  assert.deepEqual(kept, ['项目资料/'])
  assert.deepEqual(f.strays(), [basename(backup)], 'the backup holding user files is kept')
  assert.equal(await readFile(join(backup, '项目资料', 'notes.txt'), 'utf8'), 'keep me')
}

async function portableUpgrade(f) {
  await f.install('old', { portable: true })
  const pack = await f.package('new', { portable: true })
  await f.launch()
  const run = await f.update({ ...pack, format: 'portable' })
  assert.equal(run.ready, 'ok')
  assert.equal(run.code, 0)
  assert.equal(await run.signal('started'), next)
  assertInstalled(f, 'new')
  assert.deepEqual(f.strays(), [])
}

async function portableRollback(f) {
  await f.install('old', { portable: true })
  const pack = await f.package('new', { portable: true })
  await f.launch()
  await write(join(f.profile, 'startup'), 'fail')
  const run = await f.update({ ...pack, format: 'portable' })
  assert.equal(run.code, 1)
  assert.equal(await f.marker('apply-error') !== '', true)
  assertInstalled(f, 'old')
  assert.deepEqual(f.strays(), [])
  assert.equal(await f.relaunchedBuild(), 'old')
}

const scenarios = [
  ['user files survive an update', keepsUserFiles],
  ['files the installation lost are brought back', repairsInstall],
  ['a user file named like a new program file is refused', refusesCollision],
  ['a link inside the installation is refused', refusesLink],
  ['a directory without the package inventory is refused',
    (f) => refusesDamaged(f, (f) => rm(join(f.installDir, inventoryFile), { force: true }), '缺少核心程序文件或清单异常')],
  ['an inventory that does not list the application is refused',
    (f) => refusesDamaged(f, (f) => write(join(f.installDir, inventoryFile), 'LICENSE.electron.txt\n'), '缺少核心程序文件或清单异常')],
  ['a user file open elsewhere is refused before DevKit quits', (f) => refusesHeld(f, heldByReader('项目资料/notes.txt'), '项目资料/notes.txt')],
  ['a user file open without delete sharing is refused', (f) => refusesHeld(f, heldByEditor('项目资料/sub/a.txt'), '项目资料/sub/a.txt')],
  ['a user folder open elsewhere is refused', (f) => refusesHeld(f, heldByExplorer('项目资料'), '项目资料/')],
  ['a file released within a moment does not block the update', toleratesMomentaryHold],
  ['a lock taken after the preflight rolls back and is reported', reportsLateLock],
  ['the old version and its user files come back when the new one fails', rollsBackWithExtras],
  ['user files that cannot return stay in a reported backup', keepsLeftover],
  ['portable: the launcher is replaced and the backup removed', portableUpgrade],
  ['portable: the previous launcher comes back', portableRollback]
]

let toolsDirectory
async function main() {
  assert.equal(process.platform, 'win32')
  toolsDirectory = tools()
  try {
    for (const [name, scenario] of scenarios) {
      const f = await fixture(name)
      try {
        await scenario(f)
        console.log('PASS updater: ' + name)
      } catch (error) {
        for (const handoff of readdirSync(f.cache).filter((entry) => entry.startsWith('apply-'))) {
          for (const signal of ['ready', 'directory-detail', 'error', 'apply-error', 'apply-detail', 'apply-leftover']) {
            const text = await readFile(join(f.cache, handoff, signal), 'utf8').catch(() => '')
            if (text) console.error(signal + ': ' + text.trim())
          }
        }
        console.error('FAIL updater: ' + name)
        throw error
      } finally {
        await f.dispose()
      }
    }
  } finally {
    rmSync(toolsDirectory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
