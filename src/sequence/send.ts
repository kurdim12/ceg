import type { GmailAdapter } from '../adapters/types'
import type { Settings } from '../config/defaults'
import { logActivity } from '../domain/activities'
import { getPauseState } from '../ops/pause'
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
  /** Provider errors this tick — message marked 'failed', batch continues. */
  failed: number
  /** Stale 'sending' claims recovered to 'needs_review' — never auto-resent. */
  needsReview: number
}

/**
 * A claim older than this that is still 'sending' means a prior tick died
 * mid-send. We never auto-resend it (the email may have gone out) — it is
 * moved to 'needs_review' for a human to confirm with the provider.
 */
const STALE_CLAIM_MS = 15 * 60 * 1000

/**
 * The ONLY code path that ever sends an email. Order of walls, each
 * independently sufficient to stop a send: manual pause → breaker →
 * suppression → verify-before-send → send window → per-inbox cap → DRY_RUN
 * → atomic claim (approved→sending) → connected inbox → provider send →
 * resolve (sending→sent|failed). A message is selected only while 'approved',
 * so a claimed-but-unresolved message is never re-sent: no duplicates.
 */
export async function processApprovedSends(
  db: D1Database,
  kv: KVNamespace,
  settings: Settings,
  deps: SendDeps,
): Promise<SendTally> {
  const tally: SendTally = {
    sent: 0, suppressed: 0, capped: 0, held: 0, dryRunHeld: 0, failed: 0, needsReview: 0,
  }

  // Wall 0: the manual emergency stop. A human paused sending — nothing goes
  // out until a human resumes it, no matter what else is green.
  const pause = await getPauseState(kv)
  if (pause.paused) {
    await logActivity(db, {
      entityType: 'system',
      actor: 'system:sender',
      kind: 'send_held_paused',
      detail: { by: pause.by ?? null, reason: pause.reason ?? null },
    })
    return tally
  }

  // Recovery: a message left 'sending' by a crashed prior tick is ambiguous —
  // it may already have been delivered. Never auto-resend; surface it for a
  // human as 'needs_review'. (It is not 'approved', so it was never at risk of
  // re-selection below; this just makes the stuck state visible and actionable.)
  const staleBefore = new Date(deps.now.getTime() - STALE_CLAIM_MS).toISOString()
  const swept = await db
    .prepare(
      `UPDATE email_messages
         SET status = 'needs_review',
             send_failure_reason = 'claim went stale — a prior send tick did not complete; confirm with the provider before resending'
       WHERE status = 'sending' AND direction = 'outbound'
         AND (send_claimed_at IS NULL OR send_claimed_at < ?)`,
    )
    .bind(staleBefore)
    .run()
  if ((swept.meta.changes ?? 0) > 0) {
    tally.needsReview += swept.meta.changes ?? 0
    await logActivity(db, {
      entityType: 'system',
      actor: 'system:sender',
      kind: 'send_needs_review',
      detail: { recovered: swept.meta.changes },
    })
  }

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
        .prepare(`UPDATE email_messages SET status = 'cancelled' WHERE id = ? AND status = 'approved'`)
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
        .prepare(`UPDATE email_messages SET status = 'cancelled' WHERE id = ? AND status = 'approved'`)
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
      // DRY_RUN: the message stays approved, nothing is claimed or simulated.
      tally.dryRunHeld++
      continue
    }

    // ── Atomic claim: approved → sending. Only one writer can win this CAS,
    //    so two overlapping ticks can never both send the same message. If the
    //    claim changes 0 rows, another tick already took it — skip.
    const claim = await db
      .prepare(
        `UPDATE email_messages SET status = 'sending', send_claimed_at = ?
         WHERE id = ? AND status = 'approved'`,
      )
      .bind(deps.now.toISOString(), msg.id)
      .run()
    if ((claim.meta.changes ?? 0) !== 1) continue
    await logActivity(db, {
      entityType: 'contact',
      entityId: msg.contact_id,
      actor: 'system:sender',
      kind: 'send_claimed',
      detail: { messageId: msg.id },
    })

    const gmail = await deps.gmailFor(msg.from_user_id)
    if (!gmail) {
      // No connected inbox — release the claim back to 'approved' so it retries
      // once the owner connects. (Still audited as a hold.)
      await db
        .prepare(
          `UPDATE email_messages SET status = 'approved', send_claimed_at = NULL
           WHERE id = ? AND status = 'sending'`,
        )
        .bind(msg.id)
        .run()
      await logActivity(db, {
        entityType: 'system',
        actor: 'system:sender',
        kind: 'send_held_gmail',
        detail: { messageId: msg.id, fromUserId: msg.from_user_id },
      })
      tally.held++
      continue
    }

    // ── Provider send, isolated: one failure must not abort the batch.
    let providerMessageId: string
    try {
      const result = await gmail.send({
        fromUserId: msg.from_user_id,
        to: msg.to_email,
        subject: msg.subject,
        body: msg.body,
      })
      providerMessageId = result.providerMessageId
    } catch (err) {
      const reason = (err as Error).message?.slice(0, 300) ?? 'unknown provider error'
      await db
        .prepare(
          `UPDATE email_messages SET status = 'failed', send_failure_reason = ?
           WHERE id = ? AND status = 'sending'`,
        )
        .bind(reason, msg.id)
        .run()
      await logActivity(db, {
        entityType: 'contact',
        entityId: msg.contact_id,
        actor: 'system:sender',
        kind: 'send_failed',
        detail: { messageId: msg.id, reason },
      })
      tally.failed++
      continue
    }

    // ── Send SUCCEEDED. Resolve sending → sent. If this write fails, the row
    //    stays 'sending' and becomes 'needs_review' next tick — it is NEVER
    //    re-sent, so a delivered email is never duplicated.
    try {
      const marked = await db
        .prepare(
          `UPDATE email_messages
             SET status = 'sent', sent_at = ?, provider_message_id = ?
           WHERE id = ? AND status = 'sending'`,
        )
        .bind(deps.now.toISOString(), providerMessageId, msg.id)
        .run()
      if ((marked.meta.changes ?? 0) === 1) {
        await logActivity(db, {
          entityType: 'contact',
          entityId: msg.contact_id,
          actor: 'system:sender',
          kind: 'email_sent',
          detail: { messageId: msg.id, providerMessageId },
        })
        sentThisTick.set(msg.from_user_id, (sentThisTick.get(msg.from_user_id) ?? 0) + 1)
        tally.sent++
      } else {
        // The row moved under us (e.g. swept concurrently). The email went out;
        // do not resend. Audit the ambiguity loudly.
        await logActivity(db, {
          entityType: 'contact',
          entityId: msg.contact_id,
          actor: 'system:sender',
          kind: 'send_sent_unconfirmed',
          detail: { messageId: msg.id, providerMessageId },
        })
      }
    } catch (err) {
      await logActivity(db, {
        entityType: 'contact',
        entityId: msg.contact_id,
        actor: 'system:sender',
        kind: 'send_sent_unpersisted',
        detail: {
          messageId: msg.id,
          providerMessageId,
          reason: (err as Error).message?.slice(0, 300) ?? null,
          note: 'email was sent but the DB write failed; left as sending → needs_review, never resent',
        },
      })
    }
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
