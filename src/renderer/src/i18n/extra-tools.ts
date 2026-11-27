export const extraToolMessages = {
  'zh-CN': {
    extraCommon: { copied: '已复制', clear: '清空', success: '成功', failed: '失败', error: '异常 {error}' },
    endian: {
      title: '大小端转换', subtitle: '16 / 32 / 64 位字节序解析、数值编码与翻转', parseTitle: '字节序列解析（多宽度 × 大小端）',
      examples: { sequence: '01..08 递增序列', float: 'Float32 示例', register: '32 位寄存器', negative: '-100 (补码)', wide: '64-bit 示例' },
      parseWidth: '解析位宽', allWidths: '全部位宽', signedFloat: '有符号 / 浮点', bytesAria: 'HEX 字节序列',
      bytesPlaceholder: '输入 HEX 字节，如 01 02 03 04（空格/逗号/连续写法均可）', normalize: '规范空格', reverseAll: '整串倒序',
      invalidHex: 'HEX 格式非法（长度须为偶数）', byteOffsets: 'HEX 字节偏移', firstBytes: '前 64 字节',
      interpretation: '{name} 解释（{count} 个）', interpretationAria: '{name} 字节序解释', offset: '偏移', leHex: '小端 HEX (LE)', leDec: '小端十进制', beHex: '大端 HEX (BE)', beDec: '大端十进制', copyLe: '复制小端 HEX', copyBe: '复制大端 HEX', signed: '有符号 {value}',
      encodeTitle: '数值 → 字节序列', numberAria: '待编码数值', numberPlaceholder: '十进制（支持负数补码）或 0x 十六进制', invalidInteger: '请输入有效的整数', bytes: '字节', lowBits: '· 低 {width} 位',
      swapTitle: '字节交换（16/32/64 位）', swapPlaceholder: 'HEX 值，如 12345678', sendToParser: '送入上方解析', swap: 'u{width} 交换', needDigits: '需 {count} 个 hex 位'
    },
    timestamp: {
      title: '时间戳转换', subtitle: '秒、毫秒、微秒、纳秒、十六进制与日期互转', syncNow: '同步当前时刻', liveClock: '实时 Unix 时钟', paused: '已暂停', live: '实时时钟', seconds: '秒', milliseconds: '毫秒', local: '本地', fillParser: '填入下方解析', resume: '继续刷新', pause: '暂停刷新',
      toDate: '时间戳 → 日期时间', inputAria: '输入时间戳', inputPlaceholder: '输入时间戳或日期字符串', currentSeconds: '当前秒', currentMilliseconds: '当前毫秒', hexExample: '0xHEX 示例', midnight: '今日零点', minusDay: '−1 天', minusHour: '−1 小时', plusHour: '+1 小时', plusDay: '+1 天',
      localTime: '本地时间', relativeNow: '相对当前', unixSeconds: 'Unix 秒', unixMilliseconds: 'Unix 毫秒', hexSeconds: 'HEX 秒', hexMilliseconds: 'HEX 毫秒', littleEndianSeconds: 'u32 小端字节序（秒）', invalidTimestamp: '无法解析的时间戳',
      toTimestamp: '日期时间 → 时间戳', timezoneAria: '日期解析时区', localZone: '本地时区', dateLabel: '选择或输入日期时间', millisLabel: '毫秒', invalidDate: '请输入有效的日期和 0–999 毫秒。', currentTime: '当前时刻', zeroMinute: '整分归零', fillLeft: '填入左侧解析器', selectValid: '请选择有效日期与毫秒',
      signedSeconds: '{value} 秒', signedMinutes: '{value} 分钟', signedHours: '{value} 小时', signedDays: '{value} 天', after: '{value} 后', before: '{value} 前', weekday: '星期{day}', weekdays: ['日', '一', '二', '三', '四', '五', '六']
    },
    inputTest: {
      title: '键鼠输入测试', subtitle: '全局键鼠事件捕获与 SendInput 注入自检', nativeStatus: '原生模块状态', loaded: '加载正常', loadFailed: '加载失败', available: '可用', unavailable: '不可用', expectedSize: '（x64 应为 40）',
      captureTitle: '全局事件捕获', startCapture: '开始捕获', stopCapture: '停止捕获', ignoreMoves: '忽略鼠标移动（只记录点击/按键）', total: '累计 {count} 个事件', capturingHint: '正在捕获全局键鼠，切到任意窗口按键盘试试', type: '类型', event: '事件', interval: '间隔',
      injectionTitle: '事件注入', injectionHint: '注入目标是当前拥有焦点的窗口。建议先打开一个记事本，再把本窗口摆在旁边点击按钮。', moveCursor: '移动光标', leftClick: '左键点击', rightClick: '右键点击', tapKey: '轻敲按键', injectText: '注入文本', typeText: '打字', up: '方向上', down: '方向下',
      pressed: '↓按下', released: '↑抬起', leftButton: '左键', rightButton: '右键', middleButton: '中键', move: '移动 ({x}, {y})', mouseAction: "{action} {button} {'@'}({x}, {y})", wheel: '滚轮 {direction} ({x}, {y})', wheelUp: '↑上', wheelDown: '↓下', rejected: '失败（SendInput 被拒绝）'
    },
    diffShell: { text: '文本对比', hex: '十六进制', folder: '文件夹', inaccessible: '路径不存在或无法访问' }
  },
  en: {
    extraCommon: { copied: 'Copied', clear: 'Clear', success: 'Succeeded', failed: 'Failed', error: 'Error: {error}' },
    endian: {
      title: 'Endianness Converter', subtitle: 'Parse, encode, and reverse 16 / 32 / 64-bit byte order', parseTitle: 'Parse byte sequence (multiple widths × byte order)',
      examples: { sequence: '01..08 sequence', float: 'Float32 example', register: '32-bit registers', negative: '-100 (two\'s complement)', wide: '64-bit example' },
      parseWidth: 'Parse width', allWidths: 'All widths', signedFloat: 'Signed / floating point', bytesAria: 'HEX byte sequence',
      bytesPlaceholder: 'Enter HEX bytes, e.g. 01 02 03 04 (spaces, commas, or continuous text)', normalize: 'Normalize spacing', reverseAll: 'Reverse all bytes',
      invalidHex: 'Invalid HEX format (length must be even)', byteOffsets: 'HEX byte offsets', firstBytes: 'First 64 bytes',
      interpretation: '{name} interpretation ({count})', interpretationAria: '{name} byte-order interpretation', offset: 'Offset', leHex: 'Little-endian HEX (LE)', leDec: 'Little-endian decimal', beHex: 'Big-endian HEX (BE)', beDec: 'Big-endian decimal', copyLe: 'Copy little-endian HEX', copyBe: 'Copy big-endian HEX', signed: 'Signed {value}',
      encodeTitle: 'Value → byte sequence', numberAria: 'Value to encode', numberPlaceholder: 'Decimal (negative two\'s complement supported) or 0x hexadecimal', invalidInteger: 'Enter a valid integer', bytes: 'bytes', lowBits: '· low {width} bits',
      swapTitle: 'Byte swap (16/32/64 bit)', swapPlaceholder: 'HEX value, e.g. 12345678', sendToParser: 'Send to parser above', swap: 'Swap u{width}', needDigits: 'Requires {count} hex digits'
    },
    timestamp: {
      title: 'Timestamp Converter', subtitle: 'Convert seconds, milliseconds, microseconds, nanoseconds, hexadecimal, and dates', syncNow: 'Sync current time', liveClock: 'Live Unix clock', paused: 'Paused', live: 'Live clock', seconds: 'Seconds', milliseconds: 'Milliseconds', local: 'Local', fillParser: 'Use in parser below', resume: 'Resume', pause: 'Pause',
      toDate: 'Timestamp → date and time', inputAria: 'Timestamp input', inputPlaceholder: 'Enter a timestamp or date string', currentSeconds: 'Current seconds', currentMilliseconds: 'Current milliseconds', hexExample: '0xHEX example', midnight: 'Today at midnight', minusDay: '−1 day', minusHour: '−1 hour', plusHour: '+1 hour', plusDay: '+1 day',
      localTime: 'Local time', relativeNow: 'Relative to now', unixSeconds: 'Unix seconds', unixMilliseconds: 'Unix milliseconds', hexSeconds: 'HEX seconds', hexMilliseconds: 'HEX milliseconds', littleEndianSeconds: 'u32 little-endian bytes (seconds)', invalidTimestamp: 'Could not parse the timestamp',
      toTimestamp: 'Date and time → timestamp', timezoneAria: 'Date parsing timezone', localZone: 'Local timezone', dateLabel: 'Choose or enter date and time', millisLabel: 'Milliseconds', invalidDate: 'Enter a valid date and 0–999 milliseconds.', currentTime: 'Current time', zeroMinute: 'Round down to minute', fillLeft: 'Use in parser on the left', selectValid: 'Choose a valid date and milliseconds',
      signedSeconds: '{value} seconds', signedMinutes: '{value} minutes', signedHours: '{value} hours', signedDays: '{value} days', after: 'in {value}', before: '{value} ago', weekday: '{day}', weekdays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    },
    inputTest: {
      title: 'Keyboard & Mouse Input Test', subtitle: 'Test global input capture and SendInput injection', nativeStatus: 'Native module status', loaded: 'Loaded', loadFailed: 'Failed to load', available: 'Available', unavailable: 'Unavailable', expectedSize: ' (expected 40 on x64)',
      captureTitle: 'Global event capture', startCapture: 'Start capture', stopCapture: 'Stop capture', ignoreMoves: 'Ignore mouse movement (record clicks and keys only)', total: '{count} events', capturingHint: 'Global keyboard and mouse capture is active. Switch to any window and try pressing keys.', type: 'Type', event: 'Event', interval: 'Interval',
      injectionTitle: 'Event injection', injectionHint: 'Input is sent to the window that currently has focus. Open a text editor and place it beside this window before using the buttons.', moveCursor: 'Move cursor', leftClick: 'Left click', rightClick: 'Right click', tapKey: 'Tap key', injectText: 'Inject text', typeText: 'Type', up: 'Arrow Up', down: 'Arrow Down',
      pressed: '↓Down', released: '↑Up', leftButton: 'Left button', rightButton: 'Right button', middleButton: 'Middle button', move: 'Move ({x}, {y})', mouseAction: "{action} {button} {'@'}({x}, {y})", wheel: 'Wheel {direction} ({x}, {y})', wheelUp: '↑Up', wheelDown: '↓Down', rejected: 'Failed (SendInput rejected the request)'
    },
    diffShell: { text: 'Text compare', hex: 'Hex', folder: 'Folders', inaccessible: 'The path does not exist or cannot be accessed' }
  }
} as const
