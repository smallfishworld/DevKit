const assert = require('node:assert/strict')
const { execFileSync, spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')
const { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')

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

async function handoffs(cache) {
  const entries = await readdir(cache, { withFileTypes: true })
  return entries.filter((entry) => entry.isDirectory() && /^apply-[a-z0-9]{6}$/i.test(entry.name))
    .map((entry) => join(cache, entry.name))
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
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error('Workbench debugger WebSocket did not open'))
    }, 10_000)
    socket.addEventListener('open', () => { clearTimeout(timer); done() }, { once: true })
    socket.addEventListener('error', (event) => { clearTimeout(timer); reject(event) }, { once: true })
  })
  let id = 0
  async function evaluate(expression) {
    if (socket.readyState !== WebSocket.OPEN) throw new Error('Workbench debugger disconnected')
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
        socket.removeEventListener('close', onClose)
      }
      const onClose = () => {
        cleanup()
        reject(new Error('Workbench debugger disconnected before evaluation completed'))
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('Workbench debugger did not respond: ' + expression))
      }, 5000)
      socket.addEventListener('message', onMessage)
      socket.addEventListener('close', onClose, { once: true })
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
  // CreateProcess accepts a Unicode working directory even if tar's argument decoder uses a legacy code page.
  else execFileSync('tar.exe', ['-xf', originalPackage], { cwd: install, stdio: 'inherit', timeout: 90_000 })
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
  child.unref()
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
      await until('old executable restored', async () => await digest(exe).catch(() => '') === oldHash, 5000)
      await until('old portable launcher exits', () => child.exitCode !== null, 5000)
    } else {
      await until('new version starts', async () => {
        const failure = await readFile(join(cache, 'apply-error'), 'utf8').catch(() => '')
        if (failure) throw new Error(failure)
        for (const handoff of await handoffs(cache)) {
          const preflight = await readFile(join(handoff, 'ready'), 'utf8').catch(() => '')
          if (preflight === 'failed' || preflight === 'directory') {
            const details = await readFile(join(handoff, 'error'), 'utf8').catch(() => preflight)
            throw new Error('Update preparation failed: ' + details)
          }
          if (await readFile(join(handoff, 'started'), 'utf8').catch(() => '') === next) return true
        }
        return false
      }, 165_000)
      await until('old application exits', () => child.exitCode !== null, 5000)
      if (format === 'portable') assert.equal(await digest(exe), candidate.hash)
      await until('old backup removed after new window opens', async () =>
        (await readdir(format === 'portable' ? install : testRoot)).every((entry) => !entry.startsWith('.devkit-backup-')))
    }
    assert.equal(await readFile(dataMarker, 'utf8'), 'keep user data')
    console.log('PASS Windows packaged ' + format + ' ' + outcome)
  } catch (error) {
    for (const handoff of await handoffs(cache).catch(() => [])) {
      const files = await readdir(handoff).catch(() => [])
      const failure = await readFile(join(handoff, 'error'), 'utf8').catch(() => '')
      console.error('Update handoff: ' + files.join(', ') + (failure ? '\n' + failure : ''))
    }
    const result = await readFile(join(cache, 'apply-error'), 'utf8').catch(() => '')
    if (result) console.error(result)
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
  const hosted = process.env.RUNNER_ENVIRONMENT === 'github-hosted'
  const root = await mkdtemp(join(tmpdir(), 'dk-update-'))
  try {
    await exercise(root, 'portable', 'upgrade')
    await exercise(root, 'zip', 'upgrade')
    await exercise(root, 'zip', 'refuse')
    await exercise(root, 'portable', 'rollback')
  } finally {
    // The hosted VM disposes its own processes and temporary files after this job.
    if (!hosted) await cleanLocalFixtures(root)
  }
}

async function cleanLocalFixtures(root) {
  // Close only disposable fixtures created under this test's unique path.
  console.log('Cleaning up Windows update fixtures')
  const cleanup = spawn('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', [
    '$root = $env:DEVKIT_FIXTURE_ROOT',
    'Get-CimInstance Win32_Process | Where-Object {',
    '  ($_.Name -like "DevKit*.exe") -and (',
    '  ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($root + "\\", [StringComparison]::OrdinalIgnoreCase)) -or',
    '  ($_.CommandLine -and $_.CommandLine.Contains($root + "\\")))',
    '} | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }'
  ].join('\n')], { env: { ...process.env, DEVKIT_FIXTURE_ROOT: root }, stdio: 'inherit' })
  cleanup.unref()
  await new Promise((done, reject) => {
    const timer = setTimeout(() => {
      cleanup.kill()
      reject(new Error('Windows update fixture cleanup timed out: ' + root))
    }, 30_000)
    cleanup.once('error', (error) => { clearTimeout(timer); reject(error) })
    cleanup.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) done()
      else reject(new Error('Windows update fixture cleanup failed (exit ' + code + '): ' + root))
    })
  })
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 })
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
