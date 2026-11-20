import assert from 'node:assert/strict'
import { encodeInteger, parseCalendarTime } from '../src/shared/converter-workbench'
import { DEFAULT_SERIAL_PARAMS, normalizeSerialParams } from '../src/shared/serial'
import { launcherIndex, matchesTool } from '../src/renderer/src/components/workbench-navigation'

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
console.log('PASS 串口草稿验证、工具启动器导航、负数补码与时区毫秒反查')
