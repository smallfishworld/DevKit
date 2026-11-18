import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_LOG_RETENTION, retentionCutoff, validLogRetention } from '../../../shared/log-retention'

import type { LogRetentionSettings } from '../../../shared/log-retention'

export class LogRetentionStore {
  private writes: Promise<unknown> = Promise.resolve()

  constructor(private readonly root: string) {}

  private get path(): string { return join(this.root, 'serial-log-retention.json') }

  async read(): Promise<LogRetentionSettings> {
    try {
      const value: unknown = JSON.parse(await fs.readFile(this.path, 'utf8'))
      if (!validLogRetention(value)) throw new Error('日志清理设置无效，已跳过清理')
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_LOG_RETENTION }
      throw error
    }
  }

  save(settings: LogRetentionSettings): Promise<void> {
    const write = this.writes.then(async () => {
      await fs.mkdir(this.root, { recursive: true })
      const staging = this.path + '.' + randomUUID()
      try {
        await fs.writeFile(staging, JSON.stringify(settings), { flag: 'wx' })
        await fs.rename(staging, this.path)
      } finally { await fs.unlink(staging).catch(() => {}) }
    })
    this.writes = write.catch(() => {})
    return write
  }
}

// Windows serial capture archives have a different name from manual exports and SSH logs.
const SERIAL_ARCHIVE = /^COM[0-9]+-[0-9]{8}-[0-9]{6}-[a-f0-9]{8}\.log$/i

export async function cleanSerialArchives(
  directories: readonly string[],
  months: number,
  protectedPaths: () => ReadonlySet<string>,
  now = new Date()
): Promise<{ removed: number; failed: number }> {
  const cutoff = retentionCutoff(now, months)
  let removed = 0
  let failed = 0
  const visited = new Set<string>()
  const key = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
  const isProtected = async (path: string): Promise<boolean> => {
    for (const pinned of protectedPaths()) {
      if (key(pinned) === key(path)) return true
      if (key(await fs.realpath(pinned).catch(() => pinned)) === key(path)) return true
    }
    return false
  }
  for (const directory of directories) {
    try {
      const realDirectory = await fs.realpath(directory)
      const realKey = key(realDirectory)
      if (visited.has(realKey)) continue
      visited.add(realKey)
      for await (const entry of await fs.opendir(realDirectory)) {
        if (!entry.isFile() || !SERIAL_ARCHIVE.test(entry.name)) continue
        const path = join(realDirectory, entry.name)
        try {
          const stat = await fs.lstat(path)
          if (!stat.isFile() || stat.nlink !== 1 || stat.mtimeMs >= cutoff || await isProtected(path)) continue
          const current = await fs.lstat(path)
          if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino ||
            current.mtimeMs !== stat.mtimeMs || current.nlink !== 1) continue
          await fs.unlink(path)
          removed++
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failed++
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failed++
    }
  }
  return { removed, failed }
}
