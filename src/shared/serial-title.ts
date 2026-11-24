/** 串口端口名归一化：`com3` / `COM3` / `\\.\COM3` 视为同一端口。
 *
 * Windows 下大小写与 `\\.\` 前缀都合法，比较端口、展示标签标题时统一成大写 `COM<n>`；
 * 非 `COM<n>` 端口（如 `/dev/ttyUSB0`）原样返回。
 */
export function normalizePortPath(path: string): string {
  const raw = path.trim()
  const m = /^(?:\\\\\.\\)?com(\d+)$/i.exec(raw)
  return m ? `COM${m[1]}` : raw
}
