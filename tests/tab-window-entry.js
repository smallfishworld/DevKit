import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'
import { insideTabStrip, tabDragDestination, tabDragStarted, tabInsertion } from '../src/renderer/src/components/tab-drag'
import { useTabStore } from '../src/renderer/src/stores/tabs'

const strip = { left: 90, right: 500, top: 5, bottom: 42 }
assert.equal(tabDragStarted({ x: 100, y: 20 }, { x: 102, y: 23 }), false)
assert.equal(tabDragStarted({ x: 100, y: 20 }, { x: 106, y: 20 }), true)
assert.equal(tabDragDestination({ x: 200, y: 60 }, strip), 'reorder')
assert.equal(tabDragDestination({ x: 200, y: 67 }, strip), 'detach')
assert.equal(tabDragDestination({ x: 65, y: 20 }, strip), 'detach')
assert.equal(tabDragDestination({ x: 525, y: 20 }, strip), 'detach')
assert.equal(insideTabStrip({ x: 200, y: 45 }, strip), false)

const positions = [
  { id: 'home', left: 90, right: 160 },
  { id: 'first', left: 160, right: 245 },
  { id: 'split', left: 245, right: 340 }
]
assert.deepEqual(tabInsertion(positions, 115), { id: 'first', side: 'before' })
assert.deepEqual(tabInsertion(positions, 225), { id: 'split', side: 'before' })
assert.deepEqual(tabInsertion(positions, 420), { id: 'split', side: 'after' })
assert.equal(tabInsertion(positions.slice(0, 1), 170), undefined)

setActivePinia(createPinia())
const tabs = useTabStore()
const calls = []
globalThis.window = {
  api: { invoke: (...args) => { calls.push(args); return Promise.resolve() } }
}
const tool = { id: 'serial', name: '串口助手' }
const open = () => { tabs.openTool(tool); return tabs.activeId }
const first = open()
const second = open()
const third = open()

assert.equal(tabs.markDetached('home'), false)
assert.equal(tabs.markDetached('unknown'), false)
assert.equal(tabs.markDetached(second), true)
assert.equal(tabs.markDetached(second), false)
assert.equal(tabs.markDetached(third), true)
assert.equal(tabs.activeId, first)
assert.equal(tabs.sessionVisible(second), true)
assert.equal(tabs.sessionVisible(third), true)
assert.deepEqual(tabs.workbenchTabs.map(tab => tab.id), ['home', first])
assert.equal(calls.length, 0)

tabs.activate(second)
assert.equal(tabs.activeId, first)
tabs.closeAll()
assert.deepEqual(calls, [[tool.id, 'dispose', first]])
assert.deepEqual(tabs.flatSessions.map(tab => tab.id), [second, third])

tabs.markAttached(second)
tabs.activate(second)
assert.equal(tabs.activeId, second)
const fourth = open()
assert.equal(tabs.mergeIntoSplit(fourth, { tabId: second }), true)
const split = tabs.activeId
tabs.resizeSplit(split, 66)
assert.equal(tabs.markDetached(split), true)
assert.equal(tabs.activeId, 'home')
assert.equal(tabs.hostId(second), split)
assert.equal(tabs.hostId(fourth), split)
assert.equal(tabs.sessionVisible(second), true)
assert.equal(tabs.sessionVisible(fourth), true)
assert.equal(tabs.unsplit(split), false)
tabs.resizeSplit(split, 37)
tabs.markAttached(split)
tabs.activate(split)
assert.equal(tabs.active.splitPct, 37)
assert.equal(tabs.markDetached(split), true)
tabs.close(split)
assert.deepEqual(calls.slice(1), [[tool.id, 'dispose', second], [tool.id, 'dispose', fourth]])
assert.deepEqual(tabs.detachedIds, [third])
console.log('tab-window: OK')
