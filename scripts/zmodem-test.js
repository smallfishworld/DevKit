/* ZMODEM 包装层测试：esbuild 打包 zmodem.ts 后用 zmodem.js 自身做回环
   架构：内存管道 A→B；A 端用被测包装层，B 端直接用 zmodem.js 原生会话做对端 */
const { execSync } = require('node:child_process')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(__dirname, '.zmodem-test.cjs')

execSync(
  `npx esbuild "${path.join(ROOT, 'src/main/services/serial/zmodem.ts')}" --bundle --platform=node --external:electron --outfile="${OUT}" --log-level=error`,
  { cwd: ROOT, stdio: 'inherit' }
)
const { zmodemSend, zmodemRecv } = require(OUT)
const Zmodem = require(path.join(ROOT, 'node_modules/zmodem.js'))

let pass = 0
let fail = 0
function check(name, cond) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`) }
  else { fail++; console.log(`  [FAIL] ${name}`) }
}

/** 双向内存管道：aSink 收 b->a 字节，bSink 收 a->b 字节 */
function makePipe() {
  const aToB = [], bToA = []
  let aSink = null, bSink = null
  const pump = () => {
    while (aToB.length && bSink) bSink(aToB.shift())
    while (bToA.length && aSink) aSink(bToA.shift())
  }
  return {
    aWrite: (buf) => { aToB.push(Buffer.from(buf)); pump() },
    bWrite: (buf) => { bToA.push(Buffer.from(buf)); pump() },
    setA: (fn) => { aSink = fn; pump() },
    setB: (fn) => { bSink = fn; pump() }
  }
}

const toU8 = (buf) => new Uint8Array(buf)
const toArr = (buf) => Array.from(new Uint8Array(buf))

// ---------- 发送：包装层 send ↔ 原生 Receive（模拟 rz） ----------
async function testSend() {
  console.log('== ZMODEM 发送（对端 rz）==')
  const pipe = makePipe()
  const data = Buffer.alloc(50 * 1024, (i) => i & 0xff)

  // B 端：原生 Receive 会话（rz 的行为——start() 主动发 ZRINIT）
  const filesB = []
  const bSession = new Zmodem.Session.Receive()
  bSession.on('offer', async (xfer) => {
    const d = xfer.get_details()
    const spool = await xfer.accept()
    filesB.push({ name: d.name, data: Buffer.concat(spool.map((c) => Buffer.from(c))) })
  })
  bSession.set_sender((octets) => pipe.bWrite(octets))
  pipe.setB((chunk) => bSession.consume(toArr(chunk)))
  void bSession.start().catch(() => {})

  // A 端：被测包装层
  let progressCalls = 0
  let lastPct = 0
  await zmodemSend(
    (consume) => pipe.setA(consume),
    (buf) => pipe.aWrite(buf),
    'loop.bin',
    data,
    (bytes, total) => { progressCalls++; lastPct = total ? bytes / total : 0 }
  )

  check('B 端收到 1 个文件', filesB.length === 1)
  check('文件名正确', filesB[0]?.name === 'loop.bin')
  check('内容一致', filesB[0]?.data.equals(data))
  check('进度回调发生', progressCalls >= 1)
}

// ---------- 接收：包装层 recv ↔ 原生 Send（模拟 sz） ----------
async function testRecv() {
  console.log('== ZMODEM 接收（对端 sz）==')
  const pipe = makePipe()
  const data = Buffer.from('ZMODEM 接收回环测试。'.repeat(100))

  // B 端：模拟 sz——主动发 ZRQINIT 触发 A 建 Receive 会话；
  // A 回 ZRINIT 后 B 的 Sentry 检测出 Send 会话，confirm 后发文件
  const bSend = async () => {
    let bSession = null
    const sentryB = new Zmodem.Sentry({
      to_terminal: () => {},
      on_detect: (det) => {
        bSession = det.confirm()
      },
      on_retract: () => {},
      sender: (octets) => pipe.bWrite(octets)
    })
    pipe.setB((chunk) => sentryB.consume(toU8(chunk)))
    // sz 启动即发 ZRQINIT（hex 编码字节串）
    pipe.bWrite(Zmodem.Header.build('ZRQINIT').to_hex())
    // 等 A 的 ZRINIT 让 Sentry 建 Send 会话
    for (let i = 0; i < 500 && !bSession; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    if (!bSession) throw new Error('B 端 Send 会话未建立')
    const xfer = await bSession.send_offer({ name: 'from-b.bin', size: data.length })
    xfer.send(toU8(data))
    await xfer.end()
    await bSession.close()
  }

  // A 端：被测包装层 recv（其内部发 ZRINIT 触发 B 端会话）
  const recvPromise = zmodemRecv(
    (consume) => pipe.setA(consume),
    (buf) => pipe.aWrite(buf),
    () => {}
  )
  // B 端并发发文件
  void bSend().catch(() => {})
  const filesA = await recvPromise

  check('收到 1 个文件', filesA.length === 1)
  check('文件名正确', filesA[0]?.name === 'from-b.bin')
  check('内容一致', filesA[0]?.data.equals(data))
}

// ---------- 接收多文件：sz a.bin b.bin ----------
async function testRecvMulti() {
  console.log('== ZMODEM 接收多文件 ==')
  const pipe = makePipe()
  const fa = Buffer.alloc(2048, 0x11)
  const fb = Buffer.from('第二个文件内容')

  const bSend = async () => {
    let bSession = null
    const sentryB = new Zmodem.Sentry({
      to_terminal: () => {},
      on_detect: (det) => { bSession = det.confirm() },
      on_retract: () => {},
      sender: (octets) => pipe.bWrite(octets)
    })
    pipe.setB((chunk) => sentryB.consume(toU8(chunk)))
    pipe.bWrite(Zmodem.Header.build('ZRQINIT').to_hex())
    for (let i = 0; i < 500 && !bSession; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    if (!bSession) throw new Error('B 端 Send 会话未建立')
    for (const [name, d] of [['a.bin', fa], ['b.bin', fb]]) {
      const xfer = await bSession.send_offer({ name, size: d.length })
      if (!xfer) throw new Error(`offer ${name} 被拒`)
      xfer.send(toU8(d))
      await xfer.end()
    }
    await bSession.close()
  }

  const recvPromise = zmodemRecv(
    (consume) => pipe.setA(consume),
    (buf) => pipe.aWrite(buf),
    () => {}
  )
  void bSend().catch(() => {})
  const filesA = await recvPromise

  check('收到 2 个文件', filesA.length === 2)
  check('顺序与文件名正确', filesA[0]?.name === 'a.bin' && filesA[1]?.name === 'b.bin')
  check('a.bin 内容一致', filesA[0]?.data.equals(fa))
  check('b.bin 内容一致', filesA[1]?.data.equals(fb))
}

;(async () => {
  await testSend()
  await testRecv()
  await testRecvMulti()
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
})().catch((e) => {
  console.error('测试崩溃：', e)
  process.exit(1)
})
