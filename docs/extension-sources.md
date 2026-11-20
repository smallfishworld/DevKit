# DevKit 扩展源发布索引（v2）

扩展中心默认启用 DevKit 官方安装索引（`install-index-v2/index.json`），手动刷新即可查看已发布插件；也可从本地安装 API v2 的自包含 JSON 包或开启开发目录热重载。要提供在线安装，在 HTTPS 上发布包及索引，然后在「扩展中心 → 扩展源管理」添加索引地址并刷新。

v2 索引格式如下（实际发布时用包文件字节计算 SHA-256）：

```json
{
  "version": 2,
  "plugins": [
    {
      "id": "devkit.text-hex-responder",
      "name": "文本 / HEX 自动应答",
      "version": "2.0.0",
      "apiVersion": 2,
      "minHostVersion": "0.1.10",
      "transports": ["serial", "ssh", "net"],
      "url": "./devkit.text-hex-responder-2.0.0.devkit-plugin.json",
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  ]
}
```

### 字段与治理规则

- `version`：固定为 `2`。
- `apiVersion`：固定为 `2`。
- `minHostVersion`（可选）：最低兼容宿主 SemVer；若当前 DevKit 版本低于该值，界面灰显并禁止安装，宿主侧同步拒绝。
- `transports`（可选）：声明插件支持的会话类型（`serial`、`ssh`、`net`、`pty`）。
- `deprecated`（可选）：废弃提示文本，界面展示警告标签。
- `yanked`（可选）：设为 `true` 时表示该版本已撤回，界面与宿主均禁止安装。

相对包地址以配置的索引地址为基准，索引和包的所有跳转都必须使用 HTTPS。停用或移除扩展源不影响已安装插件和已有配置。插件在独立进程中运行，拥有当前系统用户的本机代码权限，请仅从信任的发行方安装。
