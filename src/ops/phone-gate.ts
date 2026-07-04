import type { Settings } from '../config/defaults'

const DAY_MS = 24 * 60 * 60 * 1000
const FAILED_OUTCOMES = ['no-answer', 'wrong-number'] as const

export interface GateVerdict {
  droppable: boolean
  failedAttempts: number
  spreadDays: number
  reason: string
}

/**
 * Drop gate (map §8): a lead becomes droppable only after N failed call
 * attempts SPREAD over the gate window (default 3 attempts / 2 weeks) —
 * burning three calls in one afternoon does not open the gate. Answered
 * calls are never "failed"; callback-later is neutral.
 */
export async function evaluateDropGate(
  db: D1Database,
  settings: Settings,
  companyId: number,
): Promise<GateVerdict> {
  const rows = await db
    .prepare(
      `SELECT created_at AS at FROM call_attempts
       WHERE company_id = ? AND outcome IN (${FAILED_OUTCOMES.map(() => '?').join(',')})
       ORDER BY created_at`,
    )
    .bind(companyId, ...FAILED_OUTCOMES)
    .all<{ at: string }>()

  const failed = rows.results
  if (failed.length < settings.phoneGateAttempts) {
    return {
      droppable: false,
      failedAttempts: failed.length,
      spreadDays: 0,
      reason: `${failed.length}/${settings.phoneGateAttempts} failed attempts logged`,
    }
  }
  const first = new Date(failed[0]!.at + 'Z').getTime()
  const last = new Date(failed[failed.length - 1]!.at + 'Z').getTime()
  const spreadDays = Math.floor((last - first) / DAY_MS)
  if (spreadDays < settings.phoneGateWindowDays) {
    return {
      droppable: false,
      failedAttempts: failed.length,
      spreadDays,
      reason: `attempts span ${spreadDays} days; the gate needs them spread over ${settings.phoneGateWindowDays}`,
    }
  }
  return {
    droppable: true,
    failedAttempts: failed.length,
    spreadDays,
    reason: 'gate satisfied — an owner may confirm the drop',
  }
}
