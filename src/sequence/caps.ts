import type { Settings } from '../config/defaults'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Effective daily cap for an inbox. With the weekly ramp on, a fresh inbox
 * starts at one increment and grows weekly until it reaches the configured
 * cap (default 15/day). The cap is the ceiling either way — there is no
 * configuration state that removes it.
 */
export function effectiveDailyCap(
  settings: Settings,
  firstSentAt: string | null,
  now: Date,
): number {
  if (!settings.weeklyRampEnabled) return settings.sendCapPerInboxPerDay
  if (!firstSentAt) return Math.min(settings.weeklyRampIncrement, settings.sendCapPerInboxPerDay)
  const weeks = Math.floor((now.getTime() - new Date(firstSentAt).getTime()) / WEEK_MS)
  const ramped = settings.weeklyRampIncrement * (weeks + 1)
  return Math.min(ramped, settings.sendCapPerInboxPerDay)
}

export async function sentTodayCount(
  db: D1Database,
  fromUserId: number,
  now: Date,
): Promise<number> {
  const day = now.toISOString().slice(0, 10)
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM email_messages
       WHERE from_user_id = ? AND status = 'sent' AND date(sent_at) = ?`,
    )
    .bind(fromUserId, day)
    .first<{ n: number }>()
  return row?.n ?? 0
}

export async function firstSentAt(db: D1Database, fromUserId: number): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT MIN(sent_at) AS first FROM email_messages WHERE from_user_id = ? AND status = 'sent'`,
    )
    .bind(fromUserId)
    .first<{ first: string | null }>()
  return row?.first ?? null
}
