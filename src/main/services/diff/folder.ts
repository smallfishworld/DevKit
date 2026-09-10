/**
 * 文件夹对比与同步：
 * - 递归并行扫描两侧；先比 size（不等即 differ），等长则流式 256KB 分块比较（不用哈希）
 * - 应用过滤：扩展名忽略 → ignored；ignoreCase 归一化扩展名配对
 * - 同步：单条目复制/删除；安全校验 rel 拒绝绝对路径 / '..' 段（防路径穿越）
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type {
  FolderEntry,
  FolderFilter,
  FolderScanReq,
  FolderScanRes,
  FolderStatus,
  FolderSyncReq,
  FolderSyncRes
} from '../../../shared/diff'

const CHUNK = 256 * 1024

interface Ent {
  isDir: boolean
  size: number
  mtimeMs: number
  path: string
}

/** 选中过滤忽略的扩展名集合（点后、小写） */
function ignoreSet(filter: FolderFilter): Set<string> {
  const set = new Set<string>()
  for (const e of filter.extIgnore ?? []) {
    const t = e.trim().replace(/^\./, '').toLowerCase()
    if (t) set.add(t)
  }
  return set
}

export async function scanFolder(req: FolderScanReq): Promise<FolderScanRes> {
  const res: FolderScanRes = {
    ok: false,
    leftRoot: req.left,
    rightRoot: req.right,
    entries: [],
    counts: { identical: 0, 'only-left': 0, 'only-right': 0, differ: 0, dir: 0, ignored: 0 }
  }
  try {
    const ignore = ignoreSet(req.filter)
    const [leftMap, rightMap] = await Promise.all([
      indexDir(req.left, ignore),
      indexDir(req.right, ignore)
    ])
    const rels = new Set<string>([...leftMap.keys(), ...rightMap.keys()])

    for (const rel of rels) {
      const l = leftMap.get(rel)
      const r = rightMap.get(rel)
      // 目录：两侧都有则 dir；仅一侧则 only-*（仅目录，无内容）
      if (l?.isDir || r?.isDir) {
        res.entries.push(mk(res, rel, true, dirStatus(l, r)))
        continue
      }
      const ign = l ? l.size === -1 : r ? r.size === -1 : false
      if (ign) {
        res.entries.push(mk(res, rel, false, 'ignored'))
        continue
      }
      // 文件
      if (l && r) {
        const status: FolderStatus = (await equalsFile(l, r)) ? 'identical' : 'differ'
        res.entries.push(mk(res, rel, false, status, l, r))
      } else if (l) {
        res.entries.push(mk(res, rel, false, 'only-left', l))
      } else {
        res.entries.push(mk(res, rel, false, 'only-right', undefined, r))
      }
    }

    res.entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.rel.localeCompare(b.rel)
    })
    res.ok = true
    return res
  } catch (err) {
    res.error = err instanceof Error ? err.message : String(err)
    return res
  }
}

function mk(
  res: FolderScanRes,
  rel: string,
  isDir: boolean,
  status: FolderStatus,
  l?: Ent,
  r?: Ent
): FolderEntry {
  const e: FolderEntry = { rel, isDir, status }
  if (l) e.left = { size: l.size, mtimeMs: l.mtimeMs }
  if (r) e.right = { size: r.size, mtimeMs: r.mtimeMs }
  res.counts[status] += 1
  return e
}

/** 两侧是否都为对应状态（含任一侧缺失但另一侧是目录） */
function dirStatus(l?: Ent, r?: Ent): FolderStatus {
  if (l && r) return 'dir'
  return l ? 'only-left' : 'only-right'
}

/** 递归索引目录 → { 相对路径: Ent }；被忽略文件 size 置 -1 标记 */
async function indexDir(root: string, ignore: Set<string>): Promise<Map<string, Ent>> {
  const map = new Map<string, Ent>()
  async function walk(dir: string, rel: string): Promise<void> {
    const items = await fs.readdir(dir)
    for (const name of items) {
      const full = path.join(dir, name)
      const childRel = rel ? `${rel}/${name}` : name
      let st: { isDirectory(): boolean; size: number; mtimeMs: number }
      try {
        st = await fs.stat(full)
      } catch {
        continue // 权限/竞态，跳过
      }
      if (st.isDirectory()) {
        map.set(childRel, { isDir: true, size: 0, mtimeMs: st.mtimeMs, path: full })
        await walk(full, childRel)
      } else if (isIgnored(name, ignore)) {
        map.set(childRel, { isDir: false, size: -1, mtimeMs: -1, path: full })
      } else {
        map.set(childRel, { isDir: false, size: st.size, mtimeMs: st.mtimeMs, path: full })
      }
    }
  }
  await walk(root, '')
  return map
}

function isIgnored(filename: string, ignore: Set<string>): boolean {
  const dot = filename.lastIndexOf('.')
  if (dot < 0) return false
  return ignore.has(filename.slice(dot + 1).toLowerCase())
}

/** 文件内容是否相等：先 size（不等直接 differ），等长流式分块比较 */
async function equalsFile(l: Ent, r: Ent): Promise<boolean> {
  if (l.size !== r.size) return false
  const lfd = await fs.open(l.path, 'r')
  const rfd = await fs.open(r.path, 'r')
  try {
    const lBuf = Buffer.alloc(CHUNK)
    const rBuf = Buffer.alloc(CHUNK)
    let rest = l.size
    while (rest > 0) {
      const want = Math.min(CHUNK, rest)
      const [lr, rr] = await Promise.all([
        lfd.read(lBuf, 0, want, l.size - rest),
        rfd.read(rBuf, 0, want, r.size - rest)
      ])
      if (lr.bytesRead !== want || rr.bytesRead !== want) return false
      if (!lBuf.subarray(0, want).equals(rBuf.subarray(0, want))) return false
      rest -= want
    }
    return true
  } finally {
    await lfd.close().catch(() => {})
    await rfd.close().catch(() => {})
  }
}

export async function syncFolderItem(req: FolderSyncReq): Promise<FolderSyncRes> {
  const res: FolderSyncRes = { ok: false, op: 'copy' }
  if (!safeRel(req.rel)) {
    res.error = '非法路径'
    return res
  }
  const toLeft = req.dir === 'right-to-left'
  try {
    if (req.op !== 'delete') {
      const src = path.join(toLeft ? req.right : req.left, req.rel)
      const dst = path.join(toLeft ? req.left : req.right, req.rel)
      await fs.mkdir(path.dirname(dst), { recursive: true })
      await fs.copyFile(src, dst)
      res.op = 'copy'
    } else {
      const dst = path.join(toLeft ? req.left : req.right, req.rel)
      await fs.rm(dst, { force: true })
      res.op = 'delete'
    }
    res.ok = true
    return res
  } catch (err) {
    res.error = err instanceof Error ? err.message : String(err)
    return res
  }
}

/** 拒绝绝对路径 / 反斜杠 / '..' 段，防路径穿越 */
function safeRel(rel: string): boolean {
  if (!rel) return false
  const norm = rel.replace(/\\/g, '/')
  if (path.isAbsolute(norm)) return false
  if (norm.startsWith('/')) return false
  const segs = norm.split('/')
  if (segs.some((s) => s === '..')) return false
  return true
}