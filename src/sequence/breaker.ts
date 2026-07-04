import type { Settings } from '../config/defaults'
import { logActivity } from '../domain/activities'

/** Trailing window the bounce rate is computed over. */
export const BREAKER_WINDOW_DAYS = 7
const BREAKER_KEY = 'breaker'

export interface BreakerState {
  tripped: boolean
  trippedAt?: string
  reason?: string
}

export type BreakerVerdict =
  | { level: 'below_floor'; sends: number; bounces: number }
  | { level: 'ok'; ratePct: number; sends: number; bounces: number }
  | { level: 'warn'; ratePct: number; sends: number; bounces: number }
  | { level: 'stop'; ratePct: number; sends: number; bounces: number }

/**
 * Bounce breaker (map §5): warn 2% · full auto-stop 3% · floor ≥25 sends
 * in the window. Below the floor no rate is meaningful — one bounce at 10
 * sends must not trip a 10% false alarm.
 */
export async function evaluateBounceRate(
  db: D1Database,
  settings: Settings,
  now: Date,
): Promise<BreakerVerdict> {
  const since = new Date(now.getTime() - BREAKER_WINDOW_DAYS * 24 * 3600 * 1000).toISOString()
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS sends,
         SUM(CASE WHEN status = 'bounced' THEN 1 ELSE 0 END) AS bounces
       FROM email_messages
       WHERE direction = 'outbound' AND sent_at IS NOT NULL AND sent_at >= ?`,
    )
    .bind(since)
    .first<{ sends: number; bounces: number | null }>()
  const sends = row?.sends ?? 0
  const bounces = row?.bounces ?? 0
  if (sends < settings.bounceFloorSends) return { level: 'below_floor', sends, bounces }
  const ratePct = (bounces / sends) * 100
  if (ratePct >= settings.bounceStopPct) return { level: 'stop', ratePct, sends, bounces }
  if (ratePct >= settings.bounceWarnPct) return { level: 'warn', ratePct, sends, bounces }
  return { level: 'ok', ratePct, sends, bounces }
}

export async function getBreaker(kv: KVNamespace): Promise<BreakerState> {
  const raw = await kv.get(BREAKER_KEY)
  return raw ? (JSON.parse(raw) as BreakerState) : { tripped: false }
}

/**
 * Recomputes and persists breaker state. Tripping is automatic; RESETTING
 * is not — a human clears it in settings after investigating, so a bad
 * spell can never silently resume sending.
 */
export async function updateBreaker(
  db: D1Database,
  kv: KVNamespace,
  settings: Settings,
  now: Date,
): Promise<BreakerVerdict> {
  const verdict = await evaluateBounceRate(db, settings, now)
  const current = await getBreaker(kv)

  if (verdict.level === 'stop' && !current.tripped) {
    const state: BreakerState = {
      tripped: true,
      trippedAt: now.toISOString(),
      reason: `bounce rate ${verdict.ratePct.toFixed(1)}% over ${verdict.sends} sends (stop ≥ ${settings.bounceStopPct}%)`,
    }
    await kv.put(BREAKER_KEY, JSON.stringify(state))
    await logActivity(db, {
      entityType: 'system',
      actor: 'system:breaker',
      kind: 'breaker_tripped',
      detail: { ...verdict },
    })
  } else if (verdict.level === 'warn') {
    await logActivity(db, {
      entityType: 'system',
      actor: 'system:breaker',
      kind: 'breaker_warn',
      detail: { ...verdict },
    })
  }
  return verdict
}

/** Human-only reset from settings; audited. */
export async function resetBreaker(
  db: D1Database,
  kv: KVNamespace,
  actor: string,
): Promise<void> {
  await kv.put(BREAKER_KEY, JSON.stringify({ tripped: false } satisfies BreakerState))
  await logActivity(db, {
    entityType: 'system',
    actor,
    kind: 'breaker_reset',
  })
}
