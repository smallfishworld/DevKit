# DevKit · Module Core

B 方案：两枚青绿模块围绕中央留白互相嵌合。保持轮廓、台阶开口和配色一致，不加入字母、芯片针脚或额外装饰。

## 资产与用途

| 文件 | 用途 |
| --- | --- |
| `mark.svg` | **唯一可编辑母版**；无底板，标题栏 Logo 与 favicon |
| `mark-mono.svg` | 自动生成的单色版；需要单色的工具栏入口，可用 CSS mask 继承前景色 |
| `app.svg` | 自动生成的深绿圆角底板版 |
| `app-256.png` | 主进程窗口图标；显式包含在应用 ASAR 内 |
| `app-512.png` | Linux 打包图标 |
| `app-1024.png` | macOS 打包图标输入，由 electron-builder 转换 |
| `devkit.ico` | Windows EXE、便携启动器、快捷方式与任务栏的多尺寸图标 |

标题栏采用 20px 无底板 Logo，保留 DevKit 文字和原有版本信息入口。单色版作为品牌资源提供；各工具既有的功能图标不受影响。品牌配色不随界面主题改变。

## 再生成

修改 `mark.svg` 后执行：

```sh
npm run icons:generate
npm run icons:check
```

生成器使用锁定版本的 `@resvg/resvg-js`，不依赖系统字体。派生 SVG、PNG、ICO 均随源文件提交。ICO 包含 16、20、24、32、40、48、64、128、256px 的 PNG 帧；圆角外保留透明。

母版的紧凑 viewBox 用于小尺寸裸标识；应用图标在底板上额外留出安全区。调整时应分别检查 16/20/24/32px 的实际尺寸，以及深、浅背景，避免只看大图。

Windows CI 复用现有 `dist:dir` 产物运行 `scripts/check-packaged-branding.cjs`，核对 EXE 图标资源的完整帧集合及 ASAR 内运行时 PNG。正式版本仍由既有 Release 工作流发布。
