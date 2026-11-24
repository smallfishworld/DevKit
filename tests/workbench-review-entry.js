import assert from 'node:assert/strict'
import { encodeInteger, parseCalendarTime } from '../src/shared/converter-workbench'
import { DEFAULT_SERIAL_PARAMS, normalizeSerialParams } from '../src/shared/serial'
import { cycleTabId, launcherIndex, matchesTool, reorderTabIds, tabIdByDigit } from '../src/renderer/src/components/workbench-navigation'
import { dedupeRecent, sessionIdentity } from '../src/renderer/src/components/session-identity'
import { memberTabIds, planMerge, reorderWorkTabIds, splitTabTitle } from '../src/renderer/src/components/split-tab'

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

console.log('PASS 串口草稿验证、工具启动器导航、标签排序/快捷键、负数补码与时区毫秒反查、最近会话身份去重、合并分屏标签')
