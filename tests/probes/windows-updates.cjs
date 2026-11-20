const assert = require('node:assert/strict')
const { execFileSync, spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')
const { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const unzipper = require('unzipper')

const current = require('../../package.json').version
const next = process.argv[2]
const nextRoot = resolve(process.argv[3] || 'release-update-next')
const currentRoot = resolve('release')

const name = (version, format) => format === 'portable'
  ? 'DevKit-' + version + '-portable.exe' : 'DevKit-' + version + '-win-x64.zip'

async function digest(filename) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}

async function until(label, read, timeout = 120_000) {
  for (const end = Date.now() + timeout; Date.now() < end;) {
    const value = await read()
    if (value) return value
    await delay(200)
  }
  throw new Error('Timed out during Windows update smoke: ' + label)
}

async function connect(profile) {
  const page = await until('packaged workbench debugger', async () => {
    try {
      const [port] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)
      const result = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(2000) })
      return (await result.json()).find((target) => target.type === 'page' && target.url.includes('/renderer/index.html'))
    } catch { return undefined }
  })
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((done, reject) => {
    socket.addEventListener('open', done, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let id = 0
  async function evaluate(expression) {
    return new Promise((done, reject) => {
      const request = ++id
      const onMessage = ({ data }) => {
        const response = JSON.parse(data)
        if (response.id !== request) return
        cleanup()
        if (response.error || response.result?.exceptionDetails) reject(new Error(JSON.stringify(response)))
        else done(response.result?.result?.value)
      }
      const cleanup = () => {
        clearTimeout(timer)
        socket.removeEventListener('message', onMessage)
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('Workbench debugger did not respond: ' + expression))
      }, 5000)
      socket.addEventListener('message', onMessage)
      socket.send(JSON.stringify({ id: request, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
    })
  }
  return { evaluate, close: () => socket.close() }
}

async function exercise(root, format, outcome) {
  console.log('Testing Windows packaged ' + format + ' ' + outcome)
  const testRoot = join(root, format + '-' + outcome)
  const install = join(testRoot, 'DevKit 工具')
  const profile = join(testRoot, 'profile')
  await mkdir(install, { recursive: true })
  await mkdir(profile, { recursive: true })
  const exe = join(install, format === 'portable' ? 'DevKit renamed.exe' : 'DevKit.exe')
  const originalPackage = join(currentRoot, name(current, format))
  if (format === 'portable') await copyFile(originalPackage, exe)
  else await (await unzipper.Open.file(originalPackage)).extract({ path: install })
  const oldHash = await digest(exe)

  const cache = join(profile, 'updates', createHash('sha256').update(exe.toLowerCase()).digest('hex').slice(0, 24))
  const pending = join(cache, name(next, format))
  await mkdir(cache, { recursive: true })
  if (outcome === 'rollback') await writeFile(pending, 'Verified fixture that cannot be launched by Windows')
  else await copyFile(join(nextRoot, name(next, format)), pending)
  const candidate = { version: next, tag: 'v' + next, notes: 'Windows packaged update smoke',
    bytes: (await stat(pending)).size, hash: await digest(pending) }
  await writeFile(join(cache, 'pending.json'), JSON.stringify(candidate))
  const dataMarker = join(profile, 'existing-config.txt')
  await writeFile(dataMarker, 'keep user data')
  const extra = join(install, 'other project.txt')
  if (outcome === 'refuse') await writeFile(extra, 'keep directory contents')

  const child = spawn(exe, ['--user-data-dir=' + profile, '--remote-debugging-port=0'], {
    cwd: install, stdio: 'ignore'
  })
  child.on('error', (error) => console.error(error))
  const { evaluate, close } = await connect(profile)
  try {
    await until('download-ready state', () =>
      evaluate('document.querySelector(".update-entry")?.textContent.includes("已下载")'))
    await evaluate('document.querySelector(".update-entry").click()')
    assert.ok(await evaluate('(() => { const restart = [...document.querySelectorAll(".update-actions button")]' +
      '.find(button => button.textContent.trim() === "重启并更新"); if (!restart) return false; restart.click(); return true })()'))

    if (outcome === 'refuse') {
      await until('ZIP refuses a shared directory', () =>
        evaluate('document.querySelector(".update-message")?.textContent.includes("另存")'))
      assert.equal(await readFile(extra, 'utf8'), 'keep directory contents')
      assert.equal(await digest(exe), oldHash)
      assert.equal(child.exitCode, null)
    } else if (outcome === 'rollback') {
      await until('rollback result', async () =>
        (await readFile(join(cache, 'apply-error'), 'utf8').catch(() => '')).length > 0)
      assert.equal(await digest(exe), oldHash)
      assert.notEqual(child.exitCode, null)
    } else {
      await until('new version starts', async () => {
        const failure = await readFile(join(cache, 'apply-error'), 'utf8').catch(() => '')
        if (failure) throw new Error(failure)
        for (const entry of await readdir(cache)) {
          if (!entry.startsWith('apply-')) continue
          const preflight = await readFile(join(cache, entry, 'ready'), 'utf8').catch(() => '')
          if (preflight === 'failed' || preflight === 'directory') {
            const details = await readFile(join(cache, entry, 'error'), 'utf8').catch(() => preflight)
            throw new Error('Update preparation failed: ' + details)
          }
          if (await readFile(join(cache, entry, 'started'), 'utf8').catch(() => '') === next) return true
        }
        return false
      }, 165_000)
      assert.notEqual(child.exitCode, null)
      if (format === 'portable') assert.equal(await digest(exe), candidate.hash)
      await until('old backup removed after new window opens', async () =>
        (await readdir(format === 'portable' ? install : testRoot)).every((entry) => !entry.startsWith('.devkit-backup-')))
    }
    assert.equal(await readFile(dataMarker, 'utf8'), 'keep user data')
    console.log('PASS Windows packaged ' + format + ' ' + outcome)
  } catch (error) {
    for (const entry of await readdir(cache)) {
      if (!entry.startsWith('apply-')) continue
      const files = await readdir(join(cache, entry))
      const failure = await readFile(join(cache, entry, 'error'), 'utf8').catch(() => '')
      console.error('Update handoff: ' + files.join(', ') + (failure ? '\n' + failure : ''))
    }
    console.error('Original launcher exit status: ' + child.exitCode)
    throw error
  } finally {
    close()
  }
}

async function main() {
  assert.equal(process.platform, 'win32')
  assert.match(next, /^\d+\.\d+\.\d+$/)
  assert.notEqual(next, current)
  const asar = require('@electron/asar')
  assert.equal(JSON.parse(asar.extractFile(join(nextRoot, 'win-unpacked', 'resources', 'app.asar'), 'package.json')).version, next)
  const root = await mkdtemp(join(tmpdir(), 'dk-update-'))
  try {
    await exercise(root, 'portable', 'upgrade')
    await exercise(root, 'zip', 'upgrade')
    await exercise(root, 'zip', 'refuse')
    await exercise(root, 'portable', 'rollback')
  } finally {
    // Close only disposable fixtures created under this test's unique path.
    execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', [
      '$root = $env:DEVKIT_FIXTURE_ROOT',
      'Get-CimInstance Win32_Process | Where-Object {',
      '  ($_.Name -like "DevKit*.exe") -and (',
      '  ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($root + "\\", [StringComparison]::OrdinalIgnoreCase)) -or',
      '  ($_.CommandLine -and $_.CommandLine.Contains($root + "\\")))',
      '} | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }'
    ].join('\n')], { env: { ...process.env, DEVKIT_FIXTURE_ROOT: root }, timeout: 30_000, stdio: 'inherit' })
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
