# DevKit Embedded Development Suite

**Language:** **English** | [简体中文](README.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows-blue) ![Stack](https://img.shields.io/badge/Electron%20%2B%20Vue3%20%2B%20TS-44.x-green)

DevKit is an all-in-one desktop toolbox built for embedded software development (Windows, Electron + Vue 3 + TypeScript). It brings everyday debugging utilities into a single tabbed workbench with two signature capabilities: a **Mouse & Keyboard Macro Recorder** to automate repetitive UI tasks, and **Terminal Quick-Command Macros** — a multi-step command library shared across the Serial and SSH terminals with in-terminal recording, grouping, and one-click playback.

DevKit supports **Simplified Chinese (`zh-CN`, default)** and **English (`en`)** in **Settings**. Switching languages takes effect immediately across all built-in tools and native dialogs without reloading the workbench or interrupting active serial, SSH, local terminal, network, or file transfer sessions.

## Built-in Tools

| Tool | Description |
|---|---|
| **Input Macro** | Global recording/playback, step editor, macro library, global hotkeys, wait-for-color synchronization, and screen color/coordinate picker |
| **Terminal Quick-Command Macros** | Multi-step command library shared by Serial and SSH terminals: ASCII/HEX commands, delays, and key presses; popup-free in-terminal recording, groups, drag reordering, one-click playback, and MobaXterm macro import |
| **Serial Terminal** | xterm.js emulation (ANSI color, VT100, direct typing), connection presets, YMODEM/ZMODEM file transfer, periodic loop send, DTR/RTS controls, and automatic disk logging |
| **SSH Terminal** | xterm.js + ssh2 with password or private-key authentication, connection presets, PTY resize sync (`vim`/`top`), and automatic disk logging |
| **Local Terminal** | Multi-instance Windows local shell PTY terminal (PowerShell / CMD / Git Bash) |
| **Serial–TCP Bridge** | 8-channel serial ⇄ TCP passthrough with shared serial format, multi-client support, and remote management mode |
| **TFTP Server** | Multi-instance RFC 1350 server with `blksize`/`timeout`/`tsize` extensions, per-interface binding, and transfer history |
| **Programmer Calculator** | Bitwise expression evaluator, synchronized HEX/DEC/OCT/BIN views, interactive 64-bit editor, and big/little-endian byte layout |
| **Network Assistant** | TCP Server (multi-client), TCP Client, and UDP debugging with ASCII/HEX views and periodic loop send |
| **Compare** | Side-by-side and inline text diff, hex diff, and two-pane folder comparison/sync with multi-encoding support |
| **Timestamp Converter** | Automatic unit detection across seconds, milliseconds, microseconds, nanoseconds, `0xHEX`, and date strings |
| **Encoding Converter** | Live conversion between UTF-8, GBK, UTF-16BE, Unicode escapes, Base64, and URL encoding |
| **Endian Converter** | Multi-width (u16/u32/u64) LE/BE interpretation, signed/float decoding, and byte swapping |
| **Color Picker** | Full-screen pixel picker with magnifier, physical-pixel multi-monitor/DPI coordinates, and one-click HEX/RGB copy |
| **Input Tester** | Global input capture and `SendInput` injection self-test (visible in dev mode only) |

The window uses a VS Code–style frameless title bar: drag anywhere on the bar to move the window, or click the DevKit icon in the top-left corner to view version details (Electron / Chromium / Node.js) and check for updates.

## Quick Start

### Run from Source

```bash
npm install
npm run dev
```

> npm 11 no longer reads `electron_mirror` from `.npmrc`. If Electron binary downloads are slow or fail in your region, run:
>
> ```bash
> ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" npm install
> ```

### Build Packages (Portable EXE + ZIP + Unpacked Directory)

```bash
npm run dist:dir   # Unpacked folder → release/win-unpacked/DevKit.exe
npm run dist:zip   # ZIP archive → release/DevKit-win-x64.zip
npm run dist       # Build portable EXE, ZIP archive, and unpacked folder together
```

Release artifact naming (version numbers are omitted from filenames so extracted folder names stay stable across upgrades):

- `DevKit-portable.exe`: Single-file portable executable — download and run directly.
- `DevKit-win-x64.zip`: Windows x64 ZIP package — extract and run `DevKit.exe` (recommended for long-term use).

### In-App Updates

Windows x64 release builds check official GitHub Releases in the background on startup, and you can also check manually from the title bar. When a new version is available, review the bilingual release notes and download it in place. After downloading, choose **Restart and update** or **Later** (restarting closes active serial, SSH, and transfer sessions).

The ZIP build updates in place inside its existing folder while preserving user-added files (such as shortcuts or documentation folders). If any file is locked by another program or collides with a new release file, DevKit lists the affected entries before restarting so you can resolve them and retry without manual extraction.

Downloads test direct GitHub speed first and fall back to an acceleration mirror only when direct speed is slow (the mirror host is shown in the UI). Every download is verified against the official SHA-256 digest and supports resumable downloads. You can override the built-in mirror list in `config.json` (replaces defaults when non-empty; takes effect after restart):

```json
{ "updates": { "mirrors": ["https://gh-proxy.com/", "https://ghfast.top/"] } }
```

User settings, installed plugins, and logs live in the DevKit user-data directory and are preserved across upgrades. If a power failure occurs during a ZIP swap, the sibling `.devkit-backup-*` folder can be used to launch the previous version.

### Application Icon & Taskbar Notes

DevKit uses the blue-violet gradient **DK Monogram** icon across the title bar, EXE, native windows, and plugin sign-in dialogs. See [resources/branding/README.md](resources/branding/README.md) for branding asset details.

If Windows still displays an older taskbar icon after upgrading:
1. Verify the downloaded release artifact and launched executable path; close any older running instance first.
2. Keep the ZIP edition in a fixed directory so existing shortcuts do not point to an older copy.
3. Unpin and re-pin the taskbar shortcut if the old pinned item still references a previous binary.

### Packaging Dependencies & Native Modules

No code-signing certificate is bundled; on first launch Windows SmartScreen may prompt — choose **More info → Run anyway**.

Native modules (`serialport`, `uiohook-napi`, `koffi`) ship prebuilt N-API binaries, so no `node-gyp` rebuild is required (`npmRebuild: false`).

## Input Macro Highlights

- Global hotkeys: `F9` start/stop recording, `F10` replay current macro, `F11` emergency stop (configurable in Macro Settings; conflicts are reported).
- Own hotkeys are suppressed while recording by default, and mouse movements are ignored by default.
- Edit delays, toggle individual steps or segments, and insert **Delay**, **Text**, or **Wait Color** steps.
- **Wait Color**: waits for a target color to appear or disappear at a physical pixel coordinate (with configurable tolerance and timeout).
- **Screen Picker**: full-screen overlay with magnifier and physical-pixel multi-monitor / DPI coordinates (click to pick, right-click or `Esc` to cancel).
- Macros are stored as readable JSON under `%APPDATA%/dev-kit/macros/`, support import/export, 0.1×–10× playback speed, loop counts (`0` = infinite), and per-macro global hotkeys.
- ⚠️ Macro files store typed keystrokes — **never type passwords while recording**.

## Terminal Quick-Command Macros

Serial Terminal and SSH Terminal share the same command library and recording state.

- **Step sequences**: combine ASCII/HEX commands (with optional newline), delays, and special keys (`Enter`, `Esc`, `Tab`, `Ctrl+C`, arrows, `F1`–`F12`).
- **In-terminal recording**: click Record and type or send commands normally; pauses ≥ 500 ms become delay steps, and special keys are captured automatically.
- **Groups & drag-and-drop**: organize commands into groups, drag to reorder or move across groups, and duplicate with one click.
- **Import / Export**: export as DevKit JSON; import DevKit JSON or **MobaXterm macro files** (`.mxtmacros` / `.ini`, GBK encoding).

## Device Plugins

Use the global **Extension Center** to install trusted JavaScript plugins, manage HTTPS extension sources, and create configuration instances. Bind instances to Serial, SSH, or Network sessions according to each plugin's declared transports to run manual actions or automatic responses. Plugins target the shared `@devkit/plugin-sdk` (API v2).

- Serial URL relay plugin (external repository): [DevKit-Plugins/plugins/serial-url-relay](https://github.com/smallfishworld/DevKit-Plugins/tree/main/plugins/serial-url-relay)
- Text/HEX auto-responder example: `examples/plugins/text-hex-responder/`
- Starter template: `examples/plugins/template/`
- Pack a single-file JSON plugin bundle: `npm run plugin:pack -- examples/plugins/text-hex-responder /tmp/text-responder.json`
- Plugin guide: [docs/device-plugins.md](docs/device-plugins.md)

External plugins run in an isolated `utilityProcess` while the host manages underlying transport streams. Process isolation is **not** a file/network security sandbox — install only trusted code.

## Serial Terminal Highlights

- Powered by `xterm.js` with WebGL rendering (automatic DOM fallback), ANSI color, VT100 control sequences, and `Ctrl+F` search.
- **Copy & paste**: select text and left-click to copy; right-click inside the terminal to paste immediately.
- **Direct keyboard input**: type directly in the terminal, enable **Local echo** for non-echoing devices, and use standard control keys (`Ctrl+C`, `Ctrl+Z`, `Ctrl+D`, `Ctrl+\`, `Ctrl+U`, `Ctrl+L`).
- **Continuous background logging**: prevents idle sleep while connected, keeps a 200k-line scrollback buffer, and writes timestamped RX/TX logs to `%APPDATA%/dev-kit/serial-logs/<PORT>-<DATE>.log`.
- **DTR/RTS & signals**: one-click DTR/RTS toggles and 2-second CTS/DSR/DCD polling.
- **YMODEM / ZMODEM file transfer**: send (`ry`/`rz` on device) or receive (`sy`/`sz` on device) with live progress and cancellation.

## SSH Terminal Highlights

- Shares the same `xterm.js` terminal component, search bar, font/zoom controls, and quick-command library as Serial Terminal.
- Supports password, private-key (OpenSSH PEM), and keyboard-interactive authentication with automatic PTY resize sync and automatic logging under `%APPDATA%/dev-kit/ssh-logs/`.
- ⚠️ Preset passwords are stored in plain text in local `config.json` — do not store production passwords.

## Configuration & Data Paths

- Global config: `%APPDATA%/dev-kit/config.json`
- Macro library: `%APPDATA%/dev-kit/macros/*.json`
- Serial auto-logs: `%APPDATA%/dev-kit/serial-logs/`
- SSH auto-logs: `%APPDATA%/dev-kit/ssh-logs/`
- Default TFTP root: `Documents/DevKit-TFTP/`

If devices cannot reach the TFTP server on Windows, allow UDP port 69 in Windows Firewall (as Administrator):

```
netsh advfirewall firewall add rule name="DevKit-TFTP" dir=in action=allow protocol=UDP localport=69
```

## Project Structure

```
src/
├── main/                 # Electron main process (IPC, locale, and tool services)
├── preload/              # contextBridge window.api
├── renderer/
│   └── src/
│       ├── components/   # Shared workbench, terminal, diff, and plugin UI components
│       ├── composables/  # Shared composables (quick-command macros, detached tabs, etc.)
│       ├── i18n/         # zh-CN / en localization message catalogs
│       ├── panels/       # Built-in tool panels (Vue 3 + Element Plus)
│       ├── stores/       # Pinia stores (tabs, locale, appearance, plugins)
│       └── tools/        # Tool registry and calculator engine
└── shared/               # Shared types, locale helpers, and pure logic
tests/                    # Unit tests (run sequentially by npm test)
openspec/specs/           # Verified capability specifications (OpenSpec)
docs/                     # Architecture, plugin guide, and bilingual release notes template
```

## Development, Testing & Releases

```bash
npm run typecheck   # Node + Web TypeScript checks
npm test            # Full unit test suite
```

Release notes follow the bilingual template in [docs/release-notes-template.md](docs/release-notes-template.md): each GitHub Release includes both Chinese and English sections followed by a single `## 下载` section whose bilingual download table is bounded by `<!-- devkit:download-table:start -->` and `<!-- devkit:download-table:end -->` markers so CI updates only the table without overwriting release notes.

## Contributing

Issues and pull requests are welcome. Please make sure `npm run typecheck` and `npm test` pass before submitting changes.

## License

[MIT](LICENSE) © 2026 smallfishworld
