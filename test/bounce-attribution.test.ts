import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { parseBounce } from '../src/inbox/bounce'
import { processInboundMessage } from '../src/inbox/process'
import { processApprovedSends } from '../src/sequence/send'
import { getBreaker } from '../src/sequence/breaker'
import { mockGmail } from '../src/adapters/mocks'
import { DEFAULT_SETTINGS } from '../src/config/defaults'
import { createOwners, countRows } from './helpers'

const NOW = new Date('2026-07-07T12:00:00Z')
const deps = { llm: null, settings: DEFAULT_SETTINGS, now: NOW }

const DSN = (recipient: string) =>
  [
    'This is the mail delivery system at googlemail.com.',
    '',
    `Final-Recipient: rfc822; ${recipient}`,
    'Action: failed',
    'Status: 5.1.1',
    'Diagnostic-Code: smtp; 550 5.1.1 The email account does not exist.',
  ].join('\n')

async function sentLeadTo(email: string) {
  const [uid] = await createOwners()
  const co = await env.DB.prepare(
    "INSERT INTO companies (name, stage, timezone, assignee_id) VALUES ('Co', 'email_sequence', 'UTC', ?) RETURNING id",
  ).bind(uid).first<{ id: number }>()
  const ct = await env.DB.prepare(
    "INSERT INTO contacts (company_id, email, email_status) VALUES (?, ?, 'valid') RETURNING id",
  ).bind(co!.id, email).first<{ id: number }>()
  await env.DB.prepare(
    "INSERT INTO sequence_enrollments (company_id, contact_id, status, current_step) VALUES (?, ?, 'active', 1)",
  ).bind(co!.id, ct!.id).run()
  await env.DB.prepare(
    `INSERT INTO email_messages (company_id, contact_id, direction, status, subject, body, to_email, from_user_id, sent_at)
     VALUES (?, ?, 'outbound', 'sent', 's', 'b', ?, ?, ?)`,
  ).bind(co!.id, ct!.id, email, uid, NOW.toISOString()).run()
  return { uid, companyId: co!.id, contactId: ct!.id }
}

describe('parseBounce (deterministic DSN detection)', () => {
  it('recognises daemon senders and DSN structure, and extracts the failed recipient', () => {
    const b = parseBounce({
      fromEmail: 'mailer-daemon@googlemail.com',
      subject: 'Delivery Status Notification (Failure)',
      body: DSN('lead@biz.example'),
    })
    expect(b.isBounce).toBe(true)
    expect(b.failedRecipient).toBe('lead@biz.example')
  })

  it('recognises a postmaster "undeliverable" with an angle-bracket recipient', () => {
    const b = parseBounce({
      fromEmail: 'postmaster@corp.example',
      subject: 'Undeliverable: Quick intro',
      body: 'Your message to <buyer@corp.example> could not be delivered. 550 user unknown.',
    })
    expect(b.isBounce).toBe(true)
    expect(b.failedRecipient).toBe('buyer@corp.example')
  })

  it('does NOT flag a normal human reply as a bounce', () => {
    expect(parseBounce({ fromEmail: 'lead@biz.example', subject: 'Re: your email', body: 'Thanks, sounds great — happy to chat next week.' }).isBounce).toBe(false)
    expect(parseBounce({ fromEmail: 'lead@biz.example', subject: 'Re: delivery times', body: 'Your delivery was excellent, thank you.' }).isBounce).toBe(false)
  })
})

describe('bounce attribution through the inbox', () => {
  it('a mailer-daemon DSN marks the contact invalid and the last send bounced', async () => {
    const lead = await sentLeadTo('lead@biz.example')
    const res = await processInboundMessage(env.DB, env.KV, deps, {
      fromEmail: 'mailer-daemon@googlemail.com',
      subject: 'Delivery Status Notification (Failure)',
      body: DSN('lead@biz.example'),
      toUserId: lead.uid,
    })
    expect(res.cls).toBe('bounce')
    expect(await countRows('email_messages', "status = 'bounced'")).toBe(1)
    const ct = await env.DB.prepare('SELECT email_status FROM contacts WHERE id = ?').bind(lead.contactId).first<{ email_status: string }>()
    expect(ct?.email_status).toBe('invalid')
    expect(await countRows('activities', "kind = 'bounce_matched'")).toBe(1)
  })

  it('a bounce for an unknown recipient is audited, never silently dropped', async () => {
    await createOwners()
    const res = await processInboundMessage(env.DB, env.KV, deps, {
      fromEmail: 'mailer-daemon@googlemail.com',
      subject: 'Delivery Status Notification (Failure)',
      body: DSN('nobody@stranger.example'),
      toUserId: 1,
    })
    expect(res.handled).toBe(false)
    expect(await countRows('activities', "kind = 'bounce_unmatched'")).toBe(1)
    expect(await countRows('email_messages', "status = 'bounced'")).toBe(0)
  })

  it('realistic bounces feed the breaker and it trips at the threshold, then stops sending', async () => {
    // 25 real sends to the target (floor is 25), then one DSN bounce → 1/25 = 4% ≥ 3% → stop.
    const lead = await sentLeadTo('lead@biz.example')
    for (let i = 0; i < 24; i++) {
      await env.DB.prepare(
        `INSERT INTO email_messages (company_id, contact_id, direction, status, subject, body, to_email, from_user_id, sent_at)
         VALUES (?, ?, 'outbound', 'sent', 's', 'b', 'lead@biz.example', ?, ?)`,
      ).bind(lead.companyId, lead.contactId, lead.uid, NOW.toISOString()).run()
    }
    expect((await getBreaker(env.KV)).tripped).toBe(false)

    await processInboundMessage(env.DB, env.KV, deps, {
      fromEmail: 'mailer-daemon@googlemail.com',
      subject: 'Delivery Status Notification (Failure)',
      body: DSN('lead@biz.example'),
      toUserId: lead.uid,
    })
    expect((await getBreaker(env.KV)).tripped).toBe(true)
    expect(await countRows('activities', "kind = 'breaker_tripped'")).toBe(1)

    // With the breaker tripped, an approved message is now held, not sent.
    await env.DB.prepare(
      `INSERT INTO email_messages (company_id, contact_id, direction, status, subject, body, to_email, from_user_id, approved_at)
       VALUES (?, ?, 'outbound', 'approved', 's', 'b', 'lead@biz.example', ?, ?)`,
    ).bind(lead.companyId, lead.contactId, lead.uid, NOW.toISOString()).run()
    const sent: Array<{ to: string }> = []
    const tally = await processApprovedSends(env.DB, env.KV, DEFAULT_SETTINGS, {
      dryRun: false, now: NOW, gmailFor: async () => mockGmail(sent as never),
    })
    expect(tally.sent).toBe(0)
    expect(sent).toHaveLength(0)
    expect(await countRows('activities', "kind = 'send_held_breaker'")).toBeGreaterThan(0)
  })
})
