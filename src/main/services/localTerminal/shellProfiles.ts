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

export function detectWindowsShellProfiles(
  env: Env = process.env,
  exists: ExistsFn = existsSync
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
  const powerShellCommand = pwsh ?? windowsPowerShell

  const gitExe = findOnWindowsPath('git.exe', env, exists)
  const gitBash = firstExisting(gitBashCandidates(env, gitExe), exists)

  return [
    {
      id: 'powershell',
      name: 'PowerShell',
      kind: 'powershell',
      command: powerShellCommand ?? 'pwsh.exe',
      args: ['-NoLogo'],
      available: !!powerShellCommand,
      source: pwsh ? 'PowerShell 7' : windowsPowerShell ? 'Windows PowerShell' : undefined
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
}
