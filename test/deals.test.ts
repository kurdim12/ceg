import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { resetDemoData } from '../src/demo/seed'
import { createOwners, loginCookie, OWNER_A } from './helpers'

const BASE = 'http://engine.local'

describe('GET /api/deals (read-only board feed)', () => {
  it('is auth-gated', async () => {
    const res = await SELF.fetch(BASE + '/api/deals')
    expect(res.status).toBe(401)
  })

  it('returns an empty list when no deals exist', async () => {
    await createOwners()
    const cookie = await loginCookie(OWNER_A.email, OWNER_A.password)
    const res = await SELF.fetch(BASE + '/api/deals', { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    const body = await res.json<{ deals: unknown[] }>()
    expect(body.deals).toEqual([])
  })

  it('returns deal rows with amount, stage, assignee, and entered-stage date', async () => {
    const [a, b] = await createOwners()
    await resetDemoData(env.DB, [a, b], 'test')
    const cookie = await loginCookie(OWNER_A.email, OWNER_A.password)
    const res = await SELF.fetch(BASE + '/api/deals', { headers: { Cookie: cookie } })
    const body = await res.json<{
      deals: Array<{
        companyName: string
        amountUsdCents: number | null
        stage: string
        assigneeName: string | null
        enteredStageAt: string
      }>
    }>()
    // Demo data seeds exactly one deal-stage, one won, one lost company with deals.
    expect(body.deals).toHaveLength(3)
    const stages = body.deals.map((d) => d.stage).sort()
    expect(stages).toEqual(['deal', 'lost', 'won'])
    const open = body.deals.find((d) => d.stage === 'deal')!
    expect(open.companyName).toContain('Atlas')
    expect(open.amountUsdCents).toBe(450_000)
    expect(open.assigneeName).not.toBeNull()
    expect(typeof open.enteredStageAt).toBe('string')
  })
})
