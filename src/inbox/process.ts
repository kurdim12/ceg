import type { LlmAdapter } from '../adapters/types'
import type { Settings } from '../config/defaults'
import { logActivity } from '../domain/activities'
import { readStage, transitionStage } from '../domain/transitions'
import { updateBreaker } from '../sequence/breaker'
import { classifyInbound } from './triage'
import { draftReply } from './draft-reply'

export interface InboundEmail {
  fromEmail: string
  subject: string
  body: string
  toUserId: number
}

export interface ProcessDeps {
  llm: LlmAdapter | null
  settings: Settings
  now: Date
}

/**
 * One inbound email through triage and its consequences. Stage moves on
 * "any human reply"; sentiment is separate metadata. Two kinds of no:
 * not_interested → lost (recyclable in 6 months); stop → permanent
 * add-only suppression. OOO pauses the lead 7 days. Bounce kills that
 * email and feeds the breaker. Every action audited.
 */
export async function processInboundMessage(
  db: D1Database,
  kv: KVNamespace,
  deps: ProcessDeps,
  inbound: InboundEmail,
): Promise<{ handled: boolean; cls?: string }> {
  const contact = await db
    .prepare(
      `SELECT ct.id AS contactId, ct.company_id AS companyId
       FROM contacts ct WHERE lower(ct.email) = ? ORDER BY ct.id LIMIT 1`,
    )
    .bind(inbound.fromEmail.toLowerCase())
    .first<{ contactId: number; companyId: number }>()
  if (!contact) {
    await logActivity(db, {
      entityType: 'system',
      actor: 'system:inbox',
      kind: 'inbound_unmatched',
      detail: { from: inbound.fromEmail, subject: inbound.subject.slice(0, 120) },
    })
    return { handled: false }
  }

  const triage = await classifyInbound(deps.llm, inbound)
  await db
    .prepare(
      `INSERT INTO email_messages
         (company_id, contact_id, direction, status, subject, body, to_email, from_user_id, triage)
       VALUES (?, ?, 'inbound', 'received', ?, ?, NULL, ?, ?)`,
    )
    .bind(
      contact.companyId, contact.contactId, inbound.subject,
      inbound.body.slice(0, 20_000), inbound.toUserId, triage.cls,
    )
    .run()
  await logActivity(db, {
    entityType: 'contact',
    entityId: contact.contactId,
    actor: 'system:inbox',
    kind: 'inbound_received',
    detail: { triage: triage.cls, via: triage.via },
  })

  const state = await readStage(db, contact.companyId)
  if (!state) return { handled: false }

  switch (triage.cls) {
    case 'ooo': {
      const until = new Date(deps.now.getTime() + deps.settings.oooPauseDays * 24 * 3600 * 1000)
      await db
        .prepare(
          `UPDATE sequence_enrollments
             SET status = 'paused', paused_until = ?, updated_at = datetime('now')
           WHERE contact_id = ? AND status = 'active'`,
        )
        .bind(until.toISOString(), contact.contactId)
        .run()
      await logActivity(db, {
        entityType: 'contact',
        entityId: contact.contactId,
        actor: 'system:inbox',
        kind: 'sequence_paused_ooo',
        detail: { resumesAt: until.toISOString() },
      })
      break
    }

    case 'stop': {
      // Permanent, add-only. INSERT OR IGNORE keeps re-requests harmless.
      await db
        .prepare(
          `INSERT OR IGNORE INTO suppression (email, reason, added_by) VALUES (?, 'stop_request', 'system:inbox')`,
        )
        .bind(inbound.fromEmail.toLowerCase())
        .run()
      await db
        .prepare(
          `UPDATE sequence_enrollments SET status = 'stopped', updated_at = datetime('now')
           WHERE contact_id = ? AND status IN ('active', 'paused')`,
        )
        .bind(contact.contactId)
        .run()
      await logActivity(db, {
        entityType: 'contact',
        entityId: contact.contactId,
        actor: 'system:inbox',
        kind: 'suppression_added',
        detail: { reason: 'stop_request' },
      })
      // A stop is still a human reply; it lands as lost, permanently suppressed.
      if (state.stage === 'email_sequence') {
        await transitionStage(db, {
          companyId: contact.companyId, from: 'email_sequence', to: 'replied',
          expectedVersion: state.version, actor: 'system:inbox', detail: { sentiment: 'stop' },
        })
        const mid = await readStage(db, contact.companyId)
        await transitionStage(db, {
          companyId: contact.companyId, from: 'replied', to: 'lost',
          expectedVersion: mid!.version, actor: 'system:inbox', detail: { reason: 'stop_request' },
        })
      }
      break
    }

    case 'not_interested': {
      await db
        .prepare(
          `UPDATE sequence_enrollments SET status = 'replied', updated_at = datetime('now')
           WHERE contact_id = ? AND status IN ('active', 'paused')`,
        )
        .bind(contact.contactId)
        .run()
      if (state.stage === 'email_sequence') {
        await transitionStage(db, {
          companyId: contact.companyId, from: 'email_sequence', to: 'replied',
          expectedVersion: state.version, actor: 'system:inbox',
          detail: { sentiment: 'not_interested' },
        })
        const mid = await readStage(db, contact.companyId)
        await transitionStage(db, {
          companyId: contact.companyId, from: 'replied', to: 'lost',
          expectedVersion: mid!.version, actor: 'system:inbox',
          detail: { reason: 'not_interested', reapproachable: true },
        })
      }
      break
    }

    case 'bounce': {
      const lastSent = await db
        .prepare(
          `SELECT id FROM email_messages
           WHERE contact_id = ? AND direction = 'outbound' AND status = 'sent'
           ORDER BY sent_at DESC LIMIT 1`,
        )
        .bind(contact.contactId)
        .first<{ id: number }>()
      if (lastSent) {
        await db
          .prepare(`UPDATE email_messages SET status = 'bounced', bounced_at = ? WHERE id = ?`)
          .bind(deps.now.toISOString(), lastSent.id)
          .run()
      }
      await db
        .prepare(
          `UPDATE contacts SET email_status = 'invalid', updated_at = datetime('now') WHERE id = ?`,
        )
        .bind(contact.contactId)
        .run()
      await db
        .prepare(
          `UPDATE sequence_enrollments SET status = 'stopped', updated_at = datetime('now')
           WHERE contact_id = ? AND status IN ('active', 'paused')`,
        )
        .bind(contact.contactId)
        .run()
      await logActivity(db, {
        entityType: 'contact',
        entityId: contact.contactId,
        actor: 'system:inbox',
        kind: 'email_bounced',
      })
      const otherValid = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM contacts
           WHERE company_id = ? AND id != ? AND email_status = 'valid'`,
        )
        .bind(contact.companyId, contact.contactId)
        .first<{ n: number }>()
      if ((otherValid?.n ?? 0) === 0 && state.stage === 'email_sequence') {
        await transitionStage(db, {
          companyId: contact.companyId, from: 'email_sequence', to: 'no_valid_email',
          expectedVersion: state.version, actor: 'system:inbox',
          detail: { reason: 'bounce, no other valid email — route to call queue' },
        })
      }
      await updateBreaker(db, kv, deps.settings, deps.now)
      break
    }

    case 'reply':
    case 'other': {
      await db
        .prepare(
          `UPDATE sequence_enrollments SET status = 'replied', updated_at = datetime('now')
           WHERE contact_id = ? AND status IN ('active', 'paused')`,
        )
        .bind(contact.contactId)
        .run()
      if (state.stage === 'email_sequence' || state.stage === 'unresponsive_email') {
        await transitionStage(db, {
          companyId: contact.companyId, from: state.stage, to: 'replied',
          expectedVersion: state.version, actor: 'system:inbox',
          detail: { sentiment: triage.cls === 'reply' ? 'engaged' : 'unclassified' },
        })
      }
      // The agent drafts a response for the owner to approve — never sends.
      await draftReply(db, deps.llm, {
        companyId: contact.companyId,
        contactId: contact.contactId,
        inboundSubject: inbound.subject,
        inboundBody: inbound.body,
        toEmail: inbound.fromEmail,
        ownerUserId: inbound.toUserId,
      })
      break
    }
  }
  return { handled: true, cls: triage.cls }
}
