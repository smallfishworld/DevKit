export type ThemeMode = 'dark' | 'light'

export interface UiThemeColors {
  primary: string
  success: string
  warning: string
  danger: string
  info: string
  background: string
  backgroundPage: string
  surface: string
  fill: string
  fillLight: string
  fillDark: string
  textPrimary: string
  textRegular: string
  textSecondary: string
  textPlaceholder: string
  border: string
  borderLight: string
  borderLighter: string
  diffChangeRow: string
  diffChangeSegment: string
  diffOrphanRow: string
  diffOnlyLeft: string
  diffOnlyRight: string
  diffDiffer: string
  diffIdentical: string
  diffDirectory: string
  diffIgnored: string
}

export interface UiTheme {
  id: string
  name: string
  mode: ThemeMode
  colors: UiThemeColors
}

export interface AnsiPalette {
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export interface TerminalTheme {
  id: string
  name: string
  author?: string
  builtin?: boolean
  foreground: string
  background: string
  cursor: string
  cursorAccent?: string
  selectionBackground: string
  selectionForeground?: string
  ansi: AnsiPalette
}

export interface AppearanceSettings {
  uiTheme: string
  terminalTheme: string
  followSystem: boolean
}

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  uiTheme: 'devkit-dark',
  terminalTheme: 'devkit-default',
  followSystem: false
}

/** 由终端主题推导出的「面板 chrome」色板：让串口/SSH/本地终端等面板内部的
 *  控件（工具栏、按钮、输入框、状态区）跟随各自面板的终端主题变色（VS Code 风格）。
 *  纯函数：同输入恒同输出，不放任何全局状态。 */
export interface TermPanelPalette {
  mode: ThemeMode
  /** 面板整体背景（取终端背景色） */
  bg: string
  /** 次级面板块（工具栏 .panel-section）背景 */
  surface: string
  /** 输入框/普通按钮填充 */
  fill: string
  /** 悬停填充 */
  fillHover: string
  border: string
  borderLight: string
  textPrimary: string
  textRegular: string
  textSecondary: string
  textPlaceholder: string
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** 相对亮度（sRGB 线性化），用于判断主题明暗与做相对明/暗步进 */
export function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex)
  if (!rgb) return 0
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function clamp255(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)))
}

/** 在 hex 原色上按比例混入 target（0..1）的淡色 */
function mixHex(base: string, target: string, t: number): string {
  const b = hexToRgb(base)
  const tgt = hexToRgb(target)
  if (!b || !tgt) return target
  const [br, bg, bb] = b
  const [tr, tg, tb] = tgt
  return (
    '#' +
    [clamp255(br + (tr - br) * t), clamp255(bg + (tg - bg) * t), clamp255(bb + (tb - bb) * t)]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
  )
}

/** 相对变亮/变暗（按亮度线性步进，深浅主题都可用）。amount>0 向白，<0 向黑 */
function shadeHex(hex: string, amount: number): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  return mixHex(hex, amount >= 0 ? '#ffffff' : '#000000', Math.abs(amount))
}

export function termPanelPalette(theme: TerminalTheme): TermPanelPalette {
  const bg = theme.background || '#101418'
  const fg = theme.foreground || '#cfd8dc'
  const isLight = relativeLuminance(bg) > 0.5
  // light 主题：面板块更亮、填充更灰更深；dark 主题：面板块更亮、填充更暗
  const surface = isLight ? shadeHex(bg, 0.045) : shadeHex(bg, 0.09)
  const fill = isLight ? shadeHex(bg, -0.04) : shadeHex(bg, 0.05)
  const fillHover = isLight ? shadeHex(bg, -0.09) : shadeHex(bg, 0.1)
  return {
    mode: isLight ? 'light' : 'dark',
    bg,
    surface,
    fill,
    fillHover,
    border: isLight ? shadeHex(fg, -0.45) : mixHex(fg, bg, 0.72),
    borderLight: isLight ? shadeHex(fg, -0.3) : mixHex(fg, bg, 0.82),
    textPrimary: fg,
    textRegular: mixHex(fg, bg, 0.32),
    textSecondary: mixHex(fg, bg, 0.58),
    textPlaceholder: mixHex(fg, bg, 0.72)
  }
}

/** 把面板色板写成 --dk-* 语义变量值映射（供渲染端 setProperty 用） */
export function termPanelPaletteVars(palette: TermPanelPalette): Record<string, string> {
  return {
    '--dk-bg': palette.bg,
    '--dk-bg-page': palette.surface,
    '--dk-surface': palette.surface,
    '--dk-fill': palette.fill,
    '--dk-fill-light': palette.surface,
    '--dk-fill-dark': palette.fillHover,
    '--dk-text-primary': palette.textPrimary,
    '--dk-text-regular': palette.textRegular,
    '--dk-text-secondary': palette.textSecondary,
    '--dk-text-placeholder': palette.textPlaceholder,
    '--dk-border': palette.border,
    '--dk-border-light': palette.borderLight,
    '--dk-border-lighter': palette.borderLight
  }
}

/** 由终端主题派生「全 App 界面主题」：选定的终端主题成为唯一配色来源，
 *  主界面、所有工具页、按钮、边框、弹层、diff 视图全部用它衍生的颜色。
 *  纯函数：同输入恒同输出。复用 termPanelPalette 的 mixHex/shadeHex 派生范式，
 *  但补全 termPanelPalette 缺失的状态色（primary/success/…/info）与整套 diff 键，
 *  并把暗主题边框对比度调高（termPanelPalette 的 0.72 混入后退化成于背景难辨）。 */
export function uiThemeFromTerminal(theme: TerminalTheme): UiTheme {
  const bg = theme.background || '#101418'
  const fg = theme.foreground || '#cfd8dc'
  const isLight = relativeLuminance(bg) > 0.5
  const mode: ThemeMode = isLight ? 'light' : 'dark'
  const a = theme.ansi

  // 状态色：亮背景用普通 ansi，暗背景用亮 ansi 提升可读性与饱和度
  const pick = (dim: string, bright: string): string => (isLight ? dim : bright)
  const primary = pick(a.blue, a.brightBlue)
  const success = pick(a.green, a.brightGreen)
  const warning = pick(a.yellow, a.brightYellow)
  const danger = pick(a.red, a.brightRed)
  const info = pick(a.cyan, a.brightCyan)

  // 面板块 / 填充：暗主题向白走，亮主题同向深
  const surface = isLight ? shadeHex(bg, 0.02) : shadeHex(bg, 0.06)
  const fill = isLight ? shadeHex(bg, -0.04) : shadeHex(bg, 0.05)
  const fillLight = isLight ? shadeHex(bg, -0.02) : shadeHex(bg, 0.035)
  const fillDark = isLight ? shadeHex(bg, -0.06) : shadeHex(bg, 0.08)

  // 文本层次：前景为主，逐级混向背景作弱化
  const textPrimary = fg
  const textRegular = mixHex(fg, bg, 0.08)
  const textSecondary = mixHex(fg, bg, 0.4)
  const textPlaceholder = mixHex(fg, bg, 0.6)

  // 边框：暗主题取 fg 五成，保证与背景可辨（修正旧 0.72 近背景问题）；
  // 亮主题前景偏暗、背景偏亮，同一公式对称成立
  const border = mixHex(fg, bg, 0.5)
  const borderLight = mixHex(fg, bg, 0.62)
  const borderLighter = mixHex(fg, bg, 0.72)

  return {
    id: `term-${theme.id}`,
    name: theme.name,
    mode,
    colors: {
      primary,
      success,
      warning,
      danger,
      info,
      background: bg,
      backgroundPage: isLight ? shadeHex(bg, -0.03) : shadeHex(bg, 0.03),
      surface,
      fill,
      fillLight,
      fillDark,
      textPrimary,
      textRegular,
      textSecondary,
      textPlaceholder,
      border,
      borderLight,
      borderLighter,
      diffChangeRow: mixHex(danger, bg, 0.86),
      diffChangeSegment: mixHex(danger, bg, 0.65),
      diffOrphanRow: mixHex(success, bg, 0.85),
      diffOnlyLeft: primary,
      diffOnlyRight: warning,
      diffDiffer: pick(a.magenta, a.brightMagenta),
      diffIdentical: textSecondary,
      diffDirectory: success,
      diffIgnored: textPlaceholder
    }
  }
}
