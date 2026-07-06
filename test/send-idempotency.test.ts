import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { processApprovedSends } from '../src/sequence/send'
import { mockGmail } from '../src/adapters/mocks'
import { DEFAULT_SETTINGS } from '../src/config/defaults'
import { createOwners, countRows } from './helpers'

const NOW = new Date('2026-07-07T12:00:00Z') // Tuesday noon UTC, tz=UTC in window

async function companyContact(uid: number, email = 'to@x.example') {
  const c = await env.DB.prepare(
    "INSERT INTO companies (name, stage, timezone, assignee_id) VALUES ('Co', 'email_sequence', 'UTC', ?) RETURNING id",
  ).bind(uid).first<{ id: number }>()
  const ct = await env.DB.prepare(
    "INSERT INTO contacts (company_id, email, email_status) VALUES (?, ?, 'valid') RETURNING id",
  ).bind(c!.id, email).first<{ id: number }>()
  return { companyId: c!.id, contactId: ct!.id }
}

async function approve(companyId: number, contactId: number, uid: number, to: string) {
  await env.DB.prepare(
    `INSERT INTO email_messages (company_id, contact_id, direction, status, subject, body, to_email, from_user_id, approved_at)
     VALUES (?, ?, 'outbound', 'approved', 's', 'b', ?, ?, ?)`,
  ).bind(companyId, contactId, to, uid, NOW.toISOString()).run()
}

const okDeps = (sent: Array<{ to: string }>) => ({
  dryRun: false, now: NOW, gmailFor: async () => mockGmail(sent as never),
})

describe('send idempotency and error isolation', () => {
  it('one Gmail error does not stop the other messages in the batch', async () => {
    const [uid] = await createOwners()
    const { companyId, contactId } = await companyContact(uid)
    for (const to of ['a@x.example', 'boom@x.example', 'c@x.example']) {
      await approve(companyId, contactId, uid, to)
    }
    const sent: string[] = []
    const deps = {
      dryRun: false, now: NOW,
      gmailFor: async () => ({
        async send({ to }: { to: string }) {
          if (to === 'boom@x.example') throw new Error('gmail 429 rate limited')
          sent.push(to)
          return { providerMessageId: `ok-${sent.length}` }
        },
      }),
    }
    const tally = await processApprovedSends(env.DB, env.KV, DEFAULT_SETTINGS, deps)
    expect(tally.sent).toBe(2) // the two good ones went
    expect(tally.failed).toBe(1) // the bad one is isolated
    expect(sent.sort()).toEqual(['a@x.example', 'c@x.example'])
    expect(await countRows('email_messages', "status = 'sent'")).toBe(2)
    expect(await countRows('email_messages', "status = 'failed'")).toBe(1)
    expect(await countRows('activities', "kind = 'send_failed'")).toBe(1)
  })

  it('a message left in "sending" (sent but not marked) is NEVER re-sent — no duplicate', async () => {
    const [uid] = await createOwners()
    const { companyId, contactId } = await companyContact(uid)
    // Simulate a prior tick that sent at the provider but crashed before the
    // DB mark-sent: the row is stuck in 'sending' with a stale claim.
    const stale = new Date(NOW.getTime() - 30 * 60 * 1000).toISOString()
    await env.DB.prepare(
      `INSERT INTO email_messages (company_id, contact_id, direction, status, subject, body, to_email, from_user_id, approved_at, send_claimed_at)
       VALUES (?, ?, 'outbound', 'sending', 's', 'b', 'to@x.example', ?, ?, ?)`,
    ).bind(companyId, contactId, uid, NOW.toISOString(), stale).run()

    const sent: Array<{ to: string }> = []
    const tally = await processApprovedSends(env.DB, env.KV, DEFAULT_SETTINGS, okDeps(sent))
    expect(sent).toHaveLength(0) // the provider is NOT called again
    expect(tally.sent).toBe(0)
    expect(tally.needsReview).toBe(1)
    expect(await countRows('email_messages', "status = 'needs_review'")).toBe(1)
    expect(await countRows('email_messages', "status = 'sending'")).toBe(0)
    expect(await countRows('activities', "kind = 'send_needs_review'")).toBe(1)
  })

  it('CAS claim: two concurrent ticks send an approved message exactly once', async () => {
    const [uid] = await createOwners()
    const { companyId, contactId } = await companyContact(uid)
    await approve(companyId, contactId, uid, 'to@x.example')

    const sent: Array<{ to: string }> = []
    // Same shared sink; whichever tick wins the claim is the only one to send.
    const [t1, t2] = await Promise.all([
      processApprovedSends(env.DB, env.KV, DEFAULT_SETTINGS, okDeps(sent)),
      processApprovedSends(env.DB, env.KV, DEFAULT_SETTINGS, okDeps(sent)),
    ])
    expect(sent).toHaveLength(1) // never twice
    expect(t1.sent + t2.sent).toBe(1)
    expect(await countRows('email_messages', "status = 'sent'")).toBe(1)
  })

  it('DRY_RUN still holds without claiming or sending', async () => {
    const [uid] = await createOwners()
    const { companyId, contactId } = await companyContact(uid)
    await approve(companyId, contactId, uid, 'to@x.example')
    const sent: Array<{ to: string }> = []
    const tally = await processApprovedSends(env.DB, env.KV, DEFAULT_SETTINGS, {
      dryRun: true, now: NOW, gmailFor: async () => mockGmail(sent as never),
    })
    expect(sent).toHaveLength(0)
    expect(tally.dryRunHeld).toBe(1)
    expect(await countRows('email_messages', "status = 'approved'")).toBe(1) // untouched, not claimed
    expect(await countRows('email_messages', "status = 'sending'")).toBe(0)
  })

  it('suppression still cancels before any claim or send', async () => {
    const [uid] = await createOwners()
    const { companyId, contactId } = await companyContact(uid, 'stop@x.example')
    await env.DB.prepare(
      "INSERT INTO suppression (email, reason, added_by) VALUES ('stop@x.example', 'stop_request', 'test')",
    ).run()
    await approve(companyId, contactId, uid, 'stop@x.example')
    const sent: Array<{ to: string }> = []
    const tally = await processApprovedSends(env.DB, env.KV, DEFAULT_SETTINGS, okDeps(sent))
    expect(tally.suppressed).toBe(1)
    expect(sent).toHaveLength(0)
    expect(await countRows('email_messages', "status = 'cancelled'")).toBe(1)
  })
})
