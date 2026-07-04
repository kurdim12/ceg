import type { GmailAdapter } from '../adapters/types'
import type { Settings } from '../config/defaults'
import { logActivity } from '../domain/activities'
import { isInSendWindow } from '../schedule/window'
import { effectiveDailyCap, firstSentAt, sentTodayCount } from './caps'
import { getBreaker, updateBreaker } from './breaker'

export interface SendDeps {
  dryRun: boolean
  /** Resolves a connected inbox adapter per owner; null = not connected (hold). */
  gmailFor: (userId: number) => Promise<GmailAdapter | null>
  now: Date
}

interface ApprovedMessage {
  id: number
  company_id: number
  contact_id: number
  to_email: string
  subject: string
  body: string
  from_user_id: number | null
  timezone: string | null
  enrollment_id: number | null
  email_status: string
}

export interface SendTally {
  sent: number
  suppressed: number
  capped: number
  held: number
  dryRunHeld: number
}

/**
 * The ONLY code path that ever sends an email. Order of walls, each
 * independently sufficient to stop a send: breaker → suppression →
 * send window → per-inbox cap → DRY_RUN → connected inbox.
 */
export async function processApprovedSends(
  db: D1Database,
  kv: KVNamespace,
  settings: Settings,
  deps: SendDeps,
): Promise<SendTally> {
  const tally: SendTally = { sent: 0, suppressed: 0, capped: 0, held: 0, dryRunHeld: 0 }

  const breaker = await getBreaker(kv)
  if (breaker.tripped) {
    await logActivity(db, {
      entityType: 'system',
      actor: 'system:sender',
      kind: 'send_held_breaker',
      detail: { reason: breaker.reason },
    })
    return tally
  }

  const approved = await db
    .prepare(
      `SELECT m.id, m.company_id, m.contact_id, m.to_email, m.subject, m.body,
              m.from_user_id, m.enrollment_id, c.timezone, ct.email_status
       FROM email_messages m
       JOIN companies c ON c.id = m.company_id
       JOIN contacts ct ON ct.id = m.contact_id
       WHERE m.status = 'approved' AND m.direction = 'outbound'
       ORDER BY m.approved_at
       LIMIT 50`,
    )
    .all<ApprovedMessage>()

  const sentThisTick = new Map<number, number>()

  for (const msg of approved.results) {
    // Suppression is checked at send time, always — a stop request that
    // arrived after approval still wins.
    const suppressed = await db
      .prepare('SELECT 1 FROM suppression WHERE email = ?')
      .bind(msg.to_email.toLowerCase())
      .first()
    if (suppressed) {
      await db
        .prepare(`UPDATE email_messages SET status = 'cancelled' WHERE id = ?`)
        .bind(msg.id)
        .run()
      await logActivity(db, {
        entityType: 'contact',
        entityId: msg.contact_id,
        actor: 'system:sender',
        kind: 'send_suppressed',
        detail: { messageId: msg.id },
      })
      tally.suppressed++
      continue
    }

    // Verify-before-send holds for sequence emails end to end: only a
    // contact whose email verified 'valid' may receive one. (Reply drafts
    // answer a human who just wrote from that address.)
    if (msg.enrollment_id !== null && msg.email_status !== 'valid') {
      await db
        .prepare(`UPDATE email_messages SET status = 'cancelled' WHERE id = ?`)
        .bind(msg.id)
        .run()
      await logActivity(db, {
        entityType: 'contact',
        entityId: msg.contact_id,
        actor: 'system:sender',
        kind: 'send_cancelled_unverified',
        detail: { messageId: msg.id, emailStatus: msg.email_status },
      })
      tally.held++
      continue
    }

    if (!isInSendWindow(msg.timezone, settings, deps.now)) continue

    if (msg.from_user_id === null) {
      tally.held++
      continue
    }
    const already =
      (await sentTodayCount(db, msg.from_user_id, deps.now)) +
      (sentThisTick.get(msg.from_user_id) ?? 0)
    const cap = effectiveDailyCap(settings, await firstSentAt(db, msg.from_user_id), deps.now)
    if (already >= cap) {
      tally.capped++
      continue
    }

    if (deps.dryRun) {
      // DRY_RUN: the message stays approved, nothing is simulated.
      tally.dryRunHeld++
      continue
    }

    const gmail = await deps.gmailFor(msg.from_user_id)
    if (!gmail) {
      await logActivity(db, {
        entityType: 'system',
        actor: 'system:sender',
        kind: 'send_held_gmail',
        detail: { messageId: msg.id, fromUserId: msg.from_user_id },
      })
      tally.held++
      continue
    }

    const result = await gmail.send({
      fromUserId: msg.from_user_id,
      to: msg.to_email,
      subject: msg.subject,
      body: msg.body,
    })
    await db
      .prepare(
        `UPDATE email_messages
           SET status = 'sent', sent_at = ?, provider_message_id = ? WHERE id = ?`,
      )
      .bind(deps.now.toISOString(), result.providerMessageId, msg.id)
      .run()
    await logActivity(db, {
      entityType: 'contact',
      entityId: msg.contact_id,
      actor: 'system:sender',
      kind: 'email_sent',
      detail: { messageId: msg.id, step: null },
    })
    sentThisTick.set(msg.from_user_id, (sentThisTick.get(msg.from_user_id) ?? 0) + 1)
    tally.sent++
  }

  if (tally.dryRunHeld > 0) {
    await logActivity(db, {
      entityType: 'system',
      actor: 'system:sender',
      kind: 'dry_run_hold',
      detail: { messages: tally.dryRunHeld },
    })
  }

  // Re-evaluate the breaker after every tick that touched the send path.
  await updateBreaker(db, kv, settings, deps.now)
  return tally
}

/** Paused enrollments (OOO) resume when their pause expires. */
export async function resumePausedEnrollments(db: D1Database, now: Date): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE sequence_enrollments
         SET status = 'active', paused_until = NULL, updated_at = datetime('now')
       WHERE status = 'paused' AND paused_until <= ?`,
    )
    .bind(now.toISOString())
    .run()
  return result.meta.changes
}
