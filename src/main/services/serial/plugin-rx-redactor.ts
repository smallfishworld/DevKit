/**
 * Byte-preserving streaming secret filter for public plugin RX.
 *
 * Register a secret before transmitting it. Only an unfinished secret prefix is
 * retained between pushes; unrelated binary bytes never pass through a decoder.
 * Patterns remain registered after a lease ends, covering delayed device echoes.
 */
const MAX_SECRETS = 64
const MAX_SECRET_BYTES = 64 * 1024
const BLOCK_BYTES = 64 * 1024
const HIDDEN = Buffer.from('[REDACTED]', 'ascii')

interface Pattern {
  bytes: Buffer
  /** KMP failure table; prevents quadratic work on long repeated-byte prefixes. */
  failure: Uint32Array
}

function pattern(bytes: Buffer): Pattern {
  const failure = new Uint32Array(bytes.length)
  let matched = 0
  for (let index = 1; index < bytes.length; index++) {
    while (matched && bytes[index] !== bytes[matched]) matched = failure[matched - 1]
    if (bytes[index] === bytes[matched]) matched++
    failure[index] = matched
  }
  return { bytes, failure }
}

export class PluginRxRedactor {
  private readonly patterns: Pattern[] = []
  private pending = Buffer.alloc(0)

  add(secret: Uint8Array): void {
    if (!secret.byteLength) return
    if (secret.byteLength > MAX_SECRET_BYTES) throw new Error('秘密值长度超过64KiB')
    const bytes = Buffer.from(secret)
    if (this.patterns.some(item => item.bytes.equals(bytes))) return
    if (this.patterns.length >= MAX_SECRETS) throw new Error('秘密值数量超过64个，请重新连接串口')
    this.patterns.push(pattern(bytes))
  }

  push(chunk: Uint8Array): Buffer {
    if (!chunk.byteLength) return Buffer.alloc(0)
    const bytes = Buffer.from(chunk)
    if (!this.patterns.length) return bytes
    const output: Buffer[] = []
    // Bound scratch arrays even when a driver delivers a very large chunk.
    for (let offset = 0; offset < bytes.length; offset += BLOCK_BYTES) {
      const block = bytes.subarray(offset, Math.min(bytes.length, offset + BLOCK_BYTES))
      const input = this.pending.length ? Buffer.concat([this.pending, block]) : block
      this.pending = Buffer.alloc(0)
      const filtered = this.filter(input)
      if (filtered.length) output.push(filtered)
    }
    return Buffer.concat(output)
  }

  /** A stream ending in a possible secret prefix must not expose that prefix. */
  finish(): Buffer {
    if (!this.pending.length) return Buffer.alloc(0)
    this.pending = Buffer.alloc(0)
    return Buffer.from(HIDDEN)
  }

  private filter(input: Buffer): Buffer {
    const fullMatch = new Uint32Array(input.length)
    const partialMatch = new Uint8Array(input.length)
    for (const { bytes, failure } of this.patterns) {
      let matched = 0
      for (let index = 0; index < input.length; index++) {
        while (matched && input[index] !== bytes[matched]) matched = failure[matched - 1]
        if (input[index] === bytes[matched]) matched++
        if (matched === bytes.length) {
          const start = index + 1 - bytes.length
          fullMatch[start] = Math.max(fullMatch[start], bytes.length)
          matched = failure[matched - 1]
        }
      }
      // Every suffix on this failure chain is a possible split secret. Keeping
      // all starts matters when a prior complete match consumes an earlier one.
      while (matched) {
        partialMatch[input.length - matched] = 1
        matched = failure[matched - 1]
      }
    }

    const output: Buffer[] = []
    let cursor = 0
    let literalStart = 0
    while (cursor < input.length) {
      // Wait for a longer secret even if a shorter complete secret starts here.
      if (partialMatch[cursor]) {
        if (cursor > literalStart) output.push(input.subarray(literalStart, cursor))
        this.pending = Buffer.from(input.subarray(cursor))
        return Buffer.concat(output)
      }
      const length = fullMatch[cursor]
      if (length) {
        if (cursor > literalStart) output.push(input.subarray(literalStart, cursor))
        output.push(HIDDEN)
        cursor += length
        literalStart = cursor
      } else cursor++
    }
    if (literalStart < input.length) output.push(input.subarray(literalStart))
    return Buffer.concat(output)
  }
}
