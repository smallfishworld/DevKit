export interface LogRetentionSettings {
  enabled: boolean
  months: number
}

export const DEFAULT_LOG_RETENTION: Readonly<LogRetentionSettings> = { enabled: true, months: 12 }

export function validLogRetention(value: unknown): value is LogRetentionSettings {
  if (!value || typeof value !== 'object') return false
  const { enabled, months } = value as Partial<LogRetentionSettings>
  return typeof enabled === 'boolean' && typeof months === 'number' && Number.isInteger(months) && months >= 1 && months <= 120
}

/** Subtract whole calendar months at the same UTC time, clamping the day for short months. */
export function retentionCutoff(now: Date, months: number): number {
  const cutoff = new Date(now.getTime())
  cutoff.setUTCDate(1)
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months)
  const monthEnd = new Date(cutoff.getTime())
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1, 0)
  cutoff.setUTCDate(Math.min(now.getUTCDate(), monthEnd.getUTCDate()))
  return cutoff.getTime()
}
