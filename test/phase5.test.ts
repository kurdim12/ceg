import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/config/defaults'
import { evaluateDropGate } from '../src/ops/phone-gate'
import { evaluateAlerts, LAST_TICK_KEY } from '../src/ops/alerts'
import { buildDailyRecap } from '../src/ops/recap'
import { runRecyclers } from '../src/ops/recyclers'
import { createOwners, loginCookie, countRows, OWNER_A } from './helpers'

const NOW = new Date('2026-07-07T12:00:00Z')
const BASE = 'http://engine.local'

async function makeCallLead(assigneeId: number, stage = 'no_valid_email') {
  const company = await env.DB.prepare(
    `INSERT INTO companies (name, stage, timezone, assignee_id, phone, phone_format_valid)
     VALUES ('Call Co', ?, 'UTC', ?, '+1 555 0100', 1) RETURNING id`,
  )
    .bind(stage, assigneeId)
    .first<{ id: number }>()
  const contact = await env.DB.prepare(
    `INSERT INTO contacts (company_id, name, email, email_status) VALUES (?, 'Pat', 'pat@call.example', 'invalid') RETURNING id`,
  )
    .bind(company!.id)
    .first<{ id: number }>()
  return { companyId: company!.id, contactId: contact!.id }
}

async function logFailedCall(companyId: number, byUserId: number, at: Date) {
  await env.DB.prepare(
    `INSERT INTO call_attempts (company_id, by_user_id, outcome, created_at) VALUES (?, ?, 'no-answer', ?)`,
  )
    .bind(companyId, byUserId, at.toISOString().slice(0, 19).replace('T', ' '))
    .run()
}

describe('phone drop gate: 3 failed attempts SPREAD over 2 weeks', () => {
  it('three same-day failures do not open the gate', async () => {
    const [a] = await createOwners()
    const { companyId } = await makeCallLead(a)
    for (let i = 0; i < 3; i++) await logFailedCall(companyId, a, NOW)
    const gate = await evaluateDropGate(env.DB, DEFAULT_SETTINGS, companyId)
    expect(gate.droppable).toBe(false)
    expect(gate.reason).toContain('spread')
  })

  it('three failures spread over 15 days open it; answered calls never count', async () => {
    const [a] = await createOwners()
    const { companyId } = await makeCallLead(a)
    await logFailedCall(companyId, a, new Date(NOW.getTime() - 15 * 24 * 3600 * 1000))
    await logFailedCall(companyId, a, new Date(NOW.getTime() - 8 * 24 * 3600 * 1000))
    await logFailedCall(companyId, a, NOW)
    // An answered call in between changes nothing about the failed count.
    await env.DB.prepare(
      `INSERT INTO call_attempts (company_id, by_user_id, outcome) VALUES (?, ?, 'answered-not-interested')`,
    )
      .bind(companyId, a)
      .run()
    const gate = await evaluateDropGate(env.DB, DEFAULT_SETTINGS, companyId)
    expect(gate.droppable).toBe(true)
    expect(gate.failedAttempts).toBe(3)
  })

  it('two failures are never enough', async () => {
    const [a] = await createOwners()
    const { companyId } = await makeCallLead(a)
    await logFailedCall(companyId, a, new Date(NOW.getTime() - 20 * 24 * 3600 * 1000))
    await logFailedCall(companyId, a, NOW)
    const gate = await evaluateDropGate(env.DB, DEFAULT_SETTINGS, companyId)
    expect(gate.droppable).toBe(false)
    expect(gate.reason).toContain('2/3')
  })
})

describe('call screen actions over HTTP', () => {
  it('logs outcomes; answered confirms the phone; queue is per-assignee', async () => {
    const [a, b] = await createOwners()
    const mine = await makeCallLead(a)
    await makeCallLead(b) // the other owner's lead — must not appear
    const cookie = await loginCookie(OWNER_A.email, OWNER_A.password)

    const logged = await SELF.fetch(BASE + '/api/calls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ companyId: mine.companyId, outcome: 'answered-interested', notes: 'wants a call back' }),
    })
    expect(logged.status).toBe(200)
    const company = await env.DB.prepare('SELECT phone_confirmed AS pc FROM companies WHERE id = ?')
      .bind(mine.companyId)
      .first<{ pc: number }>()
    expect(company?.pc).toBe(1)

    const bad = await SELF.fetch(BASE + '/api/calls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ companyId: mine.companyId, outcome: 'hung-up-angrily' }),
    })
    expect(bad.status).toBe(400)

    const queueRes = await SELF.fetch(BASE + '/api/call-queue', { headers: { Cookie: cookie } })
    const { queue } = await queueRes.json<{ queue: Array<{ id: number; dropGate: { droppable: boolean } }> }>()
    expect(queue).toHaveLength(1) // owner A sees only their own lead
    expect(queue[0]!.id).toBe(mine.companyId)
    expect(queue[0]!.dropGate.droppable).toBe(false)
  })

  it('books a meeting from the call screen: row lands, stage moves', async () => {
    const [a] = await createOwners()
    const { companyId, contactId } = await makeCallLead(a)
    const cookie = await loginCookie(OWNER_A.email, OWNER_A.password)
    const res = await SELF.fetch(BASE + '/api/meetings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ companyId, contactId, scheduledAt: '2026-07-10T09:00:00Z' }),
    })
    expect(res.status).toBe(200)
    expect(await countRows('meetings', `company_id = ${companyId}`)).toBe(1)
    const stage = await env.DB.prepare('SELECT stage FROM companies WHERE id = ?')
      .bind(companyId)
      .first<{ stage: string }>()
    expect(stage?.stage).toBe('meeting_booked')
  })

  it('drop confirm: closed gate 409s, open gate drops, reject resolves', async () => {
    const [a] = await createOwners()
    const { companyId } = await makeCallLead(a)
    await env.DB.prepare(
      `INSERT INTO drop_requests (company_id, prepared_by, reason) VALUES (?, 'agent', 'unreachable')`,
    )
      .bind(companyId)
      .run()
    const dropId = (await env.DB.prepare('SELECT id FROM drop_requests').first<{ id: number }>())!.id
    const cookie = await loginCookie(OWNER_A.email, OWNER_A.password)

    // Gate closed: no failed attempts yet.
    const closed = await SELF.fetch(`${BASE}/api/drops/${dropId}/confirm`, {
      method: 'POST', headers: { Cookie: cookie },
    })
    expect(closed.status).toBe(409)

    // Open the gate properly, then confirm.
    await logFailedCall(companyId, a, new Date(NOW.getTime() - 16 * 24 * 3600 * 1000))
    await logFailedCall(companyId, a, new Date(NOW.getTime() - 8 * 24 * 3600 * 1000))
    await logFailedCall(companyId, a, NOW)
    const confirmed = await SELF.fetch(`${BASE}/api/drops/${dropId}/confirm`, {
      method: 'POST', headers: { Cookie: cookie },
    })
    expect(confirmed.status).toBe(200)
    const stage = await env.DB.prepare('SELECT stage FROM companies WHERE id = ?')
      .bind(companyId)
      .first<{ stage: string }>()
    expect(stage?.stage).toBe('dropped')

    // WhatsApp is manual — the CRM only logs it.
    const wa = await SELF.fetch(BASE + '/api/whatsapp-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ companyId, note: 'sent a WhatsApp from my phone' }),
    })
    expect(wa.status).toBe(200)
    expect(await countRows('activities', "kind = 'whatsapp_logged'")).toBe(1)
  })
})

describe('daily recap', () => {
  it('counts the day and sections the call queue per assignee', async () => {
    const [a, b] = await createOwners()
    await makeCallLead(a)
    await makeCallLead(b)
    // Real clock here: created_at defaults to datetime('now') in D1.
    const recap = await buildDailyRecap(env.DB, env, DEFAULT_SETTINGS, new Date())
    expect(recap.newLeadsSourced).toBe(2)
    expect(recap.perAssignee).toHaveLength(2)
    expect(recap.perAssignee[0]!.callQueue).toHaveLength(1)
    expect(recap.perAssignee[1]!.callQueue).toHaveLength(1)
    expect(recap.bounce.level).toBe('below_floor')
    // Keys are all unset in tests → the holding alarm is present.
    expect(recap.alarms.some((al) => al.kind === 'api_key_missing')).toBe(true)
  })
})

describe('system alerts', () => {
  it('raises breaker, missed-cron, and disconnected-after-connected alerts', async () => {
    const [a] = await createOwners()
    await env.KV.put('breaker', JSON.stringify({ tripped: true, reason: 'test' }))
    await env.KV.put(LAST_TICK_KEY, new Date(NOW.getTime() - 3 * 3600 * 1000).toISOString())
    // Owner A connected once, then disconnected.
    await env.DB.prepare(
      `INSERT INTO activities (entity_type, entity_id, actor, kind) VALUES ('user', ?, 'user:1', 'gmail_connected')`,
    )
      .bind(a)
      .run()
    const alerts = await evaluateAlerts(env.DB, env, DEFAULT_SETTINGS, NOW)
    const kinds = alerts.map((al) => al.kind)
    expect(kinds).toContain('breaker_tripped')
    expect(kinds).toContain('cron_missed')
    expect(kinds).toContain('gmail_disconnected')
  })
})

describe('recyclers', () => {
  async function agedCompany(stage: 'lost' | 'dropped', monthsAgo: number, email?: string) {
    const changed = `datetime('now', '-${monthsAgo} months')`
    const company = await env.DB.prepare(
      `INSERT INTO companies (name, stage, stage_changed_at) VALUES ('Aged Co', ?, ${changed}) RETURNING id`,
    )
      .bind(stage)
      .first<{ id: number }>()
    if (email) {
      await env.DB.prepare(`INSERT INTO contacts (company_id, email) VALUES (?, ?)`)
        .bind(company!.id, email)
        .run()
    }
    return company!.id
  }

  it('recycles lost after 6 months and dropped after 12, not before', async () => {
    await createOwners()
    const oldLost = await agedCompany('lost', 7)
    const freshLost = await agedCompany('lost', 5)
    const oldDrop = await agedCompany('dropped', 13)
    const freshDrop = await agedCompany('dropped', 11)

    const result = await runRecyclers(env.DB, DEFAULT_SETTINGS, NOW)
    expect(result).toEqual({ lostRecycled: 1, droppedRecycled: 1 })

    const stageOf = async (id: number) =>
      (await env.DB.prepare('SELECT stage FROM companies WHERE id = ?').bind(id).first<{ stage: string }>())!.stage
    expect(await stageOf(oldLost)).toBe('new')
    expect(await stageOf(freshLost)).toBe('lost')
    expect(await stageOf(oldDrop)).toBe('new')
    expect(await stageOf(freshDrop)).toBe('dropped')
  })

  it('never recycles a lead whose contact asked to stop', async () => {
    await createOwners()
    const suppressed = await agedCompany('lost', 24, 'stop@aged.example')
    await env.DB.prepare(
      `INSERT INTO suppression (email, reason, added_by) VALUES ('stop@aged.example', 'stop_request', 'system:inbox')`,
    ).run()
    const result = await runRecyclers(env.DB, DEFAULT_SETTINGS, NOW)
    expect(result.lostRecycled).toBe(0)
    const stage = await env.DB.prepare('SELECT stage FROM companies WHERE id = ?')
      .bind(suppressed)
      .first<{ stage: string }>()
    expect(stage?.stage).toBe('lost') // a stop outlives every clock
  })
})
