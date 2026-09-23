import assert from 'node:assert/strict'
import {
  detectWindowsShellProfiles,
  findOnWindowsPath,
  parseWslDistributionList
} from '../src/main/services/localTerminal/shellProfiles'
import { normalizeLocalTerminalProfileId } from '../src/shared/local-terminal'

const norm = (p) => p.toLowerCase().replaceAll('/', '\\')

{
  const env = { Path: 'C:\\Tools;C:\\Program Files\\PowerShell\\7' }
  const files = new Set([norm('C:\\Program Files\\PowerShell\\7\\pwsh.exe')])
  const found = findOnWindowsPath('pwsh.exe', env, (p) => files.has(norm(p)))
  assert.equal(norm(found), norm('C:\\Program Files\\PowerShell\\7\\pwsh.exe'))
}

{
  const parsed = parseWslDistributionList('Ubuntu\r\nDebian\r\ndocker-desktop\r\nUbuntu\r\n')
  assert.deepEqual(parsed, ['Ubuntu', 'Debian'])
  assert.deepEqual(parseWslDistributionList('U\0b\0u\0n\0t\0u\0\r\0\n\0'), ['Ubuntu'])
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
      'C:\\Windows\\System32\\wsl.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Program Files\\Git\\bin\\bash.exe'
    ].map(norm)
  )
  const profiles = detectWindowsShellProfiles(env, (p) => files.has(norm(p)), ['Ubuntu', 'Debian'])
  const powerShell7 = profiles.find((p) => p.id === 'powershell-7')
  const windowsPowerShell = profiles.find((p) => p.id === 'windows-powershell')
  const cmd = profiles.find((p) => p.id === 'cmd')
  const gitBash = profiles.find((p) => p.id === 'git-bash')
  const ubuntu = profiles.find((p) => p.id === 'wsl:Ubuntu')
  const debian = profiles.find((p) => p.id === 'wsl:Debian')

  assert.equal(powerShell7?.available, true)
  assert.equal(norm(powerShell7?.command ?? ''), norm('C:\\Program Files\\PowerShell\\7\\pwsh.exe'))
  assert.equal(windowsPowerShell?.available, true)
  assert.equal(norm(windowsPowerShell?.command ?? ''), norm('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'))
  assert.equal(cmd?.available, true)
  assert.equal(gitBash?.available, true)
  assert.equal(norm(gitBash?.command ?? ''), norm('C:\\Program Files\\Git\\bin\\bash.exe'))
  assert.deepEqual(gitBash?.args, ['--login', '-i'])
  assert.equal(ubuntu?.kind, 'wsl')
  assert.deepEqual(ubuntu?.args, ['--distribution', 'Ubuntu'])
  assert.equal(debian?.name, 'WSL · Debian')

  assert.equal(normalizeLocalTerminalProfileId('powershell', profiles), 'powershell-7')
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
  const profiles = detectWindowsShellProfiles(env, (p) => files.has(norm(p)), [])
  assert.equal(profiles.find((p) => p.id === 'powershell-7')?.available, false)
  assert.equal(profiles.find((p) => p.id === 'windows-powershell')?.available, true)
  assert.equal(profiles.find((p) => p.id === 'git-bash')?.available, false)
  assert.equal(normalizeLocalTerminalProfileId('powershell', profiles), 'windows-powershell')
}

console.log('local-terminal shell profile tests passed')
