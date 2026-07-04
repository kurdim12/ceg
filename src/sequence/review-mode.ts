import { logActivity } from '../domain/activities'

/**
 * First-20 review mode (map §6): after the owners approve the template
 * skeletons once, the first N personalized emails still run as drafts for
 * owner review; only then does approval automate. ON by default at launch.
 */
export const REVIEW_MODE_THRESHOLD = 20

export async function approvedOutboundCount(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM email_messages
       WHERE direction = 'outbound' AND approved_at IS NOT NULL`,
    )
    .first<{ n: number }>()
  return row?.n ?? 0
}

export async function isReviewModeActive(db: D1Database): Promise<boolean> {
  return (await approvedOutboundCount(db)) < REVIEW_MODE_THRESHOLD
}

/** Human approval of a single draft. */
export async function approveDraft(
  db: D1Database,
  messageId: number,
  actor: string,
  now: Date,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE email_messages
         SET status = 'approved', approved_at = ?, approved_by = ?
       WHERE id = ? AND status = 'draft' AND direction = 'outbound'`,
    )
    .bind(now.toISOString(), actor, messageId)
    .run()
  if (result.meta.changes !== 1) return false
  await logActivity(db, {
    entityType: 'system',
    actor,
    kind: 'draft_approved',
    detail: { messageId },
  })
  return true
}

/**
 * Past the first-20 threshold, sequence drafts auto-approve. While review
 * mode is active this is a no-op — every draft waits for an owner.
 */
export async function autoApprovePastReview(db: D1Database, now: Date): Promise<number> {
  if (await isReviewModeActive(db)) return 0
  const result = await db
    .prepare(
      `UPDATE email_messages
         SET status = 'approved', approved_at = ?, approved_by = 'system:auto'
       WHERE status = 'draft' AND direction = 'outbound' AND enrollment_id IS NOT NULL`,
    )
    .bind(now.toISOString())
    .run()
  const n = result.meta.changes
  if (n > 0) {
    await logActivity(db, {
      entityType: 'system',
      actor: 'system:auto',
      kind: 'drafts_auto_approved',
      detail: { count: n },
    })
  }
  return n
}
