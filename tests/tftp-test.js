/* eslint-disable */
/**
 * TFTP 协议回环测试：不依赖 Electron，esbuild 单独打包 server 后用 node 客户端测试
 * 运行：node tests/tftp-test.js
 */
const { execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const dgram = require('dgram')

const PROJECT = path.join(__dirname, '..')
const BUNDLE = path.join(__dirname, '.tftp-server.test.cjs')

execSync(
  `npx esbuild src/main/services/tftp/server.ts --bundle --platform=node --format=cjs --outfile=${JSON.stringify(BUNDLE)}`,
  { cwd: PROJECT, stdio: 'pipe' }
)

const { TftpServer } = require(BUNDLE)

const OP = { RRQ: 1, WRQ: 2, DATA: 3, ACK: 4, ERROR: 5, OACK: 6 }
const PORT = 9069
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tftp-test-'))

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
  console.log('PASS:', msg)
}

function makeClient() {
  return dgram.createSocket('udp4')
}

function send(sock, buf, port = PORT) {
  sock.send(buf, port, '127.0.0.1')
}

function rrqWithOpts(filename, blksize) {
  return Buffer.concat([
    Buffer.from([0, OP.RRQ]),
    Buffer.from(`${filename}\0octet\0blksize\0${blksize}\0tsize\0\0`)
  ])
}

function rrqPlain(filename) {
  return Buffer.from([0, OP.RRQ, ...Buffer.from(`${filename}\0octet\0`)])
}

function wrqWithOpts(filename, blksize, tsize) {
  return Buffer.concat([
    Buffer.from([0, OP.WRQ]),
    Buffer.from(`${filename}\0octet\0blksize\0${blksize}\0tsize\0${tsize}\0\0`)
  ])
}

/** RRQ 下载，返回 Promise<Buffer> */
function download(filename, blksize) {
  return new Promise((resolve, reject) => {
    const sock = makeClient()
    const chunks = []
    let expectBlock = 1
    let serverPort = PORT
    const timeout = setTimeout(() => reject(new Error('download timeout')), 5000)
    sock.on('message', (msg, rinfo) => {
      serverPort = rinfo.port
      const op = msg.readUInt16BE(0)
      if (op === OP.OACK) {
        // ACK 0
        const ack = Buffer.from([0, OP.ACK, 0, 0])
        send(sock, ack, serverPort)
      } else if (op === OP.DATA) {
        const block = msg.readUInt16BE(2)
        assert(block === expectBlock % 65536, `DATA 块号 ${block} == 期望 ${expectBlock}`)
        chunks.push(msg.subarray(4))
        expectBlock += 1
        const ack = Buffer.alloc(4)
        ack.writeUInt16BE(OP.ACK, 0)
        ack.writeUInt16BE(block, 2)
        send(sock, ack, serverPort)
        if (msg.length - 4 < blksize) {
          clearTimeout(timeout)
          sock.close()
          resolve(Buffer.concat(chunks))
        }
      } else if (op === OP.ERROR) {
        clearTimeout(timeout)
        sock.close()
        reject(new Error(`server ERROR ${msg.readUInt16BE(2)}`))
      }
    })
    const req = blksize ? rrqWithOpts(filename, blksize) : rrqPlain(filename)
    sock.send(req, PORT, '127.0.0.1')
  })
}

/** WRQ 上传 */
function upload(filename, data, blksize) {
  return new Promise((resolve, reject) => {
    const sock = makeClient()
    let block = 1
    let serverPort = PORT
    const timeout = setTimeout(() => reject(new Error('upload timeout')), 5000)
    sock.on('message', (msg, rinfo) => {
      serverPort = rinfo.port
      const op = msg.readUInt16BE(0)
      if (op === OP.OACK) {
        sendBlock()
      } else if (op === OP.ACK) {
        const acked = msg.readUInt16BE(2)
        if (acked === 0 && block === 1 && !blksize) {
          // classic WRQ ACK0 后发 DATA1
          sendBlock()
          return
        }
        if (acked === (block - 1) % 65536) {
          if ((block - 1) * blksize >= data.length || lastSent < blksize) {
            clearTimeout(timeout)
            sock.close()
            resolve()
            return
          }
          sendBlock()
        }
      } else if (op === OP.ERROR) {
        clearTimeout(timeout)
        sock.close()
        reject(new Error(`server ERROR ${msg.readUInt16BE(2)}`))
      }
    })
    let lastSent = 0
    function sendBlock() {
      const start = (block - 1) * blksize
      const chunk = data.subarray(start, start + blksize)
      lastSent = chunk.length
      const pkt = Buffer.allocUnsafe(4 + chunk.length)
      pkt.writeUInt16BE(OP.DATA, 0)
      pkt.writeUInt16BE(block % 65536, 2)
      chunk.copy(pkt, 4)
      block += 1
      send(sock, pkt, serverPort)
    }
    const req = wrqWithOpts(filename, blksize, data.length)
    sock.send(req, PORT, '127.0.0.1')
  })
}

async function main() {
  const server = new TftpServer()
  const logs = []
  server.on('log', (l) => logs.push(l))

  // 准备测试文件：3000 字节随机（>512 且 >1024，覆盖多块 + 最后短块）
  const payload = Buffer.from(
    Array.from({ length: 3000 }, (_, i) => (i * 7 + 13) % 256)
  )
  fs.writeFileSync(path.join(root, 'test.bin'), payload)

  await server.start(PORT, root)
  console.log('server started on', PORT)

  // 1. 经典 RRQ（512 块，无选项）
  const got1 = await download('test.bin', 512)
  assert(got1.equals(payload), '经典 RRQ(512) 内容一致')

  // 2. 带选项 RRQ（blksize 1024 + tsize）
  const got2 = await download('test.bin', 1024)
  assert(got2.equals(payload), 'OACK RRQ(1024) 内容一致')

  // 3. 不存在的文件 → ERROR
  let errored = false
  try {
    await download('no-such.bin', 512)
  } catch (e) {
    errored = true
  }
  assert(errored, 'RRQ 不存在文件返回 ERROR')

  // 4. 带选项 WRQ（blksize 1024）
  const up1 = Buffer.from(Array.from({ length: 2500 }, (_, i) => (i * 11 + 3) % 256))
  await upload('up1.bin', up1, 1024)
  assert(fs.readFileSync(path.join(root, 'up1.bin')).equals(up1), 'OACK WRQ(1024) 内容一致')

  // 5. 经典 WRQ（512）
  const up2 = Buffer.from('hello tftp classic write')
  await upload('up2.bin', up2, 512)
  assert(fs.readFileSync(path.join(root, 'up2.bin')).equals(up2), '经典 WRQ(512) 内容一致')

  // 6. 路径穿越防护
  let blocked = false
  try {
    await download('../secret.txt', 512)
  } catch (e) {
    blocked = true
  }
  assert(blocked, '路径穿越被拒绝(报错而非读取外部文件)')

  server.stop()
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(BUNDLE, { force: true })
  console.log('=== ALL TFTP TESTS PASSED ===')
  process.exit(0)
}

main().catch((err) => {
  console.error('TEST FAILED:', err.message)
  process.exit(1)
})
