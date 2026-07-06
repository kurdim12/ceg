import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { resetDemoData } from '../src/demo/seed'
import { createOwners, loginCookie, OWNER_A } from './helpers'

const BASE = 'http://engine.local'

describe('GET /api/companies/:id/detail (record drawer feed)', () => {
  it('is auth-gated', async () => {
    const res = await SELF.fetch(BASE + '/api/companies/1/detail')
    expect(res.status).toBe(401)
  })

  it('404s for a missing company', async () => {
    await createOwners()
    const cookie = await loginCookie(OWNER_A.email, OWNER_A.password)
    const res = await SELF.fetch(BASE + '/api/companies/99999/detail', { headers: { Cookie: cookie } })
    expect(res.status).toBe(404)
  })

  it('returns company, contacts, thread, and deal for a real company', async () => {
    const [a, b] = await createOwners()
    await resetDemoData(env.DB, [a, b], 'test')
    const cookie = await loginCookie(OWNER_A.email, OWNER_A.password)
    // Atlas Trading is the seeded deal-stage company with a contact.
    const row = await env.DB.prepare("SELECT id FROM companies WHERE name LIKE '%Atlas%'").first<{ id: number }>()
    const res = await SELF.fetch(BASE + `/api/companies/${row!.id}/detail`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    const body = await res.json<{
      company: { name: string; stage: string; businessType: string | null }
      contacts: Array<{ email: string | null }>
      thread: unknown[]
      deal: { amountUsdCents: number } | null
    }>()
    expect(body.company.name).toContain('Atlas')
    expect(body.company.stage).toBe('deal')
    expect(body.contacts.length).toBeGreaterThan(0)
    expect(body.deal?.amountUsdCents).toBe(450_000)
  })
})
