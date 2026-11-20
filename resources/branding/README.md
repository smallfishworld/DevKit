# DevKit · DK Monogram

以用户确认的 DK Monogram 参考图为准：D 与 K 合为一个字形，D 内保留清晰的负形，K 的两条斜臂与 D 相连。字形由左侧蓝色渐变至右侧紫色；应用图标使用深紫圆角底板。

## 资产与用途

| 文件 | 用途 |
| --- | --- |
| `mark.svg` | **唯一可编辑母版**；无底板的 DK 连体字母，标题栏 Logo 与 favicon |
| `mark-mono.svg` | 自动生成的单色版；供需要单色品牌标识的入口使用，可用 CSS mask 继承前景色 |
| `app.svg` | 自动生成的深紫圆角底板版 |
| `app-256.png` | 非 Windows 原生窗口图标与开发态 macOS Dock；随应用 ASAR 提供 |
| `app-512.png` | Linux 打包图标 |
| `app-1024.png` | macOS 打包图标输入，由 electron-builder 转换 |
| `devkit.ico` | Windows EXE、便携启动器和原生窗口图标；随应用 ASAR 提供，供运行时窗口与任务栏身份使用 |

标题栏使用 24×20px 图框保持 DK 的横向比例，保留 DevKit 文字和原有版本信息入口。品牌配色不随界面主题改变。

## 应用品牌覆盖

| 用户入口 | 来源与行为 |
| --- | --- |
| 标题栏与 favicon | `App.vue` 共享导入 `mark.svg`，开发与生产构建使用同一个解析后的资源地址 |
| 主窗口、Windows 任务栏与 Alt+Tab | 主进程统一选择 Windows ICO / 其他平台 PNG；Windows 使用 `com.embedded.devkit` 应用身份，重启属性指向 DevKit 自身 |
| 插件登录窗口 | 复用相同原生图标与 Windows 应用身份，在显示前设置；登录 URL 仅用于加载页面，不作为任务栏重启入口 |
| EXE、便携启动器、macOS/Linux 应用包 | electron-builder 使用上表中的平台图标输入 |
| 版本信息 | 标题栏 DK 按钮打开既有版本浮层；没有额外的原生 About 窗口或旧品牌图标 |
| 宏状态条、全屏取色器 | 保留无边框与 `skipTaskbar`，不为这些辅助窗口新增任务栏入口 |
| 工具标签、工具箱与扩展中心 | 保留工具自身的功能图标；计算器的 Cpu、扩展的 Box 等不代表 DevKit 应用品牌 |
| 系统托盘 | 当前应用没有托盘入口，不新增托盘图标 |

## 再生成

修改 `mark.svg` 后执行：

```sh
npm run icons:generate
npm run icons:check
```

生成器使用锁定版本的 `@resvg/resvg-js`，不依赖系统字体。派生 SVG、PNG、ICO 均随源文件提交。ICO 包含 16、20、24、32、40、48、64、128、256px 的 PNG 帧；圆角外保留透明。

母版的紧凑 viewBox 用于小尺寸裸标识；应用图标在底板上留出安全区，字形约占底板宽度的 69%、高度的 56%，与确认图保持相同的视觉比例。调整时检查 16/20/24/32px 的实际尺寸以及深、浅背景，确保 D 的负形和 K 的斜臂仍可辨认。

## 构建与分发边界

运行时所需的 PNG 与 ICO 必须包含在 `app.asar`。Windows 窗口读取包内 ICO；Windows Shell 的重启图标使用实际 DevKit EXE 内嵌资源，便携版优先使用仍存在的原始启动器，避免让 Shell 读取 ASAR 虚拟路径或指向临时解包目录。开发态则指向当前 Electron 程序和应用源码目录。

Windows 构建后执行：

```sh
# 快速检查目录版 EXE 以及 ASAR 内 PNG/ICO
node scripts/check-packaged-branding.cjs
# 检查目录版、portable 外层启动器、ZIP 内应用与运行时资源
node scripts/check-packaged-branding.cjs --release
# 启动本次产物，检查真实 HWND 的图标和 Windows 应用身份
npm run test:branding-smoke -- --release
```

CI 在完整 Windows `dist` 后运行上述产物和原生窗口门槛，并提供 `DevKit-Windows-<提交SHA>` Artifact，内含已验证的 portable 与 ZIP，保留 7 天，供本次变更验证。正式 Release 工作流也在上传前执行门槛。资源存在、Linux 截图和 Windows 原生窗口检查是不同层次的证据，CI Artifact 不等于正式 Latest 已更新。

合并主分支不会自动更新已经发布的 Release 附件，已有下载包仍由其构建来源决定。发布仍遵循既有 Release 工作流。应用也不会静默改写用户已固定的任务栏快捷方式。

用户报告旧图标时，先确认实际运行文件的路径与构建来源、下载包内的资源，再区分新窗口和已有固定项。仅在这些信息确认之后，才排查 Windows Shell 的图标缓存；不要预先把所有旧图标都归因于缓存。用户操作顺序见根目录 README 的“应用图标与任务栏核对”。
