import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { processApprovedSends } from '../src/sequence/send'
import { getPauseState, setSendingPaused } from '../src/ops/pause'
import { DEFAULT_SETTINGS } from '../src/config/defaults'
import { createOwners, createCompany, loginCookie, countRows, OWNER_A } from './helpers'

const BASE = 'http://engine.local'

/** A Gmail adapter that records every send — nothing should reach it in DRY_RUN/pause. */
function spyGmail() {
  const sent: Array<{ to: string }> = []
  return {
    sent,
    deps: (dryRun: boolean) => ({
      dryRun,
      now: new Date('2026-03-04T12:00:00Z'), // a Wednesday, inside the window
      gmailFor: async () => ({
        async send({ to }: { to: string }) {
          sent.push({ to })
          return { providerMessageId: `spy-${sent.length}` }
        },
      }),
    }),
  }
}

/** Seed one fully-approved, sendable message for owner `uid`. */
async function seedApproved(uid: number): Promise<void> {
  const companyId = await createCompany({ stage: 'email_sequence', assigneeId: uid })
  await env.DB.prepare("UPDATE companies SET timezone = 'UTC' WHERE id = ?").bind(companyId).run()
  const contact = await env.DB.prepare(
    "INSERT INTO contacts (company_id, email, email_status) VALUES (?, 'lead@ok.example', 'valid') RETURNING id",
  ).bind(companyId).first<{ id: number }>()
  await env.DB.prepare(
    `INSERT INTO email_messages (company_id, contact_id, direction, status, subject, body, to_email, from_user_id, approved_at, approved_by)
     VALUES (?, ?, 'outbound', 'approved', 'Hi', 'Body', 'lead@ok.example', ?, datetime('now'), 'test')`,
  ).bind(companyId, contact!.id, uid).run()
}

describe('DRY_RUN prevents a real send', () => {
  it('holds every approved message and calls no inbox', async () => {
    const [a] = await createOwners()
    await seedApproved(a)
    const spy = spyGmail()
    const tally = await processApprovedSends(env.DB, env.KV, DEFAULT_SETTINGS, spy.deps(true))
    expect(spy.sent).toHaveLength(0)
    expect(tally.dryRunHeld).toBe(1)
    expect(tally.sent).toBe(0)
    expect(await countRows('email_messages', "status = 'sent'")).toBe(0)
  })
})

describe('emergency pause switch', () => {
  it('stops all sending even with DRY_RUN off and everything else green', async () => {
    const [a] = await createOwners()
    await seedApproved(a)
    await setSendingPaused(env.DB, env.KV, true, 'user:1', new Date(), 'test halt')
    expect((await getPauseState(env.KV)).paused).toBe(true)

    const spy = spyGmail()
    const tally = await processApprovedSends(env.DB, env.KV, DEFAULT_SETTINGS, spy.deps(false))
    expect(spy.sent).toHaveLength(0)
    expect(tally.sent).toBe(0)
    expect(await countRows('activities', "kind = 'send_held_paused'")).toBeGreaterThan(0)

    // Resume clears it.
    await setSendingPaused(env.DB, env.KV, false, 'user:1', new Date())
    expect((await getPauseState(env.KV)).paused).toBe(false)
  })

  it('pause/resume routes are auth-gated and audited', async () => {
    await createOwners()
    const anon = await SELF.fetch(`${BASE}/api/sending/pause`, { method: 'POST' })
    expect(anon.status).toBe(401)

    const cookie = await loginCookie(OWNER_A.email, OWNER_A.password)
    const paused = await SELF.fetch(`${BASE}/api/sending/pause`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ reason: 'drill' }),
    })
    expect(paused.status).toBe(200)
    expect((await getPauseState(env.KV)).paused).toBe(true)
    expect(await countRows('activities', "kind = 'sending_paused'")).toBe(1)
  })
})

describe('safe test-email flow', () => {
  it('in DRY_RUN reports the target without sending, and stays auth-gated', async () => {
    await createOwners()
    const anon = await SELF.fetch(`${BASE}/api/sending/test`, { method: 'POST' })
    expect(anon.status).toBe(401)

    const cookie = await loginCookie(OWNER_A.email, OWNER_A.password)
    const res = await SELF.fetch(`${BASE}/api/sending/test`, { method: 'POST', headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    const body = await res.json<{ sent: boolean; dryRun: boolean; to: string }>()
    expect(body.sent).toBe(false)
    expect(body.dryRun).toBe(true)
    expect(body.to).toBe(OWNER_A.email)
    // No message row was created — it never touches the queue.
    expect(await countRows('email_messages')).toBe(0)
    expect(await countRows('activities', "kind = 'test_email_dry_run'")).toBe(1)
  })

  it('refuses to test while sending is paused', async () => {
    await createOwners()
    const cookie = await loginCookie(OWNER_A.email, OWNER_A.password)
    await SELF.fetch(`${BASE}/api/sending/pause`, { method: 'POST', headers: { Cookie: cookie } })
    const res = await SELF.fetch(`${BASE}/api/sending/test`, { method: 'POST', headers: { Cookie: cookie } })
    expect(res.status).toBe(409)
  })
})

describe('go-live readiness (Flip Gate)', () => {
  it('reports blockers when keys/connections are missing and is auth-gated', async () => {
    await createOwners()
    const anon = await SELF.fetch(`${BASE}/api/readiness`)
    expect(anon.status).toBe(401)

    const cookie = await loginCookie(OWNER_A.email, OWNER_A.password)
    const body = await (await SELF.fetch(`${BASE}/api/readiness`, { headers: { Cookie: cookie } })).json<{
      dryRun: boolean; ready: boolean; blockers: string[]
      gates: Array<{ key: string; ok: boolean; required: boolean }>
    }>()
    expect(body.dryRun).toBe(true)
    expect(body.ready).toBe(false)
    // With no keys and no Gmail, the required gates are blockers.
    expect(body.blockers).toContain('openrouter')
    expect(body.blockers).toContain('ownersConnected')
    expect(body.gates.find((g) => g.key === 'notPaused')?.ok).toBe(true)
  })
})

describe('audit feed', () => {
  it('returns high-signal events and is auth-gated', async () => {
    await createOwners()
    const cookie = await loginCookie(OWNER_A.email, OWNER_A.password)
    await SELF.fetch(`${BASE}/api/sending/pause`, { method: 'POST', headers: { Cookie: cookie } })
    const body = await (await SELF.fetch(`${BASE}/api/audit`, { headers: { Cookie: cookie } })).json<{
      events: Array<{ kind: string }>
    }>()
    expect(body.events.some((e) => e.kind === 'sending_paused')).toBe(true)
  })
})
