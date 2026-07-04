import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { mockGmail } from '../src/adapters/mocks'
import { DEFAULT_SETTINGS } from '../src/config/defaults'
import { advanceDueEnrollments, enrollContact } from '../src/sequence/enroll'
import { processApprovedSends } from '../src/sequence/send'
import { createOwners, countRows } from './helpers'

// Tuesday noon UTC: 72h hops land Fri → Mon → Thu — always weekdays, in window.
const T0 = new Date('2026-07-07T12:00:00Z')
const plusHours = (h: number) => new Date(T0.getTime() + h * 3600 * 1000)

async function enrolledLead(assigneeId: number) {
  const company = await env.DB.prepare(
    `INSERT INTO companies (name, stage, timezone, assignee_id) VALUES ('Seq Co', 'email_sequence', 'UTC', ?) RETURNING id`,
  )
    .bind(assigneeId)
    .first<{ id: number }>()
  const contact = await env.DB.prepare(
    `INSERT INTO contacts (company_id, name, email, email_status) VALUES (?, 'Sam', 'sam@seq.example', 'valid') RETURNING id`,
  )
    .bind(company!.id)
    .first<{ id: number }>()
  await enrollContact(env.DB, {
    companyId: company!.id, contactId: contact!.id, actor: 'test', now: T0,
  })
  return { companyId: company!.id, contactId: contact!.id }
}

describe('the sequence engine honors the full contract (flip-gate box 8)', () => {
  it('3 steps, different angles, 72h apart, never a resend, exhausted → unresponsive_email', async () => {
    const [a] = await createOwners()
    const lead = await enrolledLead(a)

    // Step 1 drafts immediately; a premature tick drafts nothing new.
    expect((await advanceDueEnrollments(env.DB, DEFAULT_SETTINGS, T0)).drafted).toBe(1)
    expect((await advanceDueEnrollments(env.DB, DEFAULT_SETTINGS, plusHours(1))).drafted).toBe(0)

    // Steps 2 and 3 at 72h spacing.
    expect((await advanceDueEnrollments(env.DB, DEFAULT_SETTINGS, plusHours(72))).drafted).toBe(1)
    expect((await advanceDueEnrollments(env.DB, DEFAULT_SETTINGS, plusHours(144))).drafted).toBe(1)

    // Fourth tick: no step 4 — the enrollment exhausts and the LEAD parks.
    const final = await advanceDueEnrollments(env.DB, DEFAULT_SETTINGS, plusHours(216))
    expect(final.drafted).toBe(0)
    expect(final.exhausted).toBe(1)

    const drafts = await env.DB.prepare(
      `SELECT step, subject, body FROM email_messages WHERE company_id = ? ORDER BY step`,
    )
      .bind(lead.companyId)
      .all<{ step: number; subject: string; body: string }>()
    expect(drafts.results.map((d) => d.step)).toEqual([1, 2, 3])
    // Different angle each step: all subjects and bodies distinct — never a resend.
    expect(new Set(drafts.results.map((d) => d.subject)).size).toBe(3)
    expect(new Set(drafts.results.map((d) => d.body)).size).toBe(3)
    // Plain text, at most one link each.
    for (const d of drafts.results) {
      expect(d.body).not.toContain('<')
      expect((d.body.match(/https?:\/\//g) ?? []).length).toBeLessThanOrEqual(1)
    }

    const company = await env.DB.prepare('SELECT stage FROM companies WHERE id = ?')
      .bind(lead.companyId)
      .first<{ stage: string }>()
    expect(company?.stage).toBe('unresponsive_email') // flagged, never dropped
    expect(await countRows('activities', "kind = 'sequence_exhausted'")).toBe(1)
  })

  it('contact stagger: the next contact must wait out the 3-day gap', async () => {
    const [a] = await createOwners()
    const lead = await enrolledLead(a)
    // First contact's enrollment ends now (stopped).
    await env.DB.prepare(
      `UPDATE sequence_enrollments SET status = 'stopped', updated_at = ? WHERE company_id = ?`,
    )
      .bind(T0.toISOString().slice(0, 19).replace('T', ' '), lead.companyId)
      .run()
    const second = await env.DB.prepare(
      `INSERT INTO contacts (company_id, email, email_status) VALUES (?, 'two@seq.example', 'valid') RETURNING id`,
    )
      .bind(lead.companyId)
      .first<{ id: number }>()

    // Two days later: blocked by the stagger.
    await expect(
      enrollContact(env.DB, {
        companyId: lead.companyId, contactId: second!.id, actor: 'test',
        now: plusHours(48), settings: DEFAULT_SETTINGS,
      }),
    ).rejects.toThrow(/stagger/)
    // Five days later: allowed.
    const id = await enrollContact(env.DB, {
      companyId: lead.companyId, contactId: second!.id, actor: 'test',
      now: plusHours(120), settings: DEFAULT_SETTINGS,
    })
    expect(id).toBeGreaterThan(0)
  })

  it('verify-before-send holds end to end: a non-valid contact never receives a sequence email', async () => {
    const [a] = await createOwners()
    const lead = await enrolledLead(a)
    await advanceDueEnrollments(env.DB, DEFAULT_SETTINGS, T0) // step-1 draft
    await env.DB.prepare(`UPDATE email_messages SET status = 'approved', approved_at = ?, from_user_id = ? WHERE company_id = ?`)
      .bind(T0.toISOString(), a, lead.companyId)
      .run()
    // The contact's email degrades (e.g. re-verify said catch_all) after approval.
    await env.DB.prepare(`UPDATE contacts SET email_status = 'catch_all' WHERE id = ?`)
      .bind(lead.contactId)
      .run()

    const sent: never[] = []
    const tally = await processApprovedSends(env.DB, env.KV, DEFAULT_SETTINGS, {
      dryRun: false,
      gmailFor: async () => mockGmail(sent),
      now: T0,
    })
    expect(tally.sent).toBe(0)
    expect(sent).toHaveLength(0)
    expect(await countRows('email_messages', "status = 'cancelled'")).toBe(1)
    expect(await countRows('activities', "kind = 'send_cancelled_unverified'")).toBe(1)
  })
})
