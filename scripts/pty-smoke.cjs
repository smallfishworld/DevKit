const fs = require('node:fs')
const path = require('node:path')
const pty = require('node-pty')

function findNativeFiles(root) {
  const out = []
  if (!fs.existsSync(root)) return out
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) out.push(...findNativeFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.node')) out.push(full)
  }
  return out
}

const shell = process.env.ComSpec || 'cmd.exe'
const child = pty.spawn(shell, [], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: { ...process.env, TERM: 'xterm-256color' }
})

let output = ''
let done = false
const timer = setTimeout(() => finish(new Error('node-pty smoke test timed out')), 15000)

function exitSoon(code) {
  setTimeout(() => process.exit(code), 50)
}

function finish(error) {
  if (done) return
  done = true
  clearTimeout(timer)
  try { child.kill() } catch {}
  if (error) {
    console.error(error.stack || error.message || error)
    exitSoon(1)
    return
  }
  if (process.env.DEVKIT_CHECK_PACKAGED === '1') {
    const unpacked = path.join(
      __dirname,
      '..',
      'release',
      'win-unpacked',
      'resources',
      'app.asar.unpacked',
      'node_modules',
      'node-pty'
    )
    const nativeFiles = findNativeFiles(unpacked)
    if (nativeFiles.length === 0) {
      console.error(`packaged node-pty native module not found under ${unpacked}`)
      exitSoon(1)
      return
    }
    console.log(`packaged node-pty native files: ${nativeFiles.length}`)
  }
  console.log('node-pty smoke test passed')
  exitSoon(0)
}

child.onData((data) => {
  output += data
  if (output.includes('DEVKIT_PTY_SMOKE_OK')) finish()
})
child.onExit(({ exitCode }) => {
  if (!done && !output.includes('DEVKIT_PTY_SMOKE_OK')) {
    finish(new Error(`cmd.exe exited before smoke marker, code=${exitCode}\n${output}`))
  }
})

child.write('echo DEVKIT_PTY_SMOKE_OK\r')
