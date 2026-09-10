/* YMODEM 独立测试：esbuild 打包 ymodem.ts 后用 node 跑协议回环 */
const { execSync } = require('node:child_process')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(__dirname, '.ymodem-test.cjs')

execSync(
  `npx esbuild "${path.join(ROOT, 'src/main/services/serial/ymodem.ts')}" --bundle --platform=node --outfile="${OUT}" --log-level=error`,
  { cwd: ROOT, stdio: 'inherit' }
)
const { crc16, ByteQueue, ymodemSend, ymodemRecv } = require(OUT)

const SOH = 0x01, STX = 0x02, EOT = 0x04, ACK = 0x06, NAK = 0x15, C = 0x43

let pass = 0
let fail = 0
function check(name, cond) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`) }
  else { fail++; console.log(`  [FAIL] ${name}`) }
}

function buildBlock(type, seq, data, pad) {
  const body = Buffer.alloc(type === SOH ? 128 : 1024, pad)
  data.copy(body, 0)
  const crc = crc16(body)
  const out = Buffer.alloc(3 + body.length + 2)
  out[0] = type
  out[1] = seq & 0xff
  out[2] = (~seq) & 0xff
  body.copy(out, 3)
  out[3 + body.length] = (crc >> 8) & 0xff
  out[4 + body.length] = crc & 0xff
  return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- CRC 已知向量 ----------
async function testCrc() {
  console.log('== CRC16-XMODEM ==')
  check('crc16("123456789") == 0x31C3', crc16(Buffer.from('123456789')) === 0x31c3)
  check('crc16("") == 0', crc16(Buffer.alloc(0)) === 0)
}

// ---------- 发送：模拟接收方（ry） ----------
async function testSend() {
  console.log('== YMODEM 发送 ==')
  const q = new ByteQueue()
  const data = Buffer.alloc(3000, (i) => i & 0xff)
  let gotData = Buffer.alloc(0)
  let headerOk = false
  let finalOk = false
  let eotCount = 0
  const respond = (bytes) => setTimeout(() => q.feed(Buffer.from(bytes)), 2)

  const write = (buf) => {
    const type = buf[0]
    if (type === SOH || type === STX) {
      const size = type === SOH ? 128 : 1024
      const seq = buf[1]
      const body = buf.subarray(3, 3 + size)
      const crc = (buf[3 + size] << 8) | buf[4 + size]
      if (crc !== crc16(body) || buf[2] !== (~seq & 0xff)) {
        respond([NAK])
        return
      }
      if (seq === 0) {
        const meta = body.toString('ascii').split('\0')
        if (meta[0] === 'test.bin') {
          headerOk = meta[1] === String(data.length)
        } else if (meta[0] === '') {
          finalOk = true // 结束空块
        }
        respond([ACK])
        respond([C])
      } else {
        gotData = Buffer.concat([gotData, body])
        respond([ACK])
      }
    } else if (type === EOT) {
      eotCount++
      if (eotCount === 1) respond([NAK])
      else { respond([ACK]); respond([C]) }
    }
  }

  // 真实接收方（ry）就绪后会主动发 C 触发发送方
  respond([C])
  await ymodemSend(q, write, 'test.bin', data, () => {})
  check('文件头（名称+大小）正确', headerOk)
  check('数据完整（含 0x1A 填充）', gotData.subarray(0, data.length).equals(data))
  check('EOT 握手（NAK 后重发）', eotCount === 2)
  check('结束空块收到', finalOk)
}

// ---------- 接收：模拟发送方（sy） ----------
async function testRecv() {
  console.log('== YMODEM 接收 ==')
  const q = new ByteQueue()
  const data = Buffer.from('YMODEM 收发回环测试数据。'.repeat(80))
  // 数据块：1024B 对齐，末块补 0x1A
  const blocks = []
  for (let off = 0; off < data.length; off += 1024) {
    blocks.push(data.subarray(off, Math.min(off + 1024, data.length)))
  }
  let phase = 'idle'
  let sent = 0
  const feedB = (seq, b) => setTimeout(() => q.feed(buildBlock(STX, seq, b, 0x1a)), 2)

  const write = (buf) => {
    for (const b of buf) {
      if (b === C) {
        if (phase === 'idle') {
          // 第一次 C：发文件头（块 0）
          phase = 'hdr'
          setTimeout(() => {
            const head = Buffer.alloc(128, 0)
            Buffer.from(`recv.txt\0${data.length}\0`).copy(head)
            q.feed(buildBlock(SOH, 0, head, 0))
          }, 2)
        } else if (phase === 'end') {
          phase = 'done'
          setTimeout(() => q.feed(buildBlock(SOH, 0, Buffer.alloc(0), 0)), 2)
        }
      } else if (b === ACK) {
        if (phase === 'hdr') {
          // 头块确认：发第一个数据块
          phase = 'data'
          feedB(1, blocks[0])
          sent = 1
        } else if (phase === 'data') {
          if (sent < blocks.length) {
            feedB(sent + 1, blocks[sent])
            sent++
          } else {
            setTimeout(() => q.feed(Buffer.from([EOT])), 2)
            phase = 'eot1'
          }
        } else if (phase === 'eot2') {
          phase = 'end'
        }
      } else if (b === NAK) {
        if (phase === 'eot1') {
          setTimeout(() => q.feed(Buffer.from([EOT])), 2)
          phase = 'eot2'
        }
      }
    }
  }

  const files = await ymodemRecv(q, write, () => {})
  check('收到 1 个文件', files.length === 1)
  check('文件名正确', files[0]?.name === 'recv.txt')
  check('内容完整（去除填充）', files[0]?.data.equals(data))
  check('大小正确', files[0]?.size === data.length)
}

// ---------- 取消 ----------
async function testCancel() {
  console.log('== 取消 ==')
  const q = new ByteQueue()
  let err = null
  const p = ymodemSend(q, () => {}, 'x.bin', Buffer.alloc(1024), () => {}).catch((e) => {
    err = e
  })
  await sleep(50)
  q.cancel()
  await p
  check('取消后抛出中断', err !== null && err.message.includes('取消'))
}

;(async () => {
  await testCrc()
  await testSend()
  await testRecv()
  await testCancel()
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
})()
