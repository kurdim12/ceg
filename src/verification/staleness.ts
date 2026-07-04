import type { Settings } from '../config/defaults'
import type { VerifierAdapter } from '../adapters/types'
import { logActivity } from '../domain/activities'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Emails rot ~2–3%/month (map §5): a lead that sat MORE THAN the staleness
 * threshold (default >60 days — 60 is fresh, 61 is stale) gets re-verified
 * before entering a new sequence.
 */
export function needsReverify(
  verifiedAt: string | null,
  settings: Settings,
  now: Date,
): boolean {
  if (!verifiedAt) return true
  const ageDays = Math.floor((now.getTime() - new Date(verifiedAt).getTime()) / DAY_MS)
  return ageDays > settings.reverifyStalenessDays
}

/**
 * Pre-enrollment staleness gate. Returns the contact's effective status.
 * With no verifier key the answer is fail-safe: 'unknown' (held), audited.
 */
export async function reverifyIfStale(
  db: D1Database,
  verifier: VerifierAdapter | null,
  contact: { id: number; email: string; email_status: string; email_verified_at: string | null },
  settings: Settings,
  now: Date,
): Promise<string> {
  if (!needsReverify(contact.email_verified_at, settings, now)) return contact.email_status

  if (!verifier) {
    await logActivity(db, {
      entityType: 'contact',
      entityId: contact.id,
      actor: 'system:verifier',
      kind: 'verification_held',
      detail: { reason: 'stale email but ZEROBOUNCE_API_KEY unset — holding' },
    })
    return 'unknown'
  }

  const outcome = await verifier.verify(contact.email)
  await db
    .prepare(
      `UPDATE contacts SET email_status = ?, email_verified_at = ?, updated_at = datetime('now') WHERE id = ?`,
    )
    .bind(outcome, now.toISOString(), contact.id)
    .run()
  await logActivity(db, {
    entityType: 'contact',
    entityId: contact.id,
    actor: 'system:verifier',
    kind: 'email_reverified',
    detail: { outcome, reason: 'stale before new sequence' },
  })
  return outcome
}
