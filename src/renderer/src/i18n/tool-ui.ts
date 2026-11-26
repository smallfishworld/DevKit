export const toolUiMessages = {
  'zh-CN': {
    tools: {
      input: { name: '键鼠输入测试', description: '全局键鼠捕获与注入自检' },
      calc: { name: '程序员计算器', description: '进制转换 / 位运算 / 64 位 bit 编辑' },
      tftp: { name: 'TFTP 服务器', description: 'RFC1350 固件传输，支持多实例' },
      macro: { name: '键鼠宏', description: '录制回放界面操作，支持等待颜色' },
      serial: { name: '串口助手', description: '串口调试，HEX 收发与文件传输' },
      ssh: { name: 'SSH 终端', description: 'xterm + ssh2，密码或私钥认证' },
      localTerminal: { name: '本地终端', description: '本地 Shell 多实例 PTY 终端' },
      net: { name: '网络调试助手', description: 'TCP Server / Client / UDP 调试' },
      timestamp: { name: '时间戳转换', description: 'Unix 时间戳 ↔ 日期，自动识别单位' },
      encoding: { name: '编码转换', description: 'UTF-8 / GBK / Base64 / URL 互转' },
      endian: { name: '大小端转换', description: 'LE / BE 多宽度解释与字节交换' },
      diff: { name: '文本对比', description: '文本 / 文件夹 / 十六进制对比' },
      color: { name: '取色器', description: '截屏取色与坐标拾取' },
      bridge: { name: '串口TCP桥接', description: '8 通道串口 ⇄ TCP 透传' }
    },
    home: {
      title: '工具箱', subtitle: '选择连接会话或独立开发工具', searchAria: '搜索工具',
      searchPlaceholder: '搜索串口、SSH、时间戳…（回车打开）', slashHint: '按 / 快速聚焦搜索',
      recent: '最近会话', clear: '清空', history: '历史', latest: '最近', running: '运行中', opened: '已打开',
      switchTab: '点击切换到该标签', reopenSession: '点击重新打开会话', openTool: '点击打开工具',
      removeRecentAria: '移除最近会话 {title}', removeRecent: '从最近会话移除', pinned: '常用置顶',
      groups: { devices: '串口与设备调试', terminal: '终端与网络', data: '数据转换与计算', automation: '文本、屏幕与自动化' },
      planned: '「{name}」计划于 {phase} 阶段提供', openedTabs: '已打开 {count} 个标签', openBadge: '已开',
      unpin: '取消置顶', pinAria: '置顶常用 {name}', unpinAria: '取消置顶 {name}', pin: '置顶到常用',
      noMatch: '未找到匹配工具，请换个关键词或按 Esc 清空。', product: 'DevKit 嵌入式开发工具箱',
      toolCount: '{count} 个工具', sessionCount: '{count} 个会话', pinCount: '{count} 个置顶'
    },
    launcher: {
      aria: '快速打开工具', searchAria: '搜索工具或切换终端会话', searchPlaceholder: '搜索工具或切换终端会话…',
      listAria: '工具和会话', openSession: '已打开的会话', noMatch: '未找到匹配的工具',
      keyboardHint: '↑↓ 选择 · Enter 打开', close: '关闭'
    },
    connection: { connected: '已连接', connecting: '连接中', disconnected: '已断开' },
    converter: {
      copied: '已复制', bytes: '{count} 字节', unicodeEscape: 'Unicode 转义', tooLong: '（内容过长）',
      encodingTitle: '编码转换', encodingSubtitle: 'UTF-8 / GBK / UTF-16BE / Base64 / URL 实时互转',
      textToBytes: '文本 → 字节编码', textPlaceholder: '输入文本，下方实时显示各编码结果',
      hexToText: 'HEX 字节 → 文本', hexPlaceholder: '如 E5 B5 8C（空格/逗号/连续写法均可）',
      empty: '（空）', invalidHex: 'HEX 格式非法或长度不是偶数', encode: '编码', decode: '解码',
      base64Placeholder: '粘贴 Base64', invalidBase64: '（无效 Base64）', urlDecode: 'URL 编码还原', invalidEscape: '（无效转义）'
    },
    colorPicker: {
      hint: '请单击屏幕取色，右键或 Esc 取消', picked: '已取色 {color}', failed: '取色失败：{error}', copied: '已复制 {text}',
      title: '取色器', subtitle: '截屏取色与物理像素坐标拾取', screen: '屏幕取色', pick: '截屏取色',
      instructions: '取点窗口铺满光标所在屏幕：单击取色，右键 / Esc 取消；坐标为全局物理像素',
      history: '取色记录', empty: '还没有取过颜色'
    },
    history: {
      button: '历史日志', title: '磁盘历史日志', queryPlaceholder: '关键词（不区分大小写）', query: '查询',
      current: '当前会话', openFile: '打开日志文件', export: '导出当前会话', exported: '日志已导出', exportFailed: '导出失败',
      noPath: '当前会话暂无日志，可打开已有日志文件。', noMatches: '没有匹配记录。',
      noMatchesPage: '本段没有匹配记录，点击下一段继续查找。',
      scanHint: '每段最多扫描 1 MiB，显示 200 条；超长行按片段显示。已扫描至 {offset} / {size} 字节',
      previous: '上一段', next: '下一段', stalled: '日志历史游标没有继续前进，请检查文件是否发生变化',
      loading: '正在读取历史日志…', empty: '当前没有可浏览的历史日志', liveTip: '往下滚动回到实时串口 · Esc / End 返回实时打印'
    },
    updater: {
      title: 'DevKit 应用更新', currentVersion: '当前版本 v{version}', prompt: '点击下方按钮检查 GitHub 最新稳定版本。',
      available: '发现新版本 v{version}', ready: 'v{version} 已下载', publishing: '新版本正在发布，请稍后检查。', checking: '正在检查更新…',
      current: '当前已是最新版本。', preparing: '正在准备更新，完成后将重新启动 DevKit。', downloading: '正在下载更新…{percent}{speed}',
      notesTitle: 'v{version} 更新内容', noNotes: '此版本未提供更新说明。', releaseNotes: '在 GitHub 查看发布说明', progress: '更新包下载进度',
      mirror: '经镜像 {source} 加速', restartNote: '重启会结束当前的串口、SSH 和传输会话。',
      checkOnly: '当前运行环境仅支持检查版本，请前往 GitHub Releases 下载对应安装包。',
      background: '后台下载', later: '稍后', close: '关闭', backgroundHint: '关闭此窗口，下载在后台继续；完成后可从这里重启更新',
      save: '另存更新包', restart: '重启并更新', download: '下载更新', githubDownload: '前往 GitHub 下载', check: '检查更新', invokeFailed: '无法执行更新操作，请重试。',
      messages: {
        UPDATE_RATE_LIMITED: 'GitHub 请求频率受限，请稍后再试。', UPDATE_CHECK_FAILED: '检查更新失败，请稍后重试。',
        UPDATE_DOWNLOAD_FAILED: '下载更新失败，请重试。', UPDATE_VERIFY_FAILED: '更新包校验失败，请重新下载。',
        UPDATE_PREPARE_FAILED: '准备更新失败，请重试或另存更新包。', UPDATE_SAVED: '更新包已保存。',
        UPDATE_SAVE_FAILED: '保存更新包失败。', UPDATE_APPLY_FAILED: '上次更新未完成，可重试或另存更新包。',
        UPDATE_APPLY_LOCKED: '上次更新未完成：程序目录被其他程序占用。关闭相关窗口或程序后可重试，或另存更新包。'
      }
    },
    terminal: {
      search: '查找…', noResults: '无结果', previousMatch: '上一个（Shift+Enter）', nextMatch: '下一个（Enter）', closeSearch: '关闭（Esc）',
      terminal: '终端', workingDirectory: '工作目录', defaultHome: '默认使用用户主目录', chooseDirectory: '选择工作目录',
      start: '启动', switchShell: '切换终端', restart: '重启', stop: '终止', stopped: '已停止', running: '运行中 · {name}',
      unavailableGitBash: '未检测到 Git for Windows / Git Bash', unavailableShell: '所选 Shell 不可用', unknownError: '未知错误',
      startFailed: '终端启动失败：{error}', exited: '进程已退出，代码 {code}', noShell: '当前系统没有检测到可用的 Windows Shell。',
      resizeCommands: '拖动调整快捷命令栏宽度', collapseCommands: '折叠快捷命令栏', expandCommands: '展开快捷命令栏',
      find: '查找', findTitle: '查找（Ctrl+F）', clear: '清屏', display: '显示设置',
      sendTo: '发送到', sendToHint: '快捷命令发送到当前选中的终端（点进哪个终端就发给哪个）', resize: '拖动调整宽度'
    },
    quickCmd: {
      title: '快捷命令', loadPluginsFailed: '无法读取插件动作', groupRequired: '请输入分组名', groupExists: '分组「{name}」已存在',
      groupCreated: '分组「{name}」已创建，可点组内 + 添加命令', invalidName: '名称无效或已存在', renamed: '分组已重命名',
      required: '名称与至少一个步骤必填', choosePlugin: '请选择插件配置与动作', updated: '已更新', added: '已添加',
      recording: '录制中：直接在终端输入命令或按键；再点录制键停止并保存', recordingEmpty: '未录到任何内容，已取消录制',
      disconnected: '连接未打开', connectionChanged: '连接已变化，请重新运行快捷命令', runFailed: '快捷命令执行失败',
      exported: '已导出 {count} 条快捷命令', imported: '已从{source}导入 {count} 条（同名已覆盖）', devkitConfig: 'DevKit 配置',
      stopRecording: '停止录制并整理保存', startRecording: '录制宏：终端键入与发送都会记入（含自动延时与按键）',
      newAria: '新建快捷命令', menuAria: '快捷命令分组与导入导出', newGroup: '新建分组…', import: '导入命令…', export: '导出命令…'
    },
    sshPanel: {
      disconnectedError: 'SSH 已断开：{error}', closed: '连接已关闭', error: 'SSH 错误：{error}',
      ready: '就绪。填写主机信息后点击「连接」，终端内直接输入命令。', hostRequired: '请填写主机地址', connected: '已连接 {user}@{host}:{port}', connectFailed: '连接失败：{error}', disconnected: '已断开',
      logSaved: '日志已保存', logSaveFailed: '存日志失败：{error}', logDirectory: '日志保存目录已设为：{dir}（新会话生效）', hostFirst: '请先填写主机', presetSaved: '预设「{name}」已保存',
      hostPlaceholder: '主机 IP 或主机名', username: '用户名', password: '密码', key: '私钥', keyPath: '私钥文件路径', connect: '连接', disconnect: '断开', preset: '套用已存预设', savePreset: '存为预设', presetName: '预设名', save: '保存', cancel: '取消', confirm: '确认',
      logSettings: '日志设置', saveLog: '保存日志', keepLog: '保留日志', setLogPath: '设置保存路径', openLogPath: '打开保存路径', timestamp: '时间戳'
    }
  },
  en: {
    tools: {
      input: { name: 'Input Tester', description: 'Test global mouse/keyboard capture and injection' },
      calc: { name: 'Programmer Calculator', description: 'Base conversion, bit operations, and 64-bit editing' },
      tftp: { name: 'TFTP Server', description: 'Multi-instance RFC 1350 firmware transfer' },
      macro: { name: 'Input Macro', description: 'Record and replay UI actions with color waits' },
      serial: { name: 'Serial Terminal', description: 'Serial debugging, HEX I/O, and file transfer' },
      ssh: { name: 'SSH Terminal', description: 'xterm + ssh2 with password or private-key authentication' },
      localTerminal: { name: 'Local Terminal', description: 'Multi-instance local Shell PTY terminal' },
      net: { name: 'Network Assistant', description: 'TCP server, TCP client, and UDP debugging' },
      timestamp: { name: 'Timestamp Converter', description: 'Unix timestamp ↔ date with automatic unit detection' },
      encoding: { name: 'Encoding Converter', description: 'Convert UTF-8, GBK, Base64, and URL encoding' },
      endian: { name: 'Endian Converter', description: 'Interpret LE/BE values and swap bytes at multiple widths' },
      diff: { name: 'Compare', description: 'Compare text, folders, and hexadecimal data' },
      color: { name: 'Color Picker', description: 'Pick screen colors and coordinates' },
      bridge: { name: 'Serial–TCP Bridge', description: 'Eight-channel serial ⇄ TCP passthrough' }
    },
    home: {
      title: 'Toolbox', subtitle: 'Choose a connection session or standalone development tool', searchAria: 'Search tools',
      searchPlaceholder: 'Search serial, SSH, timestamp… (Enter to open)', slashHint: 'Press / to focus search',
      recent: 'Recent sessions', clear: 'Clear', history: 'History', latest: 'Recent', running: 'Running', opened: 'Open',
      switchTab: 'Switch to this tab', reopenSession: 'Reopen this session', openTool: 'Open this tool',
      removeRecentAria: 'Remove recent session {title}', removeRecent: 'Remove from recent sessions', pinned: 'Pinned',
      groups: { devices: 'Serial & device debugging', terminal: 'Terminals & networking', data: 'Data conversion & calculation', automation: 'Text, screen & automation' },
      planned: '“{name}” is planned for phase {phase}', openedTabs: '{count} open tabs', openBadge: 'Open',
      unpin: 'Unpin', pinAria: 'Pin {name}', unpinAria: 'Unpin {name}', pin: 'Pin to favorites',
      noMatch: 'No matching tools. Try another keyword or press Esc to clear.', product: 'DevKit Embedded Development Toolbox',
      toolCount: '{count} tools', sessionCount: '{count} sessions', pinCount: '{count} pinned'
    },
    launcher: {
      aria: 'Quick open tools', searchAria: 'Search tools or switch terminal sessions', searchPlaceholder: 'Search tools or switch terminal sessions…',
      listAria: 'Tools and sessions', openSession: 'Open session', noMatch: 'No matching tools',
      keyboardHint: '↑↓ Select · Enter Open', close: 'Close'
    },
    connection: { connected: 'Connected', connecting: 'Connecting', disconnected: 'Disconnected' },
    converter: {
      copied: 'Copied', bytes: '{count} bytes', unicodeEscape: 'Unicode escape', tooLong: '(content too long)',
      encodingTitle: 'Encoding Converter', encodingSubtitle: 'Live UTF-8 / GBK / UTF-16BE / Base64 / URL conversion',
      textToBytes: 'Text → encoded bytes', textPlaceholder: 'Enter text to see each encoding below',
      hexToText: 'HEX bytes → text', hexPlaceholder: 'For example E5 B5 8C (spaces, commas, or contiguous text)',
      empty: '(empty)', invalidHex: 'Invalid HEX or an odd number of digits', encode: 'Encode', decode: 'Decode',
      base64Placeholder: 'Paste Base64', invalidBase64: '(invalid Base64)', urlDecode: 'URL decoding', invalidEscape: '(invalid escape sequence)'
    },
    colorPicker: {
      hint: 'Click the screen to pick a color; right-click or press Esc to cancel', picked: 'Picked {color}', failed: 'Color pick failed: {error}', copied: 'Copied {text}',
      title: 'Color Picker', subtitle: 'Pick screen colors and physical pixel coordinates', screen: 'Screen color', pick: 'Pick from screen',
      instructions: 'The picker covers the screen under the pointer. Click to pick; right-click or press Esc to cancel. Coordinates are global physical pixels.',
      history: 'Picked colors', empty: 'No colors picked yet'
    },
    history: {
      button: 'History', title: 'On-disk history', queryPlaceholder: 'Keyword (case-insensitive)', query: 'Search',
      current: 'Current session', openFile: 'Open log file', export: 'Export current session', exported: 'Log exported', exportFailed: 'Export failed',
      noPath: 'This session has no log yet. You can open an existing log file.', noMatches: 'No matching records.',
      noMatchesPage: 'No matches in this segment. Continue with the next segment.',
      scanHint: 'Scans up to 1 MiB per segment and shows 200 records; long lines are split. Scanned {offset} / {size} bytes',
      previous: 'Previous', next: 'Next', stalled: 'The history cursor did not advance; check whether the file changed',
      loading: 'Reading history…', empty: 'No history is available', liveTip: 'Scroll down to return to live serial output · Esc / End returns to live output'
    },
    updater: {
      title: 'DevKit Application Update', currentVersion: 'Current version v{version}', prompt: 'Check GitHub for the latest stable release.',
      available: 'Version v{version} is available', ready: 'v{version} has been downloaded', publishing: 'A new version is being published. Check again shortly.', checking: 'Checking for updates…',
      current: 'You are running the latest version.', preparing: 'Preparing the update. DevKit will restart when ready.', downloading: 'Downloading update…{percent}{speed}',
      notesTitle: 'What’s new in v{version}', noNotes: 'No release notes were provided.', releaseNotes: 'View release notes on GitHub', progress: 'Update package download progress',
      mirror: 'Accelerated via mirror {source}', restartNote: 'Restarting will end current serial, SSH, and transfer sessions.',
      checkOnly: 'This environment can only check versions. Download the appropriate package from GitHub Releases.',
      background: 'Download in background', later: 'Later', close: 'Close', backgroundHint: 'Close this window to keep downloading in the background; return here to restart and update when complete',
      save: 'Save update package', restart: 'Restart and update', download: 'Download update', githubDownload: 'Download from GitHub', check: 'Check for updates', invokeFailed: 'The update action could not be completed. Try again.',
      messages: {
        UPDATE_RATE_LIMITED: 'GitHub rate-limited the request. Try again later.', UPDATE_CHECK_FAILED: 'Could not check for updates. Try again later.',
        UPDATE_DOWNLOAD_FAILED: 'The update download failed. Try again.', UPDATE_VERIFY_FAILED: 'The update package failed verification. Download it again.',
        UPDATE_PREPARE_FAILED: 'Could not prepare the update. Try again or save the package.', UPDATE_SAVED: 'The update package was saved.',
        UPDATE_SAVE_FAILED: 'Could not save the update package.', UPDATE_APPLY_FAILED: 'The last update did not finish. Try again or save the package.',
        UPDATE_APPLY_LOCKED: 'The last update did not finish because another program was using the application folder. Close related windows or programs and try again, or save the update package.'
      }
    },
    terminal: {
      search: 'Find…', noResults: 'No results', previousMatch: 'Previous (Shift+Enter)', nextMatch: 'Next (Enter)', closeSearch: 'Close (Esc)',
      terminal: 'Terminal', workingDirectory: 'Working directory', defaultHome: 'Use the user home directory by default', chooseDirectory: 'Choose working directory',
      start: 'Start', switchShell: 'Switch shell', restart: 'Restart', stop: 'Terminate', stopped: 'Stopped', running: 'Running · {name}',
      unavailableGitBash: 'Git for Windows / Git Bash was not detected', unavailableShell: 'The selected shell is unavailable', unknownError: 'Unknown error',
      startFailed: 'Terminal failed to start: {error}', exited: 'Process exited with code {code}', noShell: 'No supported Windows shell was detected.',
      resizeCommands: 'Drag to resize quick commands', collapseCommands: 'Collapse quick commands', expandCommands: 'Expand quick commands',
      find: 'Find', findTitle: 'Find (Ctrl+F)', clear: 'Clear', display: 'Display settings',
      sendTo: 'Send to', sendToHint: 'Quick commands are sent to the selected terminal', resize: 'Drag to resize'
    },
    quickCmd: {
      title: 'Quick commands', loadPluginsFailed: 'Could not load plugin actions', groupRequired: 'Enter a group name', groupExists: 'Group “{name}” already exists',
      groupCreated: 'Group “{name}” was created; use + inside it to add a command', invalidName: 'The name is invalid or already exists', renamed: 'Group renamed',
      required: 'A name and at least one step are required', choosePlugin: 'Choose a plugin configuration and action', updated: 'Updated', added: 'Added',
      recording: 'Recording: type commands or keys in the terminal; click Record again to stop and save', recordingEmpty: 'Nothing was recorded; recording cancelled',
      disconnected: 'The connection is not open', connectionChanged: 'The connection changed; run the quick command again', runFailed: 'Quick command failed',
      exported: 'Exported {count} quick commands', imported: 'Imported {count} commands from {source} (same-name commands replaced)', devkitConfig: 'DevKit configuration',
      stopRecording: 'Stop recording and review', startRecording: 'Record terminal typing and sends, including automatic delays and keys',
      newAria: 'New quick command', menuAria: 'Quick-command groups, import, and export', newGroup: 'New group…', import: 'Import commands…', export: 'Export commands…'
    },
    sshPanel: {
      disconnectedError: 'SSH disconnected: {error}', closed: 'Connection closed', error: 'SSH error: {error}',
      ready: 'Ready. Enter host details and connect; type commands directly in the terminal.', hostRequired: 'Enter a host address', connected: 'Connected to {user}@{host}:{port}', connectFailed: 'Connection failed: {error}', disconnected: 'Disconnected',
      logSaved: 'Log saved', logSaveFailed: 'Could not save log: {error}', logDirectory: 'Log directory set to {dir} (applies to new sessions)', hostFirst: 'Enter a host first', presetSaved: 'Preset “{name}” saved',
      hostPlaceholder: 'Host IP or name', username: 'Username', password: 'Password', key: 'Private key', keyPath: 'Private-key file path', connect: 'Connect', disconnect: 'Disconnect', preset: 'Apply a saved preset', savePreset: 'Save as preset', presetName: 'Preset name', save: 'Save', cancel: 'Cancel', confirm: 'Confirm',
      logSettings: 'Log settings', saveLog: 'Save log', keepLog: 'Keep logs', setLogPath: 'Set save location', openLogPath: 'Open save location', timestamp: 'Timestamps'
    }
  }
} as const
