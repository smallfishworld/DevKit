import { app, dialog, net, shell } from 'electron'
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { APP_UPDATES, APP_UPDATES_PANEL, type UpdateState } from '../../../shared/app-updates'
import { emitToolEvent, getMainWindow, type ToolService } from '../../ipc'
import { GitHubReleases, RELEASE_HOME, packageName, readPendingUpdate, type UpdatePackage } from './github'
import { cleanUpdateHandoffs, getInstallTarget, prepareUpdate, verifyUpdateFile, type InstallTarget } from './install'

const CHECK_INTERVAL = 6 * 60 * 60 * 1000

export class AppUpdateService implements ToolService {
  private state: UpdateState
  private readonly current = app.getVersion()
  private readonly initialized: Promise<void>
  private candidate?: UpdatePackage
  private timer?: NodeJS.Timeout
  private busy = false

  constructor(
    private readonly target: InstallTarget | undefined = getInstallTarget(),
    private readonly feed = new GitHubReleases((url, init) => net.fetch(url, init))
  ) {
    this.state = { phase: 'idle' }
    this.initialized = this.restore()
  }

  invoke(panelId: string, action: string): Promise<unknown> | unknown {
    if (panelId !== APP_UPDATES_PANEL) throw new Error('无效的应用更新入口')
    switch (action) {
      case 'state': return this.initialized.then(() => this.state)
      case 'check': return this.check()
      case 'download': return this.download()
      case 'restart': return this.restart()
      case 'save': return this.save()
      case 'release': return shell.openExternal(this.candidate ? `${RELEASE_HOME}/tag/${this.candidate.tag}` : RELEASE_HOME)
      default: throw new Error('未知的应用更新操作')
    }
  }

  start(): void {
    if (this.target) this.schedule(8000)
  }

  dispose(): void {
    clearTimeout(this.timer)
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      void this.check().finally(() => this.schedule(CHECK_INTERVAL))
    }, delay)
    this.timer.unref()
  }

  private setState(state: UpdateState): void {
    this.state = state
    emitToolEvent(APP_UPDATES, APP_UPDATES_PANEL, 'state', state)
  }

  private async restore(): Promise<void> {
    if (!this.target) return
    const { cache, format } = this.target
    const startedAfterUpdate = Boolean(process.env.DEVKIT_UPDATE_HANDOFF)
    try {
      const directory = await readdir(cache)
      void cleanUpdateHandoffs(cache, directory)
      const meta = await readFile(join(cache, 'pending.json'), 'utf8').catch(() => '')
      const data: unknown = meta ? JSON.parse(meta) : undefined
      const update = readPendingUpdate(data, this.current)
      if (update && (await stat(this.path(update)).catch(() => undefined))?.size === update.bytes) {
        this.candidate = update
        const failed = await readFile(join(cache, 'apply-error'), 'utf8').catch(() => '')
        this.setState({
          phase: 'ready', release: update,
          message: failed ? '上次更新未完成。可重试或另存更新包。' : undefined
        })
        return
      }
      // Keep the download available if the replacement exits before startup and rolls back.
      if (startedAfterUpdate) return
      await rm(join(cache, 'pending.json'), { force: true })
      await rm(join(cache, 'apply-error'), { force: true })
      const suffix = format === 'portable' ? '-portable.exe' : '-win-x64.zip'
      for (const name of directory) {
        if (name.startsWith('DevKit-') && (name.endsWith(suffix) || name.endsWith(suffix + '.part'))) {
          await rm(join(cache, name), { force: true })
        }
      }
    } catch {
      // Inaccessible, missing or damaged cache must not prevent checking for a fresh update.
    }
  }

  private async check(): Promise<UpdateState> {
    await this.initialized
    if (this.busy || this.state.phase === 'ready' || this.state.phase === 'preparing') return this.state
    this.busy = true
    this.setState({ phase: 'checking' })
    try {
      const result = await this.feed.latest(this.current, this.target?.format)
      this.candidate = result.status === 'available' ? result.update : undefined
      this.setState(result.status === 'available'
        ? { phase: 'available', release: result.update, installable: Boolean(this.target) }
        : { phase: result.status })
    } catch (error) {
      const message = error instanceof Error && error.message.startsWith('GitHub') ? error.message : '无法连接 GitHub，请稍后重试。'
      this.setState({ phase: 'check-failed', message })
    } finally {
      this.busy = false
    }
    return this.state
  }

  private path(update: UpdatePackage): string {
    const target = this.target!
    return join(target.cache, packageName(update.version, target.format))
  }

  private async download(): Promise<UpdateState> {
    await this.initialized
    if (!this.target || this.busy || this.state.phase !== 'available' || !this.candidate) return this.state
    const { cache, format } = this.target
    const update = this.candidate
    const path = this.path(update)
    const partial = path + '.part'
    this.busy = true
    this.setState({ phase: 'downloading', release: update, received: 0 })
    try {
      await mkdir(cache, { recursive: true })
      await rm(partial, { force: true })
      await this.feed.download(update, format, partial, (received) => {
        this.setState({ phase: 'downloading', release: update, received })
      })
      await rename(partial, path)
      await rm(join(cache, 'apply-error'), { force: true })
      const metadata = join(cache, 'pending.json')
      await writeFile(metadata + '.part', JSON.stringify(update))
      await rename(metadata + '.part', metadata)
      this.setState({ phase: 'ready', release: update })
    } catch (error) {
      await rm(partial, { force: true }).catch(() => {})
      const message = error instanceof Error && error.message.startsWith('更新包')
        ? error.message : '下载失败，请检查网络和磁盘空间后重试。'
      this.setState({ phase: 'available', release: update, message })
    } finally {
      this.busy = false
    }
    return this.state
  }

  private async verified(update: UpdatePackage): Promise<boolean> {
    try {
      await verifyUpdateFile(this.path(update), update)
      return true
    } catch {
      await rm(join(this.target!.cache, 'pending.json'), { force: true }).catch(() => {})
      this.setState({ phase: 'available', release: update, message: '缓存更新包校验失败，请重新下载。' })
      return false
    }
  }

  private async restart(): Promise<UpdateState> {
    await this.initialized
    if (!this.target || this.busy || this.state.phase !== 'ready' || !this.candidate) return this.state
    const update = this.candidate
    this.busy = true
    this.setState({ phase: 'preparing', release: update })
    try {
      if (await this.verified(update)) {
        await rm(join(this.target.cache, 'apply-error'), { force: true })
        await prepareUpdate(this.target, this.path(update), update)
        setImmediate(() => app.quit())
      }
    } catch (error) {
      this.setState({ phase: 'ready', release: update,
        message: error instanceof Error && /^(解压目录|无法准备)/.test(error.message)
          ? error.message : '无法启动更新助手。可重试或另存更新包。'
      })
    } finally {
      this.busy = false
    }
    return this.state
  }

  private async save(): Promise<UpdateState> {
    await this.initialized
    const window = getMainWindow()
    if (!window || !this.target || this.busy || this.state.phase !== 'ready' || !this.candidate) return this.state
    const update = this.candidate
    this.busy = true
    try {
      if (!await this.verified(update)) return this.state
      const file = packageName(update.version, this.target.format)
      const { filePath, canceled } = await dialog.showSaveDialog(window, {
        title: '另存更新包', defaultPath: join(app.getPath('downloads'), file)
      })
      if (filePath && !canceled) {
        await copyFile(this.path(update), filePath)
        this.setState({ phase: 'ready', release: update, message: '已保存更新包。' })
      }
    } catch {
      this.setState({ phase: 'ready', release: update, message: '无法保存更新包，请选择其他路径。' })
    } finally {
      this.busy = false
    }
    return this.state
  }
}
