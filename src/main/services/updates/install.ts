import { createHash } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { copyFile, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app } from 'electron'
import { portableLauncher } from '../../../shared/windows-branding'
import { packageName, type PackageFormat, type UpdatePackage } from './github'

const HELPER = 'DevKitUpdater.exe'

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
  if (!file.isFile() || file.size !== update.bytes) throw new Error('缓存的更新包大小不符，请重新下载。')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  if (hash.digest('hex') !== update.hash) throw new Error('缓存的更新包校验失败，请重新下载。')
}

export async function prepareUpdate(target: InstallTarget, path: string, update: UpdatePackage): Promise<void> {
  const handoff = await mkdtemp(join(target.cache, 'apply-'))
  const helper = join(handoff, HELPER)
  try {
    await copyFile(target.helper, helper)
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
      if (ready === 'directory') throw new Error('解压目录包含其他文件或已被修改。请将更新包另存并解压到新目录。')
      if (ready === 'failed' || child.exitCode !== null) break
      await delay(125)
    } while (Date.now() < deadline)
    throw new Error('无法准备原路径更新。请检查目录写入权限和可用空间，或另存更新包。')
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
  const cache = join(app.getPath('userData'), 'updates')
  if (dirname(dirname(path)).toLowerCase() !== cache.toLowerCase() ||
      !/^[a-f\d]{24}$/.test(basename(dirname(path)))) return
  const version = app.getVersion()
  if (version !== expectedVersion) {
    if ((await stat(join(path, 'apply')).catch(() => undefined))?.isFile()) app.quit()
    return
  }
  try {
    await writeFile(join(path, 'started'), version, { flag: 'wx' })
    const cache = dirname(path)
    await Promise.all((['portable', 'zip'] as const).map((format) =>
      rm(join(cache, packageName(version, format)), { force: true })
    ))
    await rm(join(cache, 'pending.json'), { force: true })
  } catch {
    // A successful launch can leave stale cache files for the next ordinary startup to remove.
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
