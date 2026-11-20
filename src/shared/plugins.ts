import pkg from '../../package.json'

export * from '../../packages/plugin-sdk/src/index'

export const OFFICIAL_PLUGIN_SOURCE = {
  id: 'devkit-official',
  name: 'DevKit 官方扩展源',
  url: `${pkg.homepage}-Plugins/releases/download/install-index-v2/index.json`
} as const
