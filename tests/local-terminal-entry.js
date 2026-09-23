import assert from 'node:assert/strict'
import { detectWindowsShellProfiles, findOnWindowsPath } from '../src/main/services/localTerminal/shellProfiles'

const norm = (p) => p.toLowerCase().replaceAll('/', '\\')

{
  const env = { Path: 'C:\\Tools;C:\\Program Files\\PowerShell\\7' }
  const files = new Set([norm('C:\\Program Files\\PowerShell\\7\\pwsh.exe')])
  const found = findOnWindowsPath('pwsh.exe', env, (p) => files.has(norm(p)))
  assert.equal(norm(found), norm('C:\\Program Files\\PowerShell\\7\\pwsh.exe'))
}

{
  const env = {
    SystemRoot: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    ProgramFiles: 'C:\\Program Files',
    LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
    Path: 'C:\\Program Files\\Git\\cmd;C:\\Program Files\\PowerShell\\7'
  }
  const files = new Set(
    [
      'C:\\Windows\\System32\\cmd.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Program Files\\Git\\bin\\bash.exe'
    ].map(norm)
  )
  const profiles = detectWindowsShellProfiles(env, (p) => files.has(norm(p)))
  const powerShell = profiles.find((p) => p.id === 'powershell')
  const cmd = profiles.find((p) => p.id === 'cmd')
  const gitBash = profiles.find((p) => p.id === 'git-bash')
  assert.equal(powerShell?.available, true)
  assert.equal(powerShell?.source, 'PowerShell 7')
  assert.equal(norm(powerShell?.command ?? ''), norm('C:\\Program Files\\PowerShell\\7\\pwsh.exe'))
  assert.equal(cmd?.available, true)
  assert.equal(gitBash?.available, true)
  assert.equal(norm(gitBash?.command ?? ''), norm('C:\\Program Files\\Git\\bin\\bash.exe'))
  assert.deepEqual(gitBash?.args, ['--login', '-i'])
}

{
  const env = {
    SystemRoot: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    Path: ''
  }
  const files = new Set(
    [
      'C:\\Windows\\System32\\cmd.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    ].map(norm)
  )
  const profiles = detectWindowsShellProfiles(env, (p) => files.has(norm(p)))
  const powerShell = profiles.find((p) => p.id === 'powershell')
  assert.equal(powerShell?.available, true)
  assert.equal(powerShell?.source, 'Windows PowerShell')
  assert.equal(profiles.find((p) => p.id === 'git-bash')?.available, false)
}

console.log('local-terminal shell profile tests passed')
