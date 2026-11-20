import { win32 } from 'node:path'

export const APP_USER_MODEL_ID = 'com.embedded.devkit'
export const APP_DISPLAY_NAME = 'DevKit'

export interface WindowsAppDetails {
  appId: string
  appIconPath: string
  appIconIndex: number
  relaunchCommand: string
  relaunchDisplayName: string
}

export interface WindowsAppDetailsInput {
  isPackaged: boolean
  execPath: string
  appPath: string
  iconPath: string
  portableExecutableFile?: string
  portableExecutableDir?: string
  /** The caller checks the real filesystem; the pure resolver does not trust an environment path. */
  isFile?: (path: string) => boolean
}

/** Quote one Windows command-line argument without involving cmd.exe. */
export function quoteWindowsArgument(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error('Windows launch arguments cannot contain control characters')
  // Backslashes before a quote (including the closing quote) must be doubled.
  const escaped = value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')
  return `"${escaped}"`
}

function isFullyQualifiedWindowsPath(value: string): boolean {
  // win32.isAbsolute("\\file") is true, but that path still depends on the current drive.
  return !/[\0\r\n"]/.test(value) && win32.isAbsolute(value) && win32.parse(value).root.length > 1
}

export function portableLauncher(input: Pick<WindowsAppDetailsInput,
  'isPackaged' | 'portableExecutableFile' | 'portableExecutableDir' | 'isFile'>): string | undefined {
  const file = input.portableExecutableFile
  const directory = input.portableExecutableDir
  if (!input.isPackaged || !file || !directory || !input.isFile) return undefined
  if (!isFullyQualifiedWindowsPath(file) || !isFullyQualifiedWindowsPath(directory)) return undefined
  if (win32.extname(file).toLowerCase() !== '.exe') return undefined
  if (win32.resolve(win32.dirname(file)).toLowerCase() !== win32.resolve(directory).toLowerCase()) return undefined
  try {
    return input.isFile(file) ? file : undefined
  } catch {
    return undefined
  }
}

/** Resolve the stable Shell icon/relaunch target separately from BrowserWindow's image. */
export function buildWindowsAppDetails(input: WindowsAppDetailsInput): WindowsAppDetails {
  const executable = portableLauncher(input) ?? input.execPath
  const args = input.isPackaged ? [executable] : [executable, input.appPath]
  return {
    appId: APP_USER_MODEL_ID,
    // Shell cannot read an ASAR path. Packaged EXEs already embed the same DK ICO.
    appIconPath: input.isPackaged ? executable : input.iconPath,
    appIconIndex: 0,
    relaunchCommand: args.map(quoteWindowsArgument).join(' '),
    relaunchDisplayName: APP_DISPLAY_NAME
  }
}
