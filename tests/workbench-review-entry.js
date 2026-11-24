import assert from 'node:assert/strict'
import { encodeInteger, parseCalendarTime } from '../src/shared/converter-workbench'
import { DEFAULT_SERIAL_PARAMS, normalizeSerialParams } from '../src/shared/serial'
import { cycleTabId, launcherIndex, matchesTool, reorderTabIds, tabIdByDigit } from '../src/renderer/src/components/workbench-navigation'
import { dedupeRecent, sessionIdentity } from '../src/renderer/src/components/session-identity'
import {
  hostSharesQuickCmds,
  hostSlot,
  isTerminalTool,
  memberTabIds,
  parseSplitCmdsPrefs,
  parseSplitPct,
  planMerge,
  readSplitCmdsPrefs,
  readStoredSplitPct,
  reorderWorkTabIds,
  splitGridColumns,
  splitPctAtPointer,
  splitTabTitle,
  writeSplitCmdsPrefs,
  writeStoredSplitPct
} from '../src/renderer/src/components/split-tab'
import { createPinia, setActivePinia } from 'pinia'
import { useTabStore } from '../src/renderer/src/stores/tabs'

assert.deepEqual(encodeInteger(-100n, 4), { le: '9C FF FF FF', be: 'FF FF FF 9C', truncated: false })
assert.deepEqual(encodeInteger(-32768n, 2), { le: '00 80', be: '80 00', truncated: false })
assert.equal(encodeInteger(-32769n, 2).truncated, true)
assert.equal(encodeInteger(0x10000n, 2).truncated, true)
assert.equal(encodeInteger(0xFFFFFFFFFFFFFFFFn, 8).be, 'FF FF FF FF FF FF FF FF')

assert.equal(parseCalendarTime('2025-04-19T10:00:12', 345, 'utc'), Date.UTC(2025, 3, 19, 10, 0, 12, 345))
assert.equal(parseCalendarTime('2024-02-29T10:00', 5, 'local'), new Date(2024, 1, 29, 10, 0, 0, 5).getTime())
assert.equal(parseCalendarTime('2025-02-29T10:00', 0, 'utc'), null)
assert.equal(parseCalendarTime('2025-04-19T10:00', 1000, 'utc'), null)

const draft = { ...DEFAULT_SERIAL_PARAMS, path: 'COM3', baudRate: '9600' }
assert.equal(normalizeSerialParams(draft)?.baudRate, 9600)
assert.equal(draft.baudRate, '9600')
assert.equal(normalizeSerialParams({ ...draft, baudRate: 9600.25 }), undefined)
assert.equal(normalizeSerialParams({ ...draft, path: '' }), undefined)

assert.equal(launcherIndex(0, -1, 4), 3)
assert.equal(launcherIndex(3, 1, 4), 0)
assert.equal(launcherIndex(0, 1, 0), 0)
assert.equal(matchesTool('COM3 serial', 'COM3', 'serial'), true)
assert.equal(matchesTool('ssh', '大小端', 'endian'), false)

// 标签拖拽排序（含拖到队尾与 home 保护）
const sampleTabs = ['home', 'serial#1', 'ssh#2', 'net#3']
assert.deepEqual(reorderTabIds(sampleTabs, 'serial#1', 'net#3', 'after'), ['home', 'ssh#2', 'net#3', 'serial#1'])
assert.deepEqual(reorderTabIds(sampleTabs, 'net#3', 'serial#1', 'before'), ['home', 'net#3', 'serial#1', 'ssh#2'])
assert.deepEqual(reorderTabIds(sampleTabs, 'home', 'net#3', 'after'), sampleTabs)
assert.deepEqual(reorderTabIds(sampleTabs, 'net#3', 'home', 'before'), sampleTabs)

// 标签快捷键循环与数字直达
assert.equal(cycleTabId(sampleTabs, 'home', -1), 'net#3')
assert.equal(cycleTabId(sampleTabs, 'net#3', 1), 'home')
assert.equal(tabIdByDigit(sampleTabs, 1), 'home')
assert.equal(tabIdByDigit(sampleTabs, 2), 'serial#1')
assert.equal(tabIdByDigit(sampleTabs, 9), 'net#3')
assert.equal(tabIdByDigit(sampleTabs, 6), undefined)

// 最近会话身份去重：同串口/主机/目录视为同一会话，tab id 不同也不重复
const serialA = { id: 'serial#1', toolId: 'serial', title: 'COM1', serialParams: { ...DEFAULT_SERIAL_PARAMS, path: 'COM1' } }
const serialA2 = { id: 'serial#2', toolId: 'serial', title: 'COM1', serialParams: { ...DEFAULT_SERIAL_PARAMS, path: 'COM1' } }
const serialB = { id: 'serial#3', toolId: 'serial', title: 'COM3', serialParams: { ...DEFAULT_SERIAL_PARAMS, path: 'COM3' } }
const sshX = { id: 'ssh#4', toolId: 'ssh', title: 'root@10.0.0.1', sshParams: { host: '10.0.0.1', username: 'root', port: 22 } }
const shellY = { id: 'local-terminal#5', toolId: 'local-terminal', title: 'PowerShell', shell: { profileId: 'pwsh', cwd: 'D:\\code' } }

assert.equal(sessionIdentity(serialA), sessionIdentity(serialA2))           // 同串口同参数 → 同身份
assert.notEqual(sessionIdentity(serialA), sessionIdentity(serialB))         // 不同串口
assert.equal(sessionIdentity(sshX), 'ssh:root@10.0.0.1:22')
assert.equal(sessionIdentity(shellY), 'shell:local-terminal:D:\\code')

assert.equal(dedupeRecent([serialA2, serialA, serialB, sshX, shellY]).length, 4) // 旧版残留同身份 COM1 清洗
assert.equal(dedupeRecent([serialA, serialB, sshX, shellY]).length, 4)          // 无重复原样保留
assert.deepEqual(dedupeRecent([serialA, serialB, serialA]), [serialA, serialB]) // 保序、保首条

// ---------- 合并分屏标签纯逻辑（split-tab.ts） ----------
assert.equal(splitTabTitle([{ title: 'COM1' }, { title: 'COM2@115200' }]), 'COM1 | COM2@115200')
assert.deepEqual(
  memberTabIds({ id: 'split#1', kind: 'split', members: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] }),
  ['a', 'b']
)
assert.deepEqual(memberTabIds({ id: 'serial#1', title: 'COM1' }), ['serial#1'])

const workIds = ['home', 'serial#1', 'ssh#2', 'net#3']
// 合并位置计划：插入两者较小索引处，成员按原扁平序
assert.deepEqual(planMerge(workIds, 'serial#1', 'net#3'), { index: 1, firstId: 'serial#1', secondId: 'net#3' })
assert.deepEqual(planMerge(workIds, 'net#3', 'serial#1'), { index: 1, firstId: 'serial#1', secondId: 'net#3' })
assert.equal(planMerge(workIds, 'home', 'serial#1'), null)     // home 不可合并
assert.equal(planMerge(workIds, 'serial#1', 'serial#1'), null) // 自身
assert.equal(planMerge(workIds, 'serial#1', 'gone#9'), null)   // 目标不存在
// 分屏标签整体拖拽重排（复用 reorder 语义，home 保护）
assert.deepEqual(reorderWorkTabIds(['home', 'split#1', 'net#3'], 'split#1', 'net#3', 'after'), ['home', 'net#3', 'split#1'])
assert.deepEqual(reorderWorkTabIds(['home', 'split#1', 'net#3'], 'home', 'net#3', 'before'), ['home', 'split#1', 'net#3'])

// ---------- 分屏宽度：记忆值解析 / 网格列 / 指针换算 ----------
// 没有记忆值、非数值、越界都按「没记住」处理，交给默认均分
assert.equal(parseSplitPct(null), null)
assert.equal(parseSplitPct(''), null)
assert.equal(parseSplitPct('abc'), null)
assert.equal(parseSplitPct('Infinity'), null)
assert.equal(parseSplitPct('19.9'), null)
assert.equal(parseSplitPct('80'), 80)
assert.equal(parseSplitPct('29.7'), 29.7)
// 四列：共享快捷命令栏 | 左成员 | 分隔条 | 右成员。两成员按扣除分隔条后的宽度分配：
// 50% 即严格均分；越界截回 20–80
assert.equal(splitGridColumns(50), 'auto minmax(0, 50fr) 4px minmax(0, 50fr)')
assert.equal(splitGridColumns(29.7), 'auto minmax(0, 29.7fr) 4px minmax(0, 70.3fr)')
assert.equal(splitGridColumns(120), 'auto minmax(0, 80fr) 4px minmax(0, 20fr)')
// 分隔条中心线跟随指针：视图宽 1004、指针落在 303 → 左成员 301 宽，分隔条占 301–305
assert.equal(splitPctAtPointer(502, 1004), 50)
assert.equal(splitPctAtPointer(303, 1004), 30.1)
assert.equal(splitPctAtPointer(0, 1004), 20)
assert.equal(splitPctAtPointer(1004, 1004), 80)
assert.equal(splitPctAtPointer(10, 0), 50)
// 左侧有 210px 共享快捷命令栏时，比例只在余下的 1000px 里算
assert.equal(splitPctAtPointer(712, 1214, 210), 50)
assert.equal(splitPctAtPointer(513, 1214, 210), 30.1)
assert.equal(splitPctAtPointer(210, 1214, 210), 20)

const fakeStorage = (initial) => {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key)
  }
}
// v1 的值出自错位的分隔条：读取时清掉并回到均分
const legacy = fakeStorage({ 'devkit:split-width:v1': '29.7' })
assert.equal(readStoredSplitPct(() => legacy), 50)
assert.equal(legacy.getItem('devkit:split-width:v1'), null)
// v2 记忆值恢复；写不进/读不了都不抛错
const remembered = fakeStorage({ 'devkit:split-width:v2': '62.5' })
assert.equal(readStoredSplitPct(() => remembered), 62.5)
assert.equal(readStoredSplitPct(() => fakeStorage({ 'devkit:split-width:v2': 'abc' })), 50)
assert.equal(readStoredSplitPct(() => { throw new Error('denied') }), 50)
writeStoredSplitPct(33.3, () => remembered)
assert.equal(remembered.getItem('devkit:split-width:v2'), '33.3')

// 分屏共享快捷命令栏的宽度与折叠：缺失、类型不对或整段坏掉都按没记住处理
assert.deepEqual(parseSplitCmdsPrefs(null), {})
assert.deepEqual(parseSplitCmdsPrefs('not json'), {})
assert.deepEqual(parseSplitCmdsPrefs('{"width":"wide","hidden":"yes"}'), {})
assert.deepEqual(parseSplitCmdsPrefs('{"width":260,"hidden":true}'), { width: 260, hidden: true })
const cmdsStore = fakeStorage({})
writeSplitCmdsPrefs({ width: 260, hidden: true }, () => cmdsStore)
assert.deepEqual(readSplitCmdsPrefs(() => cmdsStore), { width: 260, hidden: true })
assert.deepEqual(readSplitCmdsPrefs(() => { throw new Error('denied') }), {})

// 两个成员都是终端的分屏共用一条快捷命令栏；混入别的工具、或根本不是分屏，则各用各的
assert.equal(isTerminalTool('serial') && isTerminalTool('ssh') && isTerminalTool('local-terminal'), true)
assert.equal(isTerminalTool('calc'), false)
assert.equal(isTerminalTool(undefined), false)
const twoTerminals = {
  id: 'split#3',
  kind: 'split',
  members: [{ id: 'serial#1', toolId: 'serial' }, { id: 'ssh#2', toolId: 'ssh' }]
}
assert.equal(hostSharesQuickCmds(twoTerminals), true)
assert.equal(
  hostSharesQuickCmds({ ...twoTerminals, members: [{ id: 'serial#1', toolId: 'serial' }, { id: 'calc#2', toolId: 'calc' }] }),
  false
)
assert.equal(hostSharesQuickCmds({ id: 'serial#1', toolId: 'serial' }), false)
assert.equal(hostSharesQuickCmds(undefined), false)

// ---------- 内容区落位：未激活 hidden，分屏成员 left/right，普通条目 full ----------
const merged = [
  { id: 'home' },
  { id: 'split#3', kind: 'split', members: [{ id: 'serial#1' }, { id: 'ssh#2' }] },
  { id: 'net#4' }
]
assert.equal(hostSlot(merged, 'split#3', 'serial#1'), 'left')
assert.equal(hostSlot(merged, 'split#3', 'ssh#2'), 'right')
assert.equal(hostSlot(merged, 'home', 'home'), 'full')
assert.equal(hostSlot(merged, 'net#4', 'net#4'), 'full')
assert.equal(hostSlot(merged, 'split#3', 'home'), 'hidden')
assert.equal(hostSlot(merged, 'home', 'serial#1'), 'hidden')
assert.equal(hostSlot(merged, 'net#4', 'ssh#2'), 'hidden')
assert.equal(hostSlot(merged, 'net#4', 'gone#9'), 'hidden')

// ---------- tabs store：合并/拆分不增删面板，单例工具在分屏里也只此一份 ----------
setActivePinia(createPinia())
const store = useTabStore()
const def = (id, singleton = false) => ({ id, name: id, singleton, component: {}, phase: '', ready: true })
const hostIds = () => store.panelHosts.map((t) => t.id)
const idsUnique = () => new Set(hostIds()).size === hostIds().length

store.openTool(def('serial')) // serial#1
store.openTool(def('serial')) // serial#2
store.openTool(def('ssh'))    // ssh#3
assert.deepEqual(hostIds(), ['home', 'serial#1', 'serial#2', 'ssh#3'])

// 合并非相邻的两个标签：面板集合不变（两个成员挪到一起），内容区按 id 复用
assert.equal(store.mergeIntoSplit('serial#1', { tabId: 'ssh#3' }), true)
assert.deepEqual(hostIds(), ['home', 'serial#1', 'ssh#3', 'serial#2'])
assert.ok(store.activeId.startsWith('split#'))
assert.equal(store.sessionVisible('ssh#3'), true) // 分屏成员算在显示
assert.equal(store.sessionVisible('serial#2'), false)
assert.deepEqual(store.flatSessions.map((t) => t.id), hostIds().slice(1))
assert.equal(store.unsplit(store.activeId), true)
assert.deepEqual(hostIds(), ['home', 'serial#1', 'ssh#3', 'serial#2'])
assert.equal(store.activeId, 'serial#1')

// 单例工具正待在分屏里：再打开不再开第二份，而是激活它所在的分屏
store.openTool(def('extensions', true))
const extId = store.activeId
assert.equal(store.mergeIntoSplit('serial#2', { tabId: extId }), true)
store.openTool(def('extensions', true))
assert.equal(store.flatSessions.filter((t) => t.toolId === 'extensions').length, 1)
assert.equal(store.sessionVisible(extId), true)

// 分屏模式下再选到它（工具条目）：从原分屏摘出挪进新分屏，原分屏剩下的成员原地还原
assert.equal(store.mergeIntoSplit('ssh#3', { tool: def('extensions', true) }), true)
assert.deepEqual(hostIds(), ['home', 'serial#1', 'ssh#3', extId, 'serial#2'])
// 选中别的分屏里的会话同理，同一面板不会挂在两个分屏下
assert.equal(store.mergeIntoSplit('serial#1', { tabId: 'ssh#3' }), true)
assert.ok(idsUnique())
assert.equal(store.flatSessions.filter((t) => t.id === 'ssh#3').length, 1)
const splitId = store.activeId
assert.equal(store.sessionVisible('ssh#3'), true)
// 串口 + SSH 的分屏：两个终端共用一条快捷命令栏；独立标签照常用自带的
assert.equal(store.sharesQuickCmds('ssh#3'), true)
assert.equal(store.sharesQuickCmds('serial#2'), false)

// home、分屏条目自身、目标为分屏条目、单例并入自己：一律拒绝
assert.equal(store.mergeIntoSplit('home', { tabId: 'serial#2' }), false)
assert.equal(store.mergeIntoSplit(splitId, { tabId: 'serial#2' }), false)
assert.equal(store.mergeIntoSplit(extId, { tabId: splitId }), false)
assert.equal(store.mergeIntoSplit(extId, { tool: def('extensions', true) }), false)

// 关闭分屏的一侧：留下的一侧原地成为独立标签并接着显示，只释放被关掉的那个
const disposed = []
globalThis.window = {
  api: {
    invoke: (tool, action, panelId) => {
      if (action === 'dispose') disposed.push(panelId)
      return Promise.resolve()
    }
  }
}
assert.equal(store.closeSplitSide(splitId, 1), true)
// 此前顺序是 [home, split, extensions, serial#2]：留下的成员原地顶替分屏，其余条目不动
assert.deepEqual(store.tabs.map((t) => t.id), ['home', 'serial#1', extId, 'serial#2'])
assert.deepEqual(hostIds(), ['home', 'serial#1', extId, 'serial#2'])
assert.equal(store.activeId, 'serial#1')
assert.deepEqual(disposed, ['ssh#3'])
// 分屏不在前台时关掉一侧：留下的成员成为独立标签，但不抢当前显示
assert.equal(store.mergeIntoSplit('serial#1', { tabId: 'serial#2' }), true)
store.activate(extId)
assert.equal(store.closeSplitSide(store.tabs.find((t) => t.kind === 'split').id, 0), true)
assert.deepEqual(store.tabs.map((t) => t.id), ['home', 'serial#2', extId])
assert.equal(store.activeId, extId)
assert.deepEqual(disposed, ['ssh#3', 'serial#1'])
// 不是分屏、或条目不存在：拒绝
assert.equal(store.closeSplitSide('serial#2', 0), false)
assert.equal(store.closeSplitSide('gone#9', 1), false)
// 整个分屏关闭：全部成员都释放（与单侧关闭走同一个释放入口）
assert.equal(store.mergeIntoSplit('serial#2', { tabId: extId }), true)
store.close(store.activeId)
assert.deepEqual(disposed.slice(2).sort(), [extId, 'serial#2'].sort())
assert.deepEqual(store.tabs.map((t) => t.id), ['home'])
assert.equal(store.activeId, 'home')
delete globalThis.window

console.log('PASS 串口草稿验证、工具启动器导航、标签排序/快捷键、负数补码与时区毫秒反查、最近会话身份去重、合并分屏标签、分屏比例记忆与内容区落位、合并/拆分保面板与单例复用、关闭分屏单侧、终端分屏共享快捷命令栏')
