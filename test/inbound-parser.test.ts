import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { inboundParser } from '../src/adapters/inbound'
import { parseBounce } from '../src/inbox/bounce'
import { processInboundMessage } from '../src/inbox/process'
import { DEFAULT_SETTINGS } from '../src/config/defaults'
import { createOwners, countRows } from './helpers'

const NOW = new Date('2026-07-07T12:00:00Z')

const DSN_MIME = [
  'From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
  'To: owner@example.com',
  'Subject: Delivery Status Notification (Failure)',
  'Content-Type: multipart/report; report-type=delivery-status; boundary="B"',
  '',
  '--B',
  'Content-Type: text/plain; charset=UTF-8',
  '',
  'Your message could not be delivered.',
  '',
  '--B',
  'Content-Type: message/delivery-status',
  '',
  'Reporting-MTA: dns; googlemail.com',
  'Final-Recipient: rfc822; lead@biz.example',
  'Action: failed',
  'Status: 5.1.1',
  'Diagnostic-Code: smtp; 550 5.1.1 The email account does not exist.',
  '',
  '--B--',
  '',
].join('\r\n')

const REPLY_MIME = [
  'From: Jane Lead <lead@biz.example>',
  'To: owner@example.com',
  'Subject: Re: quick intro',
  'Content-Type: text/plain; charset=UTF-8',
  '',
  'Thanks, sounds great — happy to chat next week.',
  '',
].join('\r\n')

describe('inbound MIME parsing (postal-mime)', () => {
  it('parses a real DSN: from, subject, text, and the structured delivery-status', async () => {
    const p = await inboundParser.parse(DSN_MIME)
    expect(p.fromEmail).toBe('mailer-daemon@googlemail.com')
    expect(p.subject).toMatch(/Delivery Status Notification/)
    expect(p.dsn).not.toBeNull()
    expect(p.dsn?.finalRecipient).toBe('lead@biz.example')
    expect(p.dsn?.action).toBe('failed')
    expect(p.dsn?.status).toBe('5.1.1')
  })

  it('parses a normal reply with no DSN', async () => {
    const p = await inboundParser.parse(REPLY_MIME)
    expect(p.fromEmail).toBe('lead@biz.example')
    expect(p.subject).toBe('Re: quick intro')
    expect(p.text).toMatch(/happy to chat/)
    expect(p.dsn).toBeNull()
  })

  it('never throws on garbage input', async () => {
    const p = await inboundParser.parse('this is not a MIME message at all')
    expect(p.dsn).toBeNull()
  })
})

describe('structured DSN drives bounce attribution', () => {
  it('parseBounce trusts a structured DSN even when the body has no markers', () => {
    const b = parseBounce({
      fromEmail: 'mailer-daemon@googlemail.com',
      subject: 'notice',
      body: 'nothing useful here',
      dsn: { finalRecipient: 'lead@biz.example', action: 'failed', status: '5.1.1' },
    })
    expect(b.isBounce).toBe(true)
    expect(b.failedRecipient).toBe('lead@biz.example')
  })

  it('processInboundMessage attributes a structured bounce to the contact', async () => {
    const [uid] = await createOwners()
    const co = await env.DB.prepare(
      "INSERT INTO companies (name, stage, timezone, assignee_id) VALUES ('Co','email_sequence','UTC',?) RETURNING id",
    ).bind(uid).first<{ id: number }>()
    const ct = await env.DB.prepare(
      "INSERT INTO contacts (company_id, email, email_status) VALUES (?, 'lead@biz.example', 'valid') RETURNING id",
    ).bind(co!.id).first<{ id: number }>()
    await env.DB.prepare(
      `INSERT INTO email_messages (company_id, contact_id, direction, status, subject, body, to_email, from_user_id, sent_at)
       VALUES (?, ?, 'outbound', 'sent', 's', 'b', 'lead@biz.example', ?, ?)`,
    ).bind(co!.id, ct!.id, uid, NOW.toISOString()).run()

    const res = await processInboundMessage(
      env.DB, env.KV, { llm: null, settings: DEFAULT_SETTINGS, now: NOW },
      {
        fromEmail: 'mailer-daemon@googlemail.com',
        subject: 'Delivery Status Notification',
        body: '',
        toUserId: uid,
        dsn: { finalRecipient: 'lead@biz.example', action: 'failed', status: '5.1.1' },
      },
    )
    expect(res.cls).toBe('bounce')
    expect(await countRows('email_messages', "status = 'bounced'")).toBe(1)
    const c = await env.DB.prepare('SELECT email_status FROM contacts WHERE id = ?').bind(ct!.id).first<{ email_status: string }>()
    expect(c?.email_status).toBe('invalid')
    expect(await countRows('activities', "kind = 'bounce_matched'")).toBe(1)
  })
})
