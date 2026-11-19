export function encodeInteger(value: bigint, width: 2 | 4 | 8): { le: string; be: string; truncated: boolean } {
  const bits = width * 8
  const unsigned = BigInt.asUintN(bits, value)
  const bytes = unsigned.toString(16).toUpperCase().padStart(width * 2, '0').match(/../g)!
  return { be: bytes.join(' '), le: bytes.reverse().join(' '),
    truncated: value < 0n ? BigInt.asIntN(bits, value) !== value : unsigned !== value }
}

export function parseCalendarTime(value: string, milliseconds: number, zone: 'local' | 'utc'): number | null {
  if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > 999) return null
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?$/.exec(value)
  if (!match) return null
  const [year, month, day, hours, minutes, seconds] = match.slice(1).map((part) => Number(part ?? 0))
  const date = new Date(0)
  if (zone === 'utc') {
    date.setUTCFullYear(year, month - 1, day)
    date.setUTCHours(hours, minutes, seconds, milliseconds)
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day ||
      date.getUTCHours() !== hours || date.getUTCMinutes() !== minutes || date.getUTCSeconds() !== seconds) return null
  } else {
    date.setFullYear(year, month - 1, day)
    date.setHours(hours, minutes, seconds, milliseconds)
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day ||
      date.getHours() !== hours || date.getMinutes() !== minutes || date.getSeconds() !== seconds) return null
  }
  return date.getTime()
}
