/** zmodem.js 无官方类型：最小声明（主进程串口文件传输用），API 以运行时为准 */
declare module 'zmodem.js' {
  const Zmodem: {
    Sentry: new (opts: {
      to_terminal: (octets: number[]) => void
      on_detect: (detection: unknown) => void
      on_retract: () => void
      sender: (octets: number[]) => void
    }) => {
      consume(bytes: Uint8Array | number[]): unknown
    }
    Session: unknown
    Header: Record<string, unknown>
    ZDLE: unknown
    CRC: Record<string, unknown>
    Error: new (msg: string) => Error
  }
  export default Zmodem
}
