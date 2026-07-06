import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { getTool } from '../src/agent/registry'
import { processApprovedSends } from '../src/sequence/send'
import { mockGmail } from '../src/adapters/mocks'
import { DEFAULT_SETTINGS } from '../src/config/defaults'
import { createOwners, countRows } from './helpers'

const NOW = new Date('2026-07-07T12:00:00Z')
const ctx = () => ({ db: env.DB, kv: env.KV, llm: null, userId: 1 })

async function lead(emailStatus: string, email = 'lead@x.example') {
  const [uid] = await createOwners()
  const co = await env.DB.prepare(
    "INSERT INTO companies (name, stage, timezone, assignee_id) VALUES ('Co', 'new', 'UTC', ?) RETURNING id",
  ).bind(uid).first<{ id: number }>()
  const ct = await env.DB.prepare(
    'INSERT INTO contacts (company_id, email, email_status) VALUES (?, ?, ?) RETURNING id',
  ).bind(co!.id, email, emailStatus).first<{ id: number }>()
  return { uid, companyId: co!.id, contactId: ct!.id }
}

const send = (companyId: number, contactId: number) =>
  getTool('send_email')!.execute(ctx(), { companyId, contactId, subject: 'Hi', body: 'Body text here' })

describe('agent send_email cannot bypass the safe pipeline', () => {
  it('holds a DRAFT for an unverified contact instead of sending', async () => {
    const l = await lead('unverified')
    const res = await send(l.companyId, l.contactId)
    expect(res.held).toBe(true)
    expect(await countRows('email_messages', "status = 'draft'")).toBe(1)
    expect(await countRows('email_messages', "status = 'approved'")).toBe(0)
    expect(await countRows('activities', "kind = 'agent_send_held'")).toBe(1)
  })

  it('holds a DRAFT for a bounced/invalid contact', async () => {
    const l = await lead('invalid')
    const res = await send(l.companyId, l.contactId)
    expect(res.held).toBe(true)
    expect(await countRows('email_messages', "status = 'approved'")).toBe(0)
  })

  it('refuses outright for a suppressed address — no message at all', async () => {
    const l = await lead('valid', 'stop@x.example')
    await env.DB.prepare(
      "INSERT INTO suppression (email, reason, added_by) VALUES ('stop@x.example', 'stop_request', 'test')",
    ).run()
    const res = await send(l.companyId, l.contactId)
    expect(res.blocked).toBe(true)
    expect(await countRows('email_messages')).toBe(0)
    expect(await countRows('activities', "kind = 'agent_send_blocked'")).toBe(1)
  })

  it('holds a DRAFT when the bounce breaker is tripped, even for a valid contact', async () => {
    const l = await lead('valid')
    await env.KV.put('breaker', JSON.stringify({ tripped: true, reason: 'test' }))
    const res = await send(l.companyId, l.contactId)
    expect(res.held).toBe(true)
    expect(await countRows('email_messages', "status = 'approved'")).toBe(0)
  })

  it('holds a DRAFT when sending is manually paused, even for a valid contact', async () => {
    const l = await lead('valid')
    await env.KV.put('sending:paused', JSON.stringify({ paused: true, by: 'user:1' }))
    const res = await send(l.companyId, l.contactId)
    expect(res.held).toBe(true)
    expect(await countRows('email_messages', "status = 'approved'")).toBe(0)
  })

  it('queues an APPROVED send for a verified contact — which DRY_RUN then holds', async () => {
    const l = await lead('valid')
    const res = await send(l.companyId, l.contactId)
    expect(res.ok).toBe(true)
    expect(await countRows('email_messages', "status = 'approved' AND approved_by = 'agent'")).toBe(1)
    // The approved agent send still respects DRY_RUN at dispatch time.
    const sent: Array<{ to: string }> = []
    const tally = await processApprovedSends(env.DB, env.KV, DEFAULT_SETTINGS, {
      dryRun: true, now: NOW, gmailFor: async () => mockGmail(sent as never),
    })
    expect(sent).toHaveLength(0)
    expect(tally.dryRunHeld).toBe(1)
  })
})
