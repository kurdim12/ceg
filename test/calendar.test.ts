import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createOwners, createCompany, loginCookie, OWNER_A } from './helpers'

const BASE = 'http://engine.local'

describe('calendar meetings feed', () => {
  it('GET /api/meetings is auth-gated', async () => {
    expect((await SELF.fetch(`${BASE}/api/meetings`)).status).toBe(401)
  })

  it('returns booked meetings with company, contact, and time', async () => {
    await createOwners()
    const companyId = await createCompany({ stage: 'meeting_booked' })
    const contact = await env.DB.prepare(
      "INSERT INTO contacts (company_id, name, email) VALUES (?, 'Dana Weiss', 'dana@x.z') RETURNING id",
    ).bind(companyId).first<{ id: number }>()
    await env.DB.prepare(
      "INSERT INTO meetings (company_id, contact_id, scheduled_at, source) VALUES (?, ?, '2026-08-01 15:00:00', 'manual')",
    ).bind(companyId, contact!.id).run()

    const cookie = await loginCookie(OWNER_A.email, OWNER_A.password)
    const res = await SELF.fetch(`${BASE}/api/meetings`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    const body = await res.json<{
      meetings: Array<{ companyName: string; contactName: string; scheduledAt: string; stage: string }>
    }>()
    const m = body.meetings.find((x) => x.scheduledAt === '2026-08-01 15:00:00')
    expect(m).toBeTruthy()
    expect(m!.companyName).toBe('Test Co')
    expect(m!.contactName).toBe('Dana Weiss')
    expect(m!.stage).toBe('meeting_booked')
  })
})
