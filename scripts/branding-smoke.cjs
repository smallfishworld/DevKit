'use strict'

// Build first. --release additionally exercises the real portable launcher.
// The probe owns temporary profiles/processes and never edits pinned shortcuts.
const { spawn, spawnSync } = require('node:child_process')
const path = require('node:path')

if (process.platform !== 'win32') {
  console.error('Windows branding smoke requires a Windows host.')
  process.exitCode = 1
} else if (process.argv.slice(2).some((arg) => arg !== '--release')) {
  console.error('Usage: node scripts/branding-smoke.cjs [--release]')
  process.exitCode = 1
} else {
  const root = path.resolve(__dirname, '..')
  const args = [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File',
    path.join(root, 'tests/probes/windows-branding.ps1'), '-Root', root,
    ...(process.argv.includes('--release') ? ['-Release'] : [])
  ]
  const child = spawn('pwsh.exe', args, { cwd: root, stdio: 'inherit' })
  let stopped = false
  function stop(reason) {
    if (child.exitCode !== null || child.signalCode !== null || stopped) return
    stopped = true
    console.error(reason)
    // Terminate the whole fixture tree; killing only pwsh could orphan DevKit.
    if (child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'inherit', timeout: 15000 })
    process.exitCode = 1
  }
  const timer = setTimeout(() => stop('Windows branding smoke timed out'), 240_000)
  process.once('SIGINT', () => stop('Windows branding smoke interrupted'))
  process.once('SIGTERM', () => stop('Windows branding smoke terminated'))
  child.on('error', (error) => { clearTimeout(timer); console.error(error.message); process.exitCode = 1 })
  child.on('exit', (code) => { clearTimeout(timer); process.exitCode = stopped ? 1 : (code ?? 1) })
}
