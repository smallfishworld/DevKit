# DevKit 扩展源发布索引

扩展中心默认启用 [DevKit 官方安装索引](https://github.com/smallfishworld/DevKit-Plugins/releases/download/install-index-v1/index.json)，手动刷新即可查看已发布插件。也可从本地安装 API v1 的自包含 JSON 包。要提供在线安装，在 HTTPS 上发布包及索引，然后在「扩展中心 → 扩展源管理」添加索引地址并刷新。DevKit-Plugins 仓库的构建目录 catalog.json 提供源码和产物路径，独立发布索引还需包含 HTTPS 包地址和包文件的 SHA-256。

索引格式如下。实际发布时用包文件字节计算 SHA-256，替换示例值。

```json
{
  "version": 1,
  "plugins": [
    {
      "id": "devkit.text-hex-responder",
      "name": "文本 / HEX 自动应答",
      "version": "1.0.0",
      "url": "./devkit.text-hex-responder-1.0.0.devkit-plugin.json",
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  ]
}
```

相对包地址以配置的索引地址为基准。索引和包的所有跳转都需使用 HTTPS。停用官方源，或停用、移除自定义源，只影响从该源刷新和安装。已安装插件及其配置独立于来源。

用户确认后才会安装，安装后需要新建配置并在已连接串口里手动绑定。插件在独立进程中运行，拥有当前系统用户的本机代码权限。应选择信任的发行方。

维护者可使用 `DEVKIT_OFFICIAL_SOURCE_SMOKE=1 npm run test:extensions-smoke` 验证正式 Release 的 HTTPS 下载、安装和模拟串口应答。运行前先构建 DevKit。
