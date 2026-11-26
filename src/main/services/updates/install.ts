import { createHash } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { copyFile, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { basename, dirname, join, resolve, win32 } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, dialog, shell } from 'electron'
import { leftoverNotice, parseLeftover, preflightRefusal } from '../../../shared/app-updates'
import { portableLauncher } from '../../../shared/windows-branding'
import { getMainWindow } from '../../ipc'
import { packageName, type PackageFormat, type UpdatePackage } from './github'
import { getAppLocale, mainText } from '../../app-locale'

const HELPER = 'DevKitUpdater.exe'

export class UpdatePreparationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UpdatePreparationError'
  }
}

export interface InstallTarget {
  format: PackageFormat
  executable: string
  helper: string
  cache: string
}

export function getInstallTarget(): InstallTarget | undefined {
  if (!app.isPackaged || process.platform !== 'win32' || process.arch !== 'x64') return undefined
  const helper = join(process.resourcesPath, HELPER)
  try {
    if (!statSync(helper).isFile()) return undefined
  } catch {
    return undefined
  }
  const portable = portableLauncher({
    isPackaged: app.isPackaged,
    portableExecutableFile: process.env.PORTABLE_EXECUTABLE_FILE,
    portableExecutableDir: process.env.PORTABLE_EXECUTABLE_DIR,
    isFile: (path) => statSync(path).isFile()
  })
  if (!portable && (process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR)) return undefined
  const executable = portable ?? process.execPath
  const key = createHash('sha256').update(resolve(executable).toLowerCase()).digest('hex').slice(0, 24)
  return {
    format: portable ? 'portable' : 'zip',
    executable,
    helper,
    cache: join(app.getPath('userData'), 'updates', key)
  }
}

export async function verifyUpdateFile(path: string, update: UpdatePackage): Promise<void> {
  const file = await stat(path)
  if (!file.isFile() || file.size !== update.bytes) throw new Error(mainText('updateCacheSizeMismatch'))
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  if (hash.digest('hex') !== update.hash) throw new Error(mainText('updateCacheVerifyFailed'))
}

export async function prepareUpdate(target: InstallTarget, path: string, update: UpdatePackage): Promise<void> {
  const handoff = await mkdtemp(join(target.cache, 'apply-'))
  const helper = join(handoff, HELPER)
  try {
    await copyFile(target.helper, helper)
    await copyFile(target.helper + '.config', helper + '.config')
    const child = spawn(helper, [
      target.format, target.executable, await realpath(path), update.hash, update.version,
      String(process.pid), String(target.format === 'portable' ? process.ppid : 0), handoff, app.getPath('userData')
    ], {
      cwd: handoff,
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    let processError: Error | undefined
    child.once('error', (error) => { processError = error })
    child.unref()

    const deadline = Date.now() + 120_000
    do {
      if (processError) throw processError
      const ready = await readFile(join(handoff, 'ready'), 'utf8').catch(() => undefined)
      if (ready === 'ok') {
        await writeFile(join(handoff, 'apply'), '', { flag: 'wx' })
        return
      }
      // The helper explains why it cannot replace the directory in place while DevKit is still running
      if (ready && ready !== 'ok') {
        const refusal = preflightRefusal(ready,
          (await readFile(join(handoff, 'directory-detail'), 'utf8').catch(() => '')).trim(), getAppLocale())
        if (refusal) throw new UpdatePreparationError(refusal)
      }
      if (ready === 'failed' || child.exitCode !== null) break
      await delay(125)
    } while (Date.now() < deadline)
    throw new UpdatePreparationError(getAppLocale() === 'en'
      ? 'Could not prepare an in-place update. Check write access and available space, or save the update package.'
      : mainText('updatePrepareInPlaceFailed'))
  } catch (error) {
    // An independent helper may still be preparing. Without the apply marker it leaves the target in place.
    await writeFile(join(handoff, 'cancel'), '', { flag: 'wx' }).catch(() => {})
    throw error
  }
}

/** The helper only commits the replacement after the new main window starts successfully. */
export async function confirmUpdatedLaunch(): Promise<void> {
  const path = process.env.DEVKIT_UPDATE_HANDOFF
  const expectedVersion = process.env.DEVKIT_UPDATE_VERSION
  delete process.env.DEVKIT_UPDATE_HANDOFF
  delete process.env.DEVKIT_UPDATE_VERSION
  if (!path || !/^apply-[a-z0-9]{6}$/i.test(basename(path))) return
  if (!/^[a-f\d]{24}$/.test(basename(dirname(path)))) return
  const [handoffRoot, profileRoot] = await Promise.all([
    realpath(dirname(dirname(path))).catch(() => undefined),
    realpath(join(app.getPath('userData'), 'updates')).catch(() => undefined)
  ])
  if (!handoffRoot || handoffRoot.toLowerCase() !== profileRoot?.toLowerCase()) return
  const version = app.getVersion()
  if (version !== expectedVersion) {
    if ((await stat(join(path, 'apply')).catch(() => undefined))?.isFile()) app.quit()
    return
  }
  try {
    await writeFile(join(path, 'started'), version, { flag: 'wx' })
    const cache = dirname(path)
    await Promise.all((['portable', 'zip'] as const).map((format) =>
      rm(join(cache, packageName(format)), { force: true })
    ))
    await rm(join(cache, 'pending.json'), { force: true })
  } catch {
    // A successful launch can leave stale cache files for the next ordinary startup to remove.
  }
}

/**
 * When user files cannot return to the installation, the helper keeps the old directory as a backup and
 * leaves a marker. Say once where the files are; the directory itself stays until the user deals with it.
 */
export async function reportLeftoverFiles(target: InstallTarget | undefined): Promise<void> {
  if (!target) return
  try {
    const marker = join(target.cache, 'apply-leftover')
    const leftover = parseLeftover(await readFile(marker, 'utf8').catch(() => ''))
    if (!leftover) return
    const backup = win32.resolve(leftover.directory)
    // Only a directory the helper could have created is offered: next to the installation and named its way
    const trusted = /^\.devkit-backup-[a-f0-9]{32}$/i.test(win32.basename(backup)) &&
      win32.dirname(backup).toLowerCase() === win32.dirname(win32.resolve(target.executable)).toLowerCase()
    const window = trusted ? getMainWindow() : null
    // The marker goes once the files were pointed out — or once it is clear that it never could.
    if (!trusted || (window && !window.isDestroyed())) await rm(marker, { force: true })
    if (!window || window.isDestroyed()) return
    const { response } = await dialog.showMessageBox(window, {
      type: 'warning', title: mainText('updateTitle'), noLink: true, cancelId: 1, ...leftoverNotice(leftover, getAppLocale())
    })
    if (response === 0) await shell.openPath(backup)
  } catch {
    // A notice must never stand in the way of using the application.
  }
}

export async function cleanUpdateHandoffs(cache: string, handoffs: string[]): Promise<void> {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  for (const handoff of handoffs) {
    if (!/^apply-[a-z0-9]{6}$/i.test(handoff)) continue
    const path = join(cache, handoff)
    const entry = await stat(path).catch(() => undefined)
    if (entry?.isDirectory() && entry.mtimeMs < cutoff) await rm(path, { force: true, recursive: true }).catch(() => {})
  }
}
