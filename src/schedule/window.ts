import type { Settings } from '../config/defaults'

export interface LocalTime {
  weekday: number // 1 = Monday … 7 = Sunday
  hhmm: string
}

/** Lead-local wall clock via Intl — no timezone tables of our own. */
export function localTime(timezone: string, now: Date): LocalTime {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  const weekdayNames: Record<string, number> = {
    Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
  }
  // Intl can emit "24:00" for midnight with hour12: false; normalize.
  const hour = get('hour') === '24' ? '00' : get('hour')
  return { weekday: weekdayNames[get('weekday')] ?? 0, hhmm: `${hour}:${get('minute')}` }
}

/**
 * The dispatcher releases a lead only inside its local send window
 * (default 09:00–16:30 lead-local, weekdays). Unknown/invalid timezones
 * fail safe: never in window.
 */
export function isInSendWindow(
  timezone: string | null,
  settings: Settings,
  now: Date,
): boolean {
  if (!timezone) return false
  let local: LocalTime
  try {
    local = localTime(timezone, now)
  } catch {
    return false
  }
  if (local.weekday === 0) return false
  if (settings.sendWeekdaysOnly && local.weekday > 5) return false
  return local.hhmm >= settings.sendWindowStartLocal && local.hhmm < settings.sendWindowEndLocal
}
