/* 串口TCP桥接纯逻辑测试：Telnet IAC 状态机 / JSON 行协议 / 身份派生
   与主进程 bridge 服务、渲染端 BridgePanel 共用同一份协议代码 */
const {
  TelnetIacParser,
  packCommand,
  splitLines,
  unpackLine,
  makeIdentity,
  safeFilePart,
  portDeviceOf,
  IAC,
  DO,
  WILL,
  SB,
  SE,
  CMD_BREAK,
  CMD_AYT
} = require('../src/shared/bridge-protocol')

let pass = 0
let fail = 0
function check(name, cond) {
  if (cond) {
    pass++
  } else {
    fail++
    console.log(`  [FAIL] ${name}`)
  }
}

// ---------- Telnet IAC 状态机 ----------
console.log('== Telnet IAC 解析（RFC 854 最小状态机） ==')
const p = new TelnetIacParser()

// 纯数据透传
check('纯 ASCII 透传', p.feed(Buffer.from('hello')).data.toString() === 'hello')
check('二进制 0x00-0xFE 透传', p.feed(Buffer.from([0x00, 0x01, 0xfe])).data.toString('hex') === '0001fe')

// IAC IAC 反转义
check('IAC IAC 反转义为单 0xFF', p.feed(Buffer.from([IAC, IAC, 0x41])).data.toString('hex') === 'ff41')

// 三字节协商剥离（DO/WILL/WONT/DONT + 选项）
check(
  'IAC DO TERM 剥离',
  p.feed(Buffer.from([0x61, IAC, DO, 0x18, 0x62])).data.toString() === 'ab'
)
check(
  'IAC WILL 剥离',
  p.feed(Buffer.from([IAC, WILL, 0x01])).data.length === 0
)

// 子协商剥离
check(
  'IAC SB ... IAC SE 整段剥离',
  p.feed(Buffer.from([IAC, SB, 0x22, 0x01, 0x03, IAC, SE, 0x7a])).data.toString() === 'z'
)
check(
  '子协商内嵌 IAC IAC 反转义继续收',
  p.feed(Buffer.from([IAC, SB, 0x01, IAC, IAC, IAC, SE, 0x63])).data.toString() === 'c'
)

// IAC BREAK → 事件
{
  const r = p.feed(Buffer.from([IAC, CMD_BREAK]))
  check('IAC BREAK 产生 break 事件', r.events.includes('break') && r.data.length === 0)
}
{
  const r = p.feed(Buffer.from([0x41, IAC, CMD_AYT, 0x42]))
  check('IAC AYT 剥离（无事件、数据保留）', r.data.toString() === 'AB' && r.events.length === 0)
}

// 跨批安全：半截序列在批边界滞留状态
{
  const q = new TelnetIacParser()
  const r1 = q.feed(Buffer.from([0x61, IAC])) // 结尾孤立 IAC
  check('批尾孤立 IAC 滞留状态', r1.data.toString() === 'a')
  const r2 = q.feed(Buffer.from([DO, 0x18, 0x62])) // 续批补全三字节命令
  check('续批补全协商不漏数据', r2.data.toString() === 'b')
}
{
  const q = new TelnetIacParser()
  q.feed(Buffer.from([IAC, SB, 0x01])) // 进入子协商
  q.feed(Buffer.from([0x02])) // 子协商体
  const r3 = q.feed(Buffer.from([IAC])) // 子协商尾 IAC
  check('子协商尾 IAC 滞留状态', r3.data.length === 0)
  const r4 = q.feed(Buffer.from([SE, 0x64]))
  check('续批 SE 结束子协商', r4.data.toString() === 'd')
}
{
  // BREAK 跨批：FF 在前批尾、F3 在后批头
  const q = new TelnetIacParser()
  const r1 = q.feed(Buffer.from([0x61, IAC]))
  const r2 = q.feed(Buffer.from([CMD_BREAK, 0x62]))
  check('IAC BREAK 跨批仍触发事件', r2.events.includes('break') && r1.data.toString() === 'a' && r2.data.toString() === 'b')
}
{
  // 实际 telnet 客户端连接时的典型协商流
  const q = new TelnetIacParser()
  const stream = Buffer.from([
    IAC, WILL, 0x03, // WILL SGA
    IAC, WILL, 0x01, // WILL ECHO
    IAC, DO, 0x1f, // DO NASC
    0x0d, 0x0a, // CRLF 数据
    IAC, IAC // 转义 0xFF
  ])
  const r = q.feed(stream)
  check('真实 telnet 协商流剥离后只剩数据', r.data.toString('hex') === '0d0aff' && r.events.length === 0)
}

// ---------- JSON 行协议 ----------
console.log('== 远程管理 JSON 行协议 ==')
const packed = packCommand('start_channel', { cid: 3, port: 'COM3', baudrate: 115200, tcp_port: 10003 })
check('packCommand 以 \\n 结尾', packed[packed.length - 1] === 0x0a)
check('packCommand JSON 合法', JSON.parse(packed.toString('utf8').trim()).cmd === 'start_channel')
{
  const [lines, rest] = splitLines(Buffer.concat([packed, Buffer.from('{"cmd":"stop_all"}')]))
  check('splitLines 完整行 + 半行残留', lines.length === 1 && lines[0].includes('start_channel') && rest.length > 0)
  const [l2] = splitLines(Buffer.concat([rest, Buffer.from('\n')]))
  check('续批补 \\n 后半行成行', l2.length === 1 && l2[0] === '{"cmd":"stop_all"}')
}
check('splitLines 吃掉 \\r\\n 的 \\r', splitLines(Buffer.from('a\r\nb\n'))[0][0] === 'a')
check('unpackLine 合法 JSON', unpackLine('{"cmd":"get_channels"}').cmd === 'get_channels')
check('unpackLine 非法 JSON 返回 null', unpackLine('{broken') === null)
check('unpackLine 非 JSON 对象返回 null', unpackLine('123') === null)
check('unpackLine 空行返回 null', unpackLine('') === null)
{
  // 全命令 round-trip（8 条命令）
  const cmds = [
    ['get_channels', {}],
    ['update_config', { cid: 1, port: 'COM5', baudrate: 9600, tcp_port: 10001 }],
    ['start_channel', { cid: 2 }],
    ['stop_channel', { cid: 2 }],
    ['start_all', {}],
    ['stop_all', {}],
    ['get_ports', {}],
    ['send_break', { cid: 4 }]
  ]
  let allOk = true
  for (const [cmd, kv] of cmds) {
    const [lines] = splitLines(packCommand(cmd, kv))
    const msg = unpackLine(lines[0])
    if (!msg || msg.cmd !== cmd) allOk = false
  }
  check('全部 8 条命令 pack→split→unpack round-trip', allOk)
}
{
  // 多条命令粘包在一个 chunk
  const blob = Buffer.concat([
    packCommand('get_channels'),
    packCommand('stop_all'),
    packCommand('get_ports')
  ])
  const [lines, rest] = splitLines(blob)
  check('粘包多行一次解出', lines.length === 3 && rest.length === 0)
}

// ---------- 身份派生 ----------
console.log('== 配置身份派生 ==')
check('server 模式身份', makeIdentity('server', 'whatever', 9999) === 'server_9999')
check('client 模式身份', makeIdentity('client', '192.168.1.10', 9999) === '192.168.1.10_9999')
check('非法字符清洗为下划线', makeIdentity('client', 'a:b\\c/d*e?f"g<h>i|j', 1) === 'a_b_c_d_e_f_g_h_i_j_1')
check('全非法字符端口有值仍保留', makeIdentity('client', '::::', '9999') === '_____9999')
check('空主机+端口有值身份为 _端口', makeIdentity('client', '', 9999) === '_9999')
check('主机端口全空回退 default', makeIdentity('client', '', '') === 'default')
check('全下划线回退 default', makeIdentity('client', '_:_', '_:_') === 'default')
check('safeFilePart 清洗', safeFilePart('192.168.1.10:9999') === '192.168.1.10_9999')
check('safeFilePart 空串回退 default', safeFilePart('') === 'default')
check('safeFilePart 全非法字符回退 default', safeFilePart(':::') === 'default')

// ---------- 串口显示名 → 设备名 ----------
console.log('== 串口显示名归一（portDeviceOf） ==')
check('显示名提取 COM 设备名', portDeviceOf('COM3  (USB-Serial)' ) === 'COM3')
check('裸设备名原样返回', portDeviceOf('COM10') === 'COM10')
check('多余空白裁剪', portDeviceOf('  COM5  ') === 'COM5')
check('无括号后缀原样返回', portDeviceOf('COM3  ') === 'COM3')

console.log(`\n串口TCP桥接协议: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
