const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { LogFormatter, OutputWindow, DisplayBacklog, SERIAL_BACKGROUND_CACHE_CHARS, SERIAL_LIVE_TAIL_CHARS, PanelTasks, ByteCounterThrottle } = require('../src/shared/terminal-stream')
const { SessionHistory, readHistoryPage, readHistoryTail } = require('../src/main/services/terminal/history')
const { TerminalRuntime } = require('../src/main/services/terminal/runtime')
const { setMainWindow } = require('../src/main/ipc')

let count = 0
async function test(name, run) { await run(); count++; console.log(`  PASS ${name}`) }
const tick = () => new Promise((resolve) => setImmediate(resolve))

async function main() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'devkit-terminal-test-'))
  globalThis.terminalTestDir = dir
  try {
    await test('hidden display backlog keeps bounded Unicode text in original order', async () => {
      const backlog = new DisplayBacklog(8)
      backlog.push('start')
      backlog.push('中文😀A')
      const data = backlog.take()
      assert.equal(data.dropped, 2)
      assert.equal(data.chunks.join(''), 'art中文😀A')
      assert.deepEqual(backlog.take(), { chunks: [], dropped: 0 })
      const pair = new DisplayBacklog(3)
      pair.push('x😀y')
      assert.equal(pair.take().chunks.join(''), '😀y')
    })
    await test('invisible serial view records everything and resumes output exactly once', async () => {
      const events = []
      setMainWindow({ isDestroyed: () => false, webContents: { send: (_ch, evt) => events.push(evt) } })
      const runtime = new TerminalRuntime('serial')
      runtime.setVisible('h', false)
      await runtime.start('h', { dir, name: 'HIDDEN', temporary: true, pause: () => {}, fatal: () => assert.fail() })
      runtime.data('h', 'before ')
      runtime.data('h', 'after\r\n')
      assert.equal(events.filter(e => e.type === 'data').length, 0)
      const page = await runtime.invoke('h', 'history:query', {})
      assert.ok(page.rows.some(r => r.text.includes('before after')))
      runtime.setVisible('h', true)
      assert.equal(events.filter(e => e.type === 'data').map(e => e.payload.text).join(''), '\x1b[0mbefore after\r\n')
      const count = events.filter(e => e.type === 'data').length
      runtime.setVisible('h', true)
      assert.equal(events.filter(e => e.type === 'data').length, count)
      await runtime.dispose('h'); runtime.forgetVisible('h')
    })
    await test('default background cache retains 16 Mi UTF-16 code units, not 512 Ki', async () => {
      assert.equal(SERIAL_BACKGROUND_CACHE_CHARS, 16 * 1024 * 1024)
      const backlog = new DisplayBacklog()
      backlog.push('x'.repeat(2 * 1024 * 1024))
      assert.equal(backlog.pending, 2 * 1024 * 1024)
      assert.equal(backlog.droppedChars, 0)
      // Exercise the actual maximum, including a split surrogate pair at eviction.
      backlog.push('中'.repeat(14 * 1024 * 1024))
      assert.equal(backlog.pending, SERIAL_BACKGROUND_CACHE_CHARS)
      backlog.push('😀END')
      assert.ok(backlog.pending <= SERIAL_BACKGROUND_CACHE_CHARS)
      assert.ok(backlog.droppedChars >= 5)
      let last = ''
      while (backlog.pending) last = backlog.read(16 * 1024)
      assert.ok(last.endsWith('😀END'))
      assert.equal(backlog.pending, 0)
    })
    await test('live tail prefers complete lines but preserves short and Unicode content', () => {
      const short = new DisplayBacklog()
      short.push('hello\r\nworld\r\n')
      assert.equal(short.recent(), 'hello\r\nworld\r\n')
      const long = new DisplayBacklog()
      long.push('x'.repeat(10_000))
      long.push('\r\nRECENT😀\r\n')
      assert.ok(long.recent().endsWith('RECENT😀\r\n'))
      assert.ok(long.recent().length <= SERIAL_LIVE_TAIL_CHARS)
    })
    await test('6 Mi hidden serial printing opens instantly at latest output without fast-forward', async () => {
      const events = []
      setMainWindow({ isDestroyed: () => false, webContents: { send: (_ch, e) => events.push(e) } })
      const runtime = new TerminalRuntime('serial')
      runtime.setVisible('stress', false)
      await runtime.start('stress', { dir, name: 'STRESS', temporary: true, pause: () => {}, fatal: () => assert.fail() })
      for (let i = 0; i < 96; i++) {
        runtime.data('stress', 'A'.repeat(64 * 1024))
        if (i % 4 === 3) await runtime.histories.get('stress').flush()
      }
      assert.equal(runtime.backlogs.get('stress').pending, 6 * 1024 * 1024)
      runtime.data('stress', 'LATEST\r\n')
      runtime.setVisible('stress', true)
      const frames = events.filter(e => e.type === 'data')
      const shown = frames.map(e => e.payload.text).join('')
      assert.ok(events.some(e => e.type === 'output:resync'),
        'resume must keep xterm scrollback rather than issue ESC c')
      assert.equal(events.filter(e => e.type === 'output:reset').length, 1,
        'only session start may hard-reset the terminal')
      assert.ok(shown.length < SERIAL_LIVE_TAIL_CHARS + 100)
      assert.ok(shown.endsWith('LATEST\r\n'))
      for (const frame of frames) runtime.invoke('stress', 'output:ack', frame.payload)
      runtime.data('stress', 'NOW\r\n')
      assert.ok(events.filter(e => e.type === 'data').at(-1).payload.text.includes('NOW'))
      assert.ok(!events.some(e => e.type === 'output:overflow'))
      const page = await runtime.invoke('stress', 'history:tail', { lines: 5 })
      assert.ok(page.rows.some(r => r.text.includes('LATEST')))
      const full = await runtime.histories.get('stress').query({ query: 'AAAA' })
      assert.ok(full.rows.length > 0)
      await runtime.dispose('stress'); runtime.forgetVisible('stress')
    })
    await test('repeated hide/show displays only fresh tail, not previous hidden content', async () => {
      const events = []
      setMainWindow({ isDestroyed: () => false, webContents: { send: (_ch, e) => events.push(e) } })
      const runtime = new TerminalRuntime('serial')
      runtime.setVisible('toggle', false)
      await runtime.start('toggle', { dir, name: 'TOGGLE', temporary: true, pause: () => {}, fatal: () => assert.fail() })
      runtime.data('toggle', 'old\r\n'.repeat(70_000))
      runtime.setVisible('toggle', true)
      const first = events.filter(e => e.type === 'data')
      assert.ok(first.map(e => e.payload.text).join('').length <= SERIAL_LIVE_TAIL_CHARS + 16)
      for (const e of first) runtime.invoke('toggle', 'output:ack', e.payload)
      runtime.setVisible('toggle', false)
      runtime.data('toggle', 'NEWEST\r\n')
      runtime.setVisible('toggle', true)
      const next = events.filter(e => e.type === 'data').slice(first.length)
      assert.equal(next.map(e => e.payload.text).join(''), '\x1b[0mNEWEST\r\n')
      assert.equal(events.filter(e => e.type === 'output:resync').length, 2,
        'every return should retire stale output without clearing existing scrollback')
      await runtime.dispose('toggle'); runtime.forgetVisible('toggle')
    })
    await test('hidden with only in-flight output drops stale IPC without clearing xterm scrollback', async () => {
      const events = []
      setMainWindow({ isDestroyed: () => false, webContents: { send: (_ch, e) => events.push(e) } })
      const runtime = new TerminalRuntime('serial')
      await runtime.start('pending-only', { dir, name: 'PENDING', temporary: true, pause: () => {}, fatal: () => assert.fail() })
      runtime.data('pending-only', 'PREVIOUS-CONTEXT\r\n')
      const prior = events.filter(e => e.type === 'data')
      assert.ok(prior.length > 0)
      runtime.setVisible('pending-only', false)
      runtime.setVisible('pending-only', true)
      assert.equal(events.filter(e => e.type === 'output:resync').length, 1)
      assert.equal(events.filter(e => e.type === 'output:reset').length, 1,
        'visibility must not send RIS and destroy scrollback')
      const after = events.filter(e => e.type === 'data').length
      runtime.invoke('pending-only', 'output:ack', prior[0].payload)
      assert.equal(events.filter(e => e.type === 'data').length, after,
        'old generation ACKs cannot resume discarded output')
      runtime.data('pending-only', 'LIVE\r\n')
      assert.ok(events.filter(e => e.type === 'data').at(-1).payload.text.includes('LIVE'))
      await runtime.dispose('pending-only'); runtime.forgetVisible('pending-only')
    })
    await test('hidden OutputWindow stops NEW frames, then resumes in FIFO order', () => {
      const frames = []
      const output = new OutputWindow('pause-test', frame => frames.push(frame), () => {}, () => assert.fail('overflow'), 32 * 1024)
      const text = 'x'.repeat(160 * 1024)
      output.write(text)
      const alreadySent = frames.length
      assert.ok(alreadySent > 0 && output.pending > 32 * 1024)
      output.suspendDelivery()
      for (let i = 0; i < alreadySent; i++) output.ack(frames[i])
      assert.equal(frames.length, alreadySent, 'hidden view must not dispatch queued frames after ACK')
      output.resumeDelivery()
      let replayed = ''
      for (let i = 0; i < frames.length && i < 40; i++) {
        replayed += frames[i].text
        output.ack(frames[i])
      }
      assert.equal(replayed, text)
      assert.equal(output.pending, 0)
    })
    await test('background cache aligns evicted prefix to next complete log line', () => {
      const b = new DisplayBacklog(16)
      b.push('A'.repeat(16))
      b.push('1234\nNEXT\n')
      assert.equal(b.take().chunks.join(''), 'NEXT\n')
      const fragmented = new DisplayBacklog(3)
      fragmented.push('\ud83d')
      fragmented.push('\ude00A')
      assert.equal(fragmented.read(2), '😀')
      assert.equal(fragmented.read(2), 'A')
      assert.equal(fragmented.pending, 0)
    })
    await test('hide with old output queued drops stale frames and releases display pressure', async () => {
      const events = []; const pauses = []
      setMainWindow({ isDestroyed: () => false, webContents: { send: (_ch, e) => events.push(e) } })
      const runtime = new TerminalRuntime('serial')
      await runtime.start('hide-mid', {
        dir, name: 'HIDE-MID', temporary: true,
        pause: value => pauses.push(value), fatal: () => assert.fail()
      })
      runtime.data('hide-mid', 'A'.repeat(512 * 1024))
      await runtime.histories.get('hide-mid').flush()
      const sentBefore = events.filter(e => e.type === 'data')
      assert.ok(sentBefore.length > 0)
      assert.equal(pauses.at(-1), true)
      runtime.setVisible('hide-mid', false)
      assert.equal(pauses.at(-1), false)
      for (const e of sentBefore) runtime.invoke('hide-mid', 'output:ack', e.payload)
      assert.equal(events.filter(e => e.type === 'data').length, sentBefore.length)
      runtime.data('hide-mid', 'B'.repeat(64 * 1024) + 'CURRENT\r\n')
      runtime.setVisible('hide-mid', true)
      const tail = events.filter(e => e.type === 'data').slice(sentBefore.length)
      assert.ok(tail.length > 0)
      const shown = tail.map(e => e.payload.text).join('')
      assert.ok(shown.length < SERIAL_LIVE_TAIL_CHARS + 100)
      assert.ok(shown.endsWith('CURRENT\r\n'))
      assert.ok(!shown.includes('A'.repeat(100)))
      const complete = await runtime.invoke('hide-mid', 'history:tail', { lines: 8 })
      assert.ok(complete.rows.some(r => r.text.includes('CURRENT')))
      await runtime.dispose('hide-mid'); runtime.forgetVisible('hide-mid')
    })
    await test('counter throttle publishes the final burst value and cancels on disposal', async () => {
      const values = []
      const counter = new ByteCounterThrottle((rx, tx) => values.push([rx, tx]), 5)
      counter.update(60, 0); counter.update(9_000_000, 6)
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.deepEqual(values, [[9_000_000, 6]])
      counter.update(10_000_000, 7); counter.dispose()
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.equal(values.length, 1)
    })
    await test('streaming formatter preserves CRLF and ANSI at every split', () => {
      const input = '\x1b[36m中文😀\x1b[0m\r\r\n\nend\x1b]0;title\x07!'
      const format = (chunks) => {
        let output = ''; const f = new LogFormatter()
        for (const chunk of chunks) f.write(chunk, (s) => output += s, 0)
        f.finish((s) => output += s)
        return output
      }
      const expected = format([input])
      assert.ok(expected.includes('中文😀\r\n'))
      assert.ok(!expected.includes('\x1b'))
      for (let i = 0; i <= input.length; i++) assert.equal(format([input.slice(0, i), input.slice(i)]), expected)
    })
    await test('no-newline and unfinished OSC input never accumulate a line', () => {
      const f = new LogFormatter(); let bytes = 0; let largest = 0
      for (let i = 0; i < 1000; i++) f.write('x'.repeat(4096), (s) => { bytes += s.length; largest = Math.max(largest, s.length) }, 0)
      assert.ok(bytes > 4_096_000); assert.ok(largest < 17_000)
      f.write('\x1b]title', () => {})
      f.write('x'.repeat(100_000), () => assert.fail('OSC payload leaked'))
      let out = ''; f.write('\x1b\\ok', (s) => out += s)
      assert.equal(out, 'ok')
    })
    await test('output pauses at high watermark and resumes only after parsing ACKs', () => {
      const frames = []; const pressure = []
      const output = new OutputWindow('a', (f) => frames.push(f), (p) => pressure.push(p), () => assert.fail())
      const text = '中文😀'.repeat(100_000)
      output.write(text)
      assert.ok(frames.length < 30); assert.deepEqual(pressure, [true])
      const pending = output.pending
      output.ack({ generation: 'old', sequence: frames[0].sequence })
      output.ack({ generation: 'a', sequence: 9999 })
      assert.equal(output.pending, pending)
      let result = ''
      for (let i = 0; i < frames.length; i++) { result += frames[i].text; output.ack(frames[i]); output.ack(frames[i]) }
      assert.equal(result, text); assert.equal(output.pending, 0); assert.deepEqual(pressure, [true, false])
    })
    await test('output overflow is bounded and signalled once; dispose releases queues', () => {
      let overflows = 0
      const output = new OutputWindow('a', () => {}, () => {}, () => overflows++, 128 * 1024, 256 * 1024)
      output.write('x'.repeat(200 * 1024)); output.write('y'.repeat(100 * 1024)); output.write('z')
      assert.equal(overflows, 1); assert.equal(output.pending, 0)
      output.dispose(); assert.equal(output.pending, 0)
    })
    await test('panel lifecycle queues pending open, disconnect, duplicate dispose', async () => {
      const tasks = new PanelTasks(); const order = []
      let release; const open = tasks.run('p', async () => { order.push('opening'); await new Promise((r) => release = r); order.push('opened') })
      const close = tasks.run('p', async () => order.push('closed'))
      const dispose = tasks.run('p', async () => order.push('disposed'))
      await tick(); assert.deepEqual(order, ['opening']); release()
      await Promise.all([open, close, dispose]); await tick()
      assert.deepEqual(order, ['opening', 'opened', 'closed', 'disposed']); assert.deepEqual(tasks.ids, [])
      await assert.rejects(tasks.run('p', async () => { throw new Error('open failed') }))
      assert.equal(await tasks.run('p', async () => 42), 42)
    })
    await test('disk log counts each UTF-8 byte once and exports after disconnect', async () => {
      const history = await SessionHistory.create(join(dir, 'count.log'), false)
      for (let i = 0; i < 256; i++) history.append('中文😀\n')
      await history.close()
      const data = await fs.readFile(history.path)
      assert.equal(history.bytes, data.length); assert.equal(history.pendingBytes, 0)
      const target = join(dir, 'export.log')
      await history.exportTo(target)
      assert.deepEqual(await fs.readFile(target), data)
      await assert.rejects(history.exportTo(history.path), /不能覆盖/)
      await history.dispose(); await history.dispose()
      assert.equal((await fs.stat(history.path)).size, data.length)
    })
    await test('long live line is written incrementally before newline', async () => {
      const history = await SessionHistory.create(join(dir, 'long.log'), true)
      for (let i = 0; i < 32; i++) { history.append('中'.repeat(16_384)); await history.flush() }
      assert.ok((await fs.stat(history.path)).size > 1024 * 1024)
      assert.equal(history.pendingBytes, 0)
      const page = await history.query({})
      assert.ok(page.rows.length > 0); assert.ok(page.rows.every((r) => !r.text.includes('�')))
      await history.dispose(); await assert.rejects(fs.stat(history.path), { code: 'ENOENT' })
    })
    await test('history cursor pagination and keyword search scan disk in bounded pages', async () => {
      const path = join(dir, 'pages.log')
      const lines = Array.from({ length: 600 }, (_, i) => `中文 ${i} ${i === 450 ? 'NEEDLE' : ''}`)
      await fs.writeFile(path, lines.join('\n') + '\n')
      let offset = 0; const actual = []
      do {
        const page = await readHistoryPage(path, { offset })
        assert.ok(page.rows.length <= 200); assert.ok(page.nextOffset > offset)
        actual.push(...page.rows.map((r) => r.text)); offset = page.nextOffset
        if (page.eof) break
      } while (true)
      assert.deepEqual(actual, lines)
      const search = await readHistoryPage(path, { query: 'needle' })
      assert.equal(search.rows.length, 1); assert.equal(search.rows[0].text, lines[450])
      await fs.writeFile(path, 'x'.repeat(2 * 1024 * 1024))
      const empty = await readHistoryPage(path, { query: 'absent' })
      assert.equal(empty.rows.length, 0); assert.equal(empty.nextOffset, 1024 * 1024); assert.equal(empty.eof, false)
    })
    await test('backward disk-history pagination keeps stable byte offsets and bounded rows', async () => {
      const path = join(dir, 'backward.log')
      const input = Array.from({ length: 560 }, (_, i) => `中文日志-${i}`)
      await fs.writeFile(path, input.join('\n') + '\n')
      let before
      const pages = []
      for (let n = 0; n < 10; n++) {
        const page = await readHistoryTail(path, { before, lines: 90 })
        assert.ok(page.rows.length <= 90)
        pages.unshift(...page.rows.map(r => r.text))
        if (!page.hasMore) break
        assert.ok(page.before < (before ?? Infinity))
        before = page.before
      }
      assert.deepEqual(pages, input)
    })
    await test('long physical lines remain readable at backward-history page boundaries', async () => {
      const path = join(dir, 'huge-log.log')
      await fs.writeFile(path, 'A'.repeat(700 * 1024) + 'LATEST\r\n' + 'NOW\r\n')
      const newest = await readHistoryTail(path, { lines: 5 })
      assert.ok(newest.rows.some(r => r.text.includes('LATEST')),
        'last 256 KiB must not drop the tail of a longer physical line')
      assert.ok(newest.rows.some(r => r.text.includes('NOW')))
      assert.ok(newest.hasMore)
      const older = await readHistoryTail(path, { lines: 5, before: newest.before })
      assert.ok(older.before < newest.before || !older.hasMore)
    })
    await test('reverse history starts at valid UTF-8 codepoint boundary', async () => {
      const path = join(dir, 'unicode-boundary.log')
      await fs.writeFile(path, '中'.repeat(350_000) + '\n终点😀\n')
      const first = await readHistoryTail(path, { lines: 2 })
      assert.ok(first.rows.some(r => r.text.includes('终点😀')))
      assert.ok(!first.rows.some(r => r.text.includes('�')))
      const second = await readHistoryTail(path, { before: first.before, lines: 2 })
      assert.ok(!second.rows.some(r => r.text.includes('�')),
        'reverse pages must not decode a partial multibyte character')
    })
    await test('slow disk applies backpressure; backlog overflow reports failure and drains', async () => {
      const pressure = []; const errors = []
      const history = await SessionHistory.create(join(dir, 'slow.log'), true, (p) => pressure.push(p), (e) => errors.push(e))
      const write = history.handle.writeFile.bind(history.handle)
      let release
      const gate = new Promise((r) => release = r)
      history.handle.writeFile = async (data) => { await gate; return write(data) }
      history.append('x'.repeat(300 * 1024)); await tick()
      assert.deepEqual(pressure, [true])
      history.append('x'.repeat(5 * 1024 * 1024))
      assert.equal(errors.length, 1); assert.ok(history.pendingBytes <= 4 * 1024 * 1024)
      release(); await assert.rejects(history.flush(), /积压/)
      assert.equal(history.pendingBytes, 0); assert.equal(pressure.at(-1), false)
      await history.dispose()
    })
    await test('disk failure is reported once instead of silently continuing', async () => {
      const errors = []
      const history = await SessionHistory.create(join(dir, 'failure.log'), true, () => {}, (e) => errors.push(e))
      history.handle.writeFile = async () => { throw new Error('ENOSPC') }
      history.append('hello'); await assert.rejects(history.flush(), /ENOSPC/)
      history.append('ignored'); assert.equal(errors.length, 1)
      await history.dispose()
    })
    await test('runtime releases retained histories, source closures and stale ACKs', async () => {
      const events = []
      setMainWindow({ isDestroyed: () => false, webContents: { send: (_channel, event) => events.push(event) } })
      const runtime = new TerminalRuntime('serial')
      const options = { dir, name: 'COM1', temporary: true, pause: () => {}, fatal: () => assert.fail() }
      await runtime.start('p', options)
      runtime.data('p', 'hello\n')
      const old = events.find((e) => e.type === 'data').payload
      await runtime.close('p')
      assert.equal(runtime.options.size, 0)
      const page = await runtime.invoke('p', 'history:query', {})
      assert.ok(page.rows.some((r) => r.text.includes('hello')))
      globalThis.terminalExportPath = join(dir, 'runtime-export.log')
      assert.equal((await runtime.export('p')).ok, true)
      await runtime.start('p', options)
      runtime.data('p', 'new\n')
      const pending = runtime.outputs.get('p').pending
      runtime.invoke('p', 'output:ack', old)
      assert.equal(runtime.outputs.get('p').pending, pending)
      await runtime.dispose('p'); await runtime.dispose('p')
      assert.deepEqual(runtime.ids, []); assert.equal(runtime.histories.size, 0)
      assert.equal(runtime.outputs.size, 0); assert.equal(runtime.pressure.size, 0)
      await assert.rejects(fs.stat(page.path), { code: 'ENOENT' })
    })
    console.log(`terminal: ${count} test groups passed`)
  } finally { setMainWindow(null); await fs.rm(dir, { recursive: true, force: true }) }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
