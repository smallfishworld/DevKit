import { app, type BrowserWindow } from 'electron'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { APP_USER_MODEL_ID, buildWindowsAppDetails } from '../shared/windows-branding'

export { APP_USER_MODEL_ID, buildWindowsAppDetails, quoteWindowsArgument } from '../shared/windows-branding'

/** These assets are explicitly included in build.files, relative to the app root in dev and ASAR. */
export function getWindowIconPath(platform: NodeJS.Platform = process.platform): string {
  return join(app.getAppPath(), 'resources', 'branding', platform === 'win32' ? 'devkit.ico' : 'app-256.png')
}

/** Apply before showing each taskbar-visible window, including plugin authentication windows. */
export function applyWindowsAppDetails(window: Pick<BrowserWindow, 'setAppDetails'>): void {
  if (process.platform !== 'win32') return
  const details = buildWindowsAppDetails({
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    appPath: app.getAppPath(),
    iconPath: getWindowIconPath('win32'),
    portableExecutableFile: process.env.PORTABLE_EXECUTABLE_FILE,
    portableExecutableDir: process.env.PORTABLE_EXECUTABLE_DIR,
    isFile: (path) => statSync(path).isFile()
  })
  window.setAppDetails(details)
  // Chromium writes AppID first. Reapply it after the relaunch properties so Windows refreshes them.
  window.setAppDetails({ appId: APP_USER_MODEL_ID })
}
