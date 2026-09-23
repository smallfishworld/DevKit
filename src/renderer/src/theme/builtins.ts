import type { TerminalTheme, UiTheme } from '../../../shared/theme'

export const BUILTIN_UI_THEMES: UiTheme[] = [
  {
    id: 'devkit-dark',
    name: 'DevKit Dark',
    mode: 'dark',
    colors: {
      primary: '#5b8ac2',
      primaryLight3: '#8cadd4',
      primaryLight5: '#adc5e1',
      primaryLight7: '#cedced',
      primaryLight8: '#dee8f4',
      primaryLight9: '#1d2940',
      primaryDark2: '#496e9b',
      background: '#14181d',
      backgroundPage: '#101419',
      surface: '#1b2128',
      surfaceHover: '#232b34',
      surfaceActive: '#2c3641',
      textPrimary: '#e6edf3',
      textRegular: '#c2c9d0',
      textSecondary: '#8b949e',
      border: '#39424c',
      borderLight: '#2c343d',
      success: '#67c23a',
      warning: '#d6a85f',
      danger: '#e36d76',
      info: '#909399',
      diffChangeRow: 'rgba(198, 66, 66, 0.14)',
      diffChangeSeg: 'rgba(229, 57, 53, 0.38)',
      diffOrphanRow: 'rgba(67, 160, 71, 0.16)',
      diffOnlyLeft: '#7ba3cc',
      diffOnlyRight: '#dfad72',
      diffDiffer: '#d99a9a',
      diffIdentical: '#90a4ae',
      diffDir: '#81c784',
      diffIgnored: '#546e7a'
    }
  },
  {
    id: 'devkit-light',
    name: 'DevKit Light',
    mode: 'light',
    colors: {
      primary: '#3f6f9f',
      primaryLight3: '#7898b8',
      primaryLight5: '#9fb7cf',
      primaryLight7: '#c5d5e5',
      primaryLight8: '#d8e3ee',
      primaryLight9: '#edf3f8',
      primaryDark2: '#32597f',
      background: '#ffffff',
      backgroundPage: '#f4f6f8',
      surface: '#f8fafc',
      surfaceHover: '#eef2f6',
      surfaceActive: '#e3e8ef',
      textPrimary: '#1f2937',
      textRegular: '#4b5563',
      textSecondary: '#6b7280',
      border: '#cfd6de',
      borderLight: '#e5e9ef',
      success: '#3f8f55',
      warning: '#b7791f',
      danger: '#c9444d',
      info: '#64748b',
      diffChangeRow: 'rgba(198, 66, 66, 0.11)',
      diffChangeSeg: 'rgba(229, 57, 53, 0.28)',
      diffOrphanRow: 'rgba(67, 160, 71, 0.13)',
      diffOnlyLeft: '#356b9c',
      diffOnlyRight: '#a65f1c',
      diffDiffer: '#b64b4b',
      diffIdentical: '#66717d',
      diffDir: '#3f8f55',
      diffIgnored: '#8a94a0'
    }
  }
]

export const BUILTIN_TERMINAL_THEMES: TerminalTheme[] = [
  {
    id: 'devkit-default',
    name: 'DevKit Default',
    builtin: true,
    foreground: '#cfd8dc',
    background: '#101418',
    cursor: '#7fb4d9',
    cursorAccent: '#101418',
    selectionBackground: '#31454f',
    ansi: {
      black: '#1b242a', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
      blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#cfd8dc',
      brightBlack: '#5c6770', brightRed: '#ef7d86', brightGreen: '#a8d18b', brightYellow: '#f0cb86',
      brightBlue: '#7bbdf3', brightMagenta: '#d58be8', brightCyan: '#71c8d3', brightWhite: '#f3f6f8'
    }
  },
  {
    id: 'dark-plus',
    name: 'Dark+',
    builtin: true,
    foreground: '#cccccc',
    background: '#1e1e1e',
    cursor: '#ffffff',
    cursorAccent: '#1e1e1e',
    selectionBackground: '#264f78',
    ansi: {
      black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510',
      blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
      brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543',
      brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#e5e5e5'
    }
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    builtin: true,
    foreground: '#abb2bf',
    background: '#282c34',
    cursor: '#528bff',
    cursorAccent: '#282c34',
    selectionBackground: '#3e4451',
    ansi: {
      black: '#1e2127', red: '#e06c75', green: '#98c379', yellow: '#d19a66',
      blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
      brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b',
      brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff'
    }
  },
  {
    id: 'dracula',
    name: 'Dracula',
    builtin: true,
    foreground: '#f8f8f2',
    background: '#282a36',
    cursor: '#f8f8f2',
    cursorAccent: '#282a36',
    selectionBackground: '#44475a',
    ansi: {
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
      blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5',
      brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff'
    }
  },
  {
    id: 'nord',
    name: 'Nord',
    builtin: true,
    foreground: '#d8dee9',
    background: '#2e3440',
    cursor: '#d8dee9',
    cursorAccent: '#2e3440',
    selectionBackground: '#434c5e',
    ansi: {
      black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
      blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4'
    }
  },
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    builtin: true,
    foreground: '#ebdbb2',
    background: '#282828',
    cursor: '#ebdbb2',
    cursorAccent: '#282828',
    selectionBackground: '#504945',
    ansi: {
      black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921',
      blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
      brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f',
      brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2'
    }
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    builtin: true,
    foreground: '#839496',
    background: '#002b36',
    cursor: '#93a1a1',
    cursorAccent: '#002b36',
    selectionBackground: '#073642',
    ansi: {
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83',
      brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3'
    }
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    builtin: true,
    foreground: '#657b83',
    background: '#fdf6e3',
    cursor: '#586e75',
    cursorAccent: '#fdf6e3',
    selectionBackground: '#eee8d5',
    selectionForeground: '#586e75',
    ansi: {
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83',
      brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3'
    }
  },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    builtin: true,
    foreground: '#cdd6f4',
    background: '#1e1e2e',
    cursor: '#f5e0dc',
    cursorAccent: '#1e1e2e',
    selectionBackground: '#45475a',
    ansi: {
      black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
      blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
      brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af',
      brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#a6adc8'
    }
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    builtin: true,
    foreground: '#c0caf5',
    background: '#1a1b26',
    cursor: '#c0caf5',
    cursorAccent: '#1a1b26',
    selectionBackground: '#33467c',
    ansi: {
      black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
      blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
      brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68',
      brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5'
    }
  }
]
