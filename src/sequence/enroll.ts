import type { Settings } from '../config/defaults'
import { logActivity } from '../domain/activities'
import { isInSendWindow } from '../schedule/window'
import { renderStep } from './templates'

/**
 * Enrolls a contact into the email sequence. Structural guards: one active
 * enrollment per contact (unique index) and one contact per company
 * in-sequence at a time (checked here; the stagger delay for the NEXT
 * contact is applied when this enrollment ends, map §3).
 */
export async function enrollContact(
  db: D1Database,
  args: { companyId: number; contactId: number; actor: string; now: Date },
): Promise<number> {
  const activeForCompany = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM sequence_enrollments WHERE company_id = ? AND status = 'active'",
    )
    .bind(args.companyId)
    .first<{ n: number }>()
  if ((activeForCompany?.n ?? 0) > 0) {
    throw new Error(`company ${args.companyId} already has a contact in sequence`)
  }

  const row = await db
    .prepare(
      `INSERT INTO sequence_enrollments (company_id, contact_id, status, current_step, next_action_at)
       VALUES (?, ?, 'active', 0, ?) RETURNING id`,
    )
    .bind(args.companyId, args.contactId, args.now.toISOString())
    .first<{ id: number }>()

  await logActivity(db, {
    entityType: 'contact',
    entityId: args.contactId,
    actor: args.actor,
    kind: 'sequence_enrolled',
    detail: { companyId: args.companyId, enrollmentId: row!.id },
  })
  return row!.id
}

export interface DueEnrollment {
  id: number
  company_id: number
  contact_id: number
  current_step: number
  timezone: string | null
  company_name: string
  city: string | null
  contact_name: string | null
  contact_email: string | null
  assignee_id: number | null
  sender_name: string | null
  booking_link: string | null
}

/**
 * The dispatcher core: for every active enrollment that is due AND whose
 * lead-local clock is inside the send window, render the next step as a
 * DRAFT email_messages row. Sending is a separate, capped, DRY_RUN-gated
 * concern (Phase 4) — this function never sends anything.
 */
export async function advanceDueEnrollments(
  db: D1Database,
  settings: Settings,
  now: Date,
): Promise<{ drafted: number; exhausted: number }> {
  const due = await db
    .prepare(
      `SELECT e.id, e.company_id, e.contact_id, e.current_step,
              c.timezone, c.name AS company_name, c.city, c.assignee_id,
              ct.name AS contact_name, ct.email AS contact_email,
              u.name AS sender_name, u.booking_link
       FROM sequence_enrollments e
       JOIN companies c ON c.id = e.company_id
       JOIN contacts ct ON ct.id = e.contact_id
       LEFT JOIN users u ON u.id = c.assignee_id
       WHERE e.status = 'active' AND e.next_action_at <= ?
       ORDER BY e.next_action_at
       LIMIT 200`,
    )
    .bind(now.toISOString())
    .all<DueEnrollment>()

  let drafted = 0
  let exhausted = 0
  for (const row of due.results) {
    if (row.current_step >= settings.sequenceSteps) {
      exhausted++
      await db
        .prepare(
          `UPDATE sequence_enrollments SET status = 'exhausted', updated_at = datetime('now') WHERE id = ?`,
        )
        .bind(row.id)
        .run()
      await logActivity(db, {
        entityType: 'contact',
        entityId: row.contact_id,
        actor: 'system:dispatcher',
        kind: 'sequence_exhausted',
        detail: { enrollmentId: row.id },
      })
      continue
    }

    if (!isInSendWindow(row.timezone, settings, now)) continue
    if (!row.contact_email) continue

    const step = row.current_step + 1
    const rendered = renderStep(step, {
      contactName: row.contact_name,
      companyName: row.company_name,
      city: row.city,
      senderName: row.sender_name ?? 'Maranasi',
      bookingLink: row.booking_link,
    })

    const nextDue = new Date(now.getTime() + settings.sequenceSpacingHours * 3600 * 1000)
    await db.batch([
      db
        .prepare(
          `INSERT INTO email_messages
             (enrollment_id, company_id, contact_id, direction, step, status, subject, body, to_email, from_user_id)
           VALUES (?, ?, ?, 'outbound', ?, 'draft', ?, ?, ?, ?)`,
        )
        .bind(
          row.id, row.company_id, row.contact_id, step,
          rendered.subject, rendered.body, row.contact_email, row.assignee_id,
        ),
      db
        .prepare(
          `UPDATE sequence_enrollments
             SET current_step = ?, next_action_at = ?, updated_at = datetime('now')
           WHERE id = ?`,
        )
        .bind(step, nextDue.toISOString(), row.id),
    ])
    await logActivity(db, {
      entityType: 'contact',
      entityId: row.contact_id,
      actor: 'system:dispatcher',
      kind: 'draft_created',
      detail: { enrollmentId: row.id, step },
    })
    drafted++
  }
  return { drafted, exhausted }
}
