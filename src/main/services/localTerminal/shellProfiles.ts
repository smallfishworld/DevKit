import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import type { ShellProfile } from '../../../shared/local-terminal'

type Env = NodeJS.ProcessEnv
export type ExistsFn = (path: string) => boolean

function cleanPathPart(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1)
  return trimmed
}

export function findOnWindowsPath(name: string, env: Env, exists: ExistsFn = existsSync): string | undefined {
  const pathValue = env.Path ?? env.PATH ?? ''
  for (const rawPart of pathValue.split(';')) {
    const part = cleanPathPart(rawPart)
    if (!part) continue
    const candidate = win32.join(part, name)
    if (exists(candidate)) return candidate
  }
  return undefined
}

function firstExisting(candidates: Array<string | undefined>, exists: ExistsFn): string | undefined {
  for (const candidate of candidates) {
    if (candidate && exists(candidate)) return candidate
  }
  return undefined
}

function gitBashCandidates(env: Env, gitExe?: string): string[] {
  const result: string[] = []
  if (env.ProgramFiles) result.push(win32.join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'))
  if (env['ProgramFiles(x86)']) result.push(win32.join(env['ProgramFiles(x86)']!, 'Git', 'bin', 'bash.exe'))
  if (env.LOCALAPPDATA) result.push(win32.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'))
  if (gitExe) {
    const gitDir = win32.dirname(gitExe)
    const root = win32.dirname(gitDir)
    result.push(win32.join(root, 'bin', 'bash.exe'))
    result.push(win32.join(root, 'usr', 'bin', 'bash.exe'))
  }
  return result
}

/** `wsl.exe --list --quiet` 在部分 Windows 版本重定向输出时会混入 NUL（UTF-16LE 痕迹）。 */
export function parseWslDistributionList(output: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const rawLine of output.replaceAll('\0', '').split(/\r?\n/)) {
    const name = rawLine.replace(/^\*\s*/, '').trim()
    if (!name) continue
    // Docker Desktop 的内部发行版不是用户交互式 Shell，不放进终端选择器。
    if (name.toLowerCase() === 'docker-desktop' || name.toLowerCase() === 'docker-desktop-data') continue
    if (seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    result.push(name)
  }
  return result
}

function wslExecutable(env: Env, exists: ExistsFn): string | undefined {
  const systemRoot = env.SystemRoot ?? env.WINDIR ?? 'C:\\Windows'
  return firstExisting(
    [win32.join(systemRoot, 'System32', 'wsl.exe'), findOnWindowsPath('wsl.exe', env, exists)],
    exists
  )
}

export function detectWslDistributions(env: Env = process.env, exists: ExistsFn = existsSync): string[] {
  const command = wslExecutable(env, exists)
  if (!command) return []
  try {
    const output = execFileSync(command, ['--list', '--quiet'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return parseWslDistributionList(output)
  } catch {
    return []
  }
}

export function detectWindowsShellProfiles(
  env: Env = process.env,
  exists: ExistsFn = existsSync,
  wslDistributions?: string[]
): ShellProfile[] {
  const systemRoot = env.SystemRoot ?? env.WINDIR ?? 'C:\\Windows'
  const cmd = firstExisting(
    [env.ComSpec, win32.join(systemRoot, 'System32', 'cmd.exe'), findOnWindowsPath('cmd.exe', env, exists)],
    exists
  )

  const pwsh = findOnWindowsPath('pwsh.exe', env, exists)
  const windowsPowerShell = firstExisting(
    [
      win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      findOnWindowsPath('powershell.exe', env, exists)
    ],
    exists
  )

  const gitExe = findOnWindowsPath('git.exe', env, exists)
  const gitBash = firstExisting(gitBashCandidates(env, gitExe), exists)
  const wsl = wslExecutable(env, exists)
  const distros = wslDistributions ?? detectWslDistributions(env, exists)

  const profiles: ShellProfile[] = [
    {
      id: 'powershell-7',
      name: 'PowerShell 7',
      kind: 'powershell',
      command: pwsh ?? 'pwsh.exe',
      args: ['-NoLogo'],
      available: !!pwsh,
      source: pwsh ? 'pwsh.exe' : undefined
    },
    {
      id: 'windows-powershell',
      name: 'Windows PowerShell',
      kind: 'powershell',
      command: windowsPowerShell ?? 'powershell.exe',
      args: ['-NoLogo'],
      available: !!windowsPowerShell,
      source: windowsPowerShell ? 'Windows PowerShell 5.x' : undefined
    },
    {
      id: 'cmd',
      name: 'CMD',
      kind: 'cmd',
      command: cmd ?? 'cmd.exe',
      args: [],
      available: !!cmd,
      source: cmd ? 'Windows Command Prompt' : undefined
    },
    {
      id: 'git-bash',
      name: 'Git Bash',
      kind: 'git-bash',
      command: gitBash ?? 'bash.exe',
      args: ['--login', '-i'],
      available: !!gitBash,
      source: gitBash ? 'Git for Windows' : undefined
    }
  ]

  if (wsl) {
    for (const distro of distros) {
      profiles.push({
        id: `wsl:${distro}`,
        name: `WSL · ${distro}`,
        kind: 'wsl',
        command: wsl,
        args: ['--distribution', distro],
        available: true,
        source: 'Windows Subsystem for Linux'
      })
    }
  }

  return profiles
}
