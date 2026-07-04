import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { buildRawMessage, gmailAuthUrl } from '../src/adapters/gmail'
import { mockGmail } from '../src/adapters/mocks'
import { DEFAULT_SETTINGS } from '../src/config/defaults'
import { effectiveDailyCap } from '../src/sequence/caps'
import { evaluateBounceRate, getBreaker, resetBreaker, updateBreaker } from '../src/sequence/breaker'
import { approveDraft, autoApprovePastReview, isReviewModeActive } from '../src/sequence/review-mode'
import { processApprovedSends } from '../src/sequence/send'
import { createOwners, loginCookie, countRows, OWNER_A } from './helpers'

const NOW = new Date('2026-07-07T12:00:00Z') // Tuesday noon UTC — in window for tz=UTC

async function makeCompanyWithContact(tz = 'UTC') {
  const company = await env.DB.prepare(
    `INSERT INTO companies (name, stage, timezone) VALUES ('Send Co', 'email_sequence', ?) RETURNING id`,
  )
    .bind(tz)
    .first<{ id: number }>()
  const contact = await env.DB.prepare(
    `INSERT INTO contacts (company_id, email, email_status) VALUES (?, 'to@send.example', 'valid') RETURNING id`,
  )
    .bind(company!.id)
    .first<{ id: number }>()
  return { companyId: company!.id, contactId: contact!.id }
}

async function insertMessage(args: {
  companyId: number
  contactId: number
  status: string
  fromUserId?: number
  to?: string
  sentAt?: string
  approvedAt?: string
}) {
  await env.DB.prepare(
    `INSERT INTO email_messages
       (company_id, contact_id, direction, step, status, subject, body, to_email, from_user_id, sent_at, approved_at)
     VALUES (?, ?, 'outbound', 1, ?, 's', 'b', ?, ?, ?, ?)`,
  )
    .bind(
      args.companyId, args.contactId, args.status, args.to ?? 'to@send.example',
      args.fromUserId ?? null, args.sentAt ?? null, args.approvedAt ?? null,
    )
    .run()
}

describe('caps and weekly ramp', () => {
  it('ramps 5 → 10 → 15 and never exceeds the configured cap', () => {
    const s = DEFAULT_SETTINGS
    expect(effectiveDailyCap(s, null, NOW)).toBe(5) // fresh inbox
    const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 3600 * 1000).toISOString()
    expect(effectiveDailyCap(s, daysAgo(3), NOW)).toBe(5) // week 0
    expect(effectiveDailyCap(s, daysAgo(8), NOW)).toBe(10) // week 1
    expect(effectiveDailyCap(s, daysAgo(15), NOW)).toBe(15) // week 2 → at cap
    expect(effectiveDailyCap(s, daysAgo(90), NOW)).toBe(15) // never beyond cap
    expect(effectiveDailyCap({ ...s, weeklyRampEnabled: false }, null, NOW)).toBe(15)
  })
})

describe('bounce breaker: warn 2% · stop 3% · floor 25', () => {
  it('below the floor no rate can trip (24 sends, 1 bounce)', async () => {
    const { companyId, contactId } = await makeCompanyWithContact()
    for (let i = 0; i < 23; i++) {
      await insertMessage({ companyId, contactId, status: 'sent', sentAt: NOW.toISOString() })
    }
    await insertMessage({ companyId, contactId, status: 'bounced', sentAt: NOW.toISOString() })
    const verdict = await evaluateBounceRate(env.DB, DEFAULT_SETTINGS, NOW)
    expect(verdict.level).toBe('below_floor')
    await updateBreaker(env.DB, env.KV, DEFAULT_SETTINGS, NOW)
    expect((await getBreaker(env.KV)).tripped).toBe(false)
  })

  it('at the floor a 4% rate trips the breaker (25 sends, 1 bounce)', async () => {
    const { companyId, contactId } = await makeCompanyWithContact()
    for (let i = 0; i < 24; i++) {
      await insertMessage({ companyId, contactId, status: 'sent', sentAt: NOW.toISOString() })
    }
    await insertMessage({ companyId, contactId, status: 'bounced', sentAt: NOW.toISOString() })
    const verdict = await updateBreaker(env.DB, env.KV, DEFAULT_SETTINGS, NOW)
    expect(verdict.level).toBe('stop')
    expect((await getBreaker(env.KV)).tripped).toBe(true)
    expect(await countRows('activities', "kind = 'breaker_tripped'")).toBe(1)
  })

  it('warns at 2% without tripping; human reset clears a trip', async () => {
    const { companyId, contactId } = await makeCompanyWithContact()
    for (let i = 0; i < 98; i++) {
      await insertMessage({ companyId, contactId, status: 'sent', sentAt: NOW.toISOString() })
    }
    for (let i = 0; i < 2; i++) {
      await insertMessage({ companyId, contactId, status: 'bounced', sentAt: NOW.toISOString() })
    }
    const verdict = await updateBreaker(env.DB, env.KV, DEFAULT_SETTINGS, NOW)
    expect(verdict.level).toBe('warn')
    expect((await getBreaker(env.KV)).tripped).toBe(false)
    expect(await countRows('activities', "kind = 'breaker_warn'")).toBe(1)

    await env.KV.put('breaker', JSON.stringify({ tripped: true }))
    await resetBreaker(env.DB, env.KV, 'user:1')
    expect((await getBreaker(env.KV)).tripped).toBe(false)
    expect(await countRows('activities', "kind = 'breaker_reset'")).toBe(1)
  })
})

describe('the send path and its walls', () => {
  const deps = (dryRun: boolean, sent: Array<{ to: string; subject: string; body: string }>) => ({
    dryRun,
    gmailFor: async () => mockGmail(sent),
    now: NOW,
  })

  it('suppression wins at send time even after approval', async () => {
    const [ownerA] = await createOwners()
    const { companyId, contactId } = await makeCompanyWithContact()
    await env.DB.prepare(
      `INSERT INTO suppression (email, reason, added_by) VALUES ('to@send.example', 'stop_request', 'test')`,
    ).run()
    await insertMessage({
      companyId, contactId, status: 'approved', fromUserId: ownerA,
      approvedAt: NOW.toISOString(),
    })
    const sent: never[] = []
    const tally = await processApprovedSends(env.DB, env.KV, DEFAULT_SETTINGS, deps(false, sent))
    expect(tally.suppressed).toBe(1)
    expect(tally.sent).toBe(0)
    expect(sent).toHaveLength(0)
    expect(await countRows('email_messages', "status = 'cancelled'")).toBe(1)
  })

  it('DRY_RUN holds approved messages without faking anything', async () => {
    const [ownerA] = await createOwners()
    const { companyId, contactId } = await makeCompanyWithContact()
    await insertMessage({
      companyId, contactId, status: 'approved', fromUserId: ownerA,
      approvedAt: NOW.toISOString(),
    })
    const sent: never[] = []
    const tally = await processApprovedSends(env.DB, env.KV, DEFAULT_SETTINGS, deps(true, sent))
    expect(tally.dryRunHeld).toBe(1)
    expect(sent).toHaveLength(0)
    expect(await countRows('email_messages', "status = 'approved'")).toBe(1) // still approved, not fake-sent
    expect(await countRows('activities', "kind = 'dry_run_hold'")).toBe(1)
  })

  it('per-inbox cap blocks the 16th send of the day', async () => {
    const [ownerA] = await createOwners()
    const { companyId, contactId } = await makeCompanyWithContact()
    // One ancient send warms the ramp to full cap (15); then 15 sends
    // already landed today — the next one must be blocked.
    await insertMessage({
      companyId, contactId, status: 'sent', fromUserId: ownerA,
      sentAt: new Date(NOW.getTime() - 90 * 24 * 3600 * 1000).toISOString(),
    })
    for (let i = 0; i < 15; i++) {
      await insertMessage({
        companyId, contactId, status: 'sent', fromUserId: ownerA,
        sentAt: NOW.toISOString(),
      })
    }
    await insertMessage({
      companyId, contactId, status: 'approved', fromUserId: ownerA,
      approvedAt: NOW.toISOString(),
    })
    const sent: never[] = []
    const tally = await processApprovedSends(env.DB, env.KV, DEFAULT_SETTINGS, deps(false, sent))
    expect(tally.capped).toBe(1)
    expect(tally.sent).toBe(0)
  })

  it('with DRY_RUN off and a connected inbox, an approved message sends', async () => {
    const [ownerA] = await createOwners()
    const { companyId, contactId } = await makeCompanyWithContact()
    await insertMessage({
      companyId, contactId, status: 'approved', fromUserId: ownerA,
      approvedAt: NOW.toISOString(),
    })
    const sent: Array<{ to: string; subject: string; body: string }> = []
    const tally = await processApprovedSends(env.DB, env.KV, DEFAULT_SETTINGS, deps(false, sent))
    expect(tally.sent).toBe(1)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe('to@send.example')
    const row = await env.DB.prepare(
      `SELECT status, provider_message_id AS pid FROM email_messages WHERE status = 'sent'`,
    ).first<{ status: string; pid: string }>()
    expect(row?.pid).toBe('mock-1')
    expect(await countRows('activities', "kind = 'email_sent'")).toBe(1)
  })

  it('a tripped breaker stops the whole send path', async () => {
    const [ownerA] = await createOwners()
    const { companyId, contactId } = await makeCompanyWithContact()
    await insertMessage({
      companyId, contactId, status: 'approved', fromUserId: ownerA,
      approvedAt: NOW.toISOString(),
    })
    await env.KV.put('breaker', JSON.stringify({ tripped: true, reason: 'test trip' }))
    const sent: never[] = []
    const tally = await processApprovedSends(env.DB, env.KV, DEFAULT_SETTINGS, deps(false, sent))
    expect(tally.sent).toBe(0)
    expect(sent).toHaveLength(0)
    expect(await countRows('activities', "kind = 'send_held_breaker'")).toBe(1)
  })
})

describe('first-20 review mode', () => {
  it('is ON at launch, holds drafts, and automates only past the threshold', async () => {
    await createOwners()
    const { companyId, contactId } = await makeCompanyWithContact()
    expect(await isReviewModeActive(env.DB)).toBe(true)

    // A sequence draft does NOT auto-approve while review mode is on.
    await env.DB.prepare(
      `INSERT INTO sequence_enrollments (company_id, contact_id, status, current_step) VALUES (?, ?, 'active', 1)`,
    )
      .bind(companyId, contactId)
      .run()
    const enrollment = await env.DB.prepare('SELECT id FROM sequence_enrollments').first<{ id: number }>()
    await env.DB.prepare(
      `INSERT INTO email_messages (enrollment_id, company_id, contact_id, direction, step, status, subject, body, to_email)
       VALUES (?, ?, ?, 'outbound', 1, 'draft', 's', 'b', 'to@send.example')`,
    )
      .bind(enrollment!.id, companyId, contactId)
      .run()
    expect(await autoApprovePastReview(env.DB, NOW)).toBe(0)
    expect(await countRows('email_messages', "status = 'draft'")).toBe(1)

    // Owner approves it (1 of 20) — counter moves, mode stays on.
    const draft = await env.DB.prepare(`SELECT id FROM email_messages WHERE status = 'draft'`).first<{ id: number }>()
    expect(await approveDraft(env.DB, draft!.id, 'user:1', NOW)).toBe(true)
    expect(await isReviewModeActive(env.DB)).toBe(true)

    // Simulate the rest of the first 20 — then automation kicks in.
    for (let i = 0; i < 19; i++) {
      await insertMessage({
        companyId, contactId, status: 'sent',
        sentAt: NOW.toISOString(), approvedAt: NOW.toISOString(),
      })
    }
    expect(await isReviewModeActive(env.DB)).toBe(false)
    await env.DB.prepare(
      `INSERT INTO email_messages (enrollment_id, company_id, contact_id, direction, step, status, subject, body, to_email)
       VALUES (?, ?, ?, 'outbound', 2, 'draft', 's', 'b', 'to@send.example')`,
    )
      .bind(enrollment!.id, companyId, contactId)
      .run()
    expect(await autoApprovePastReview(env.DB, NOW)).toBe(1)
    expect(await countRows('email_messages', "approved_by = 'system:auto'")).toBe(1)
  })
})

describe('gmail plumbing', () => {
  it('builds a base64url RFC822 message that survives unicode', () => {
    const raw = buildRawMessage({
      from: 'owner@maranasi.example',
      to: 'lead@biz.example',
      subject: 'Hello',
      body: 'Zażółć gęślą jaźń — plain text.',
    })
    expect(raw).not.toMatch(/[+/=]/)
    const decoded = atob(raw.replaceAll('-', '+').replaceAll('_', '/'))
    expect(decoded).toContain('To: lead@biz.example')
    expect(decoded).toContain('Content-Type: text/plain')
  })

  it('auth URL carries send scope, offline access, and state', () => {
    const url = new URL(gmailAuthUrl({ clientId: 'cid', redirectUri: 'https://x/cb', state: 'nonce1' }))
    expect(url.searchParams.get('scope')).toContain('gmail.send')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('state')).toBe('nonce1')
  })

  it('connect route holds without client credentials', async () => {
    await createOwners()
    const cookie = await loginCookie(OWNER_A.email, OWNER_A.password)
    const res = await SELF.fetch('http://engine.local/api/gmail/connect', {
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(409)
    const body = await res.json<{ error: string }>()
    expect(body.error).toContain('GMAIL_CLIENT_ID')
  })
})
